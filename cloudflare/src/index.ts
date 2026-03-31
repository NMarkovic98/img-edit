// Cloudflare Worker — background Reddit monitor with Web Push
// Runs every minute via cron. Only active when monitoring is enabled via KV flag.

export interface Env {
  KV: KVNamespace;
  REDDIT_PROXY_URL: string;
  PROXY_SECRET: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
}

// KV keys
const KEY_ENABLED = "monitor:enabled";
const KEY_SEEN_IDS = "monitor:seenIds";
const KEY_PUSH_SUBS = "monitor:pushSubscriptions";

const SUBREDDITS = [
  "PhotoshopRequest",
  "PhotoshopRequests",
  "restoration",
  "editmyphoto",
];

export default {
  // Cron trigger — runs every minute, checks twice (at 0s and 30s) for ~30s polling
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const enabled = await env.KV.get(KEY_ENABLED);
    if (enabled !== "true") return;

    // First check immediately
    await checkReddit(env);

    // Second check after 30 seconds
    ctx.waitUntil(
      new Promise<void>((resolve) =>
        setTimeout(async () => {
          await checkReddit(env);
          resolve();
        }, 30000),
      ),
    );
  },

  // HTTP handler — for toggling monitor + managing push subscriptions
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // GET /status — check if monitoring is enabled
    if (url.pathname === "/status" && request.method === "GET") {
      const enabled = (await env.KV.get(KEY_ENABLED)) === "true";
      const subs = await getPushSubscriptions(env);
      return json({ enabled, subscriptionCount: subs.length }, corsHeaders);
    }

    // POST /toggle — enable/disable monitoring
    if (url.pathname === "/toggle" && request.method === "POST") {
      const body = (await request.json()) as any;
      const enable = !!body.enabled;
      await env.KV.put(KEY_ENABLED, String(enable));

      // If enabling, clear seen IDs so first run doesn't flood
      if (enable) {
        await env.KV.delete(KEY_SEEN_IDS);
      }

      return json({ ok: true, enabled: enable }, corsHeaders);
    }

    // POST /subscribe — register push subscription
    if (url.pathname === "/subscribe" && request.method === "POST") {
      const body = (await request.json()) as any;
      const sub = body.subscription;
      if (!sub?.endpoint) {
        return json(
          { ok: false, error: "Invalid subscription" },
          corsHeaders,
          400,
        );
      }

      const subs = await getPushSubscriptions(env);
      // Deduplicate by endpoint
      const existing = subs.findIndex((s: any) => s.endpoint === sub.endpoint);
      if (existing >= 0) {
        subs[existing] = sub;
      } else {
        subs.push(sub);
      }
      await env.KV.put(KEY_PUSH_SUBS, JSON.stringify(subs));

      return json({ ok: true, totalSubscriptions: subs.length }, corsHeaders);
    }

    // POST /unsubscribe — remove push subscription
    if (url.pathname === "/unsubscribe" && request.method === "POST") {
      const body = (await request.json()) as any;
      const endpoint = body.endpoint;
      if (!endpoint) {
        return json(
          { ok: false, error: "Endpoint required" },
          corsHeaders,
          400,
        );
      }

      let subs = await getPushSubscriptions(env);
      subs = subs.filter((s: any) => s.endpoint !== endpoint);
      await env.KV.put(KEY_PUSH_SUBS, JSON.stringify(subs));

      return json({ ok: true, totalSubscriptions: subs.length }, corsHeaders);
    }

    // POST /test-push — send a test push notification to debug
    if (url.pathname === "/test-push" && request.method === "POST") {
      const subs = await getPushSubscriptions(env);
      if (subs.length === 0) {
        return json(
          { ok: false, error: "No subscriptions" },
          corsHeaders,
          400,
        );
      }
      try {
        await sendPushToAll(subs, env, {
          title: "Test Push",
          body: "If you see this, push notifications work!",
          tag: "fixtral-test",
          url: "/app",
        });
        return json({ ok: true, sentTo: subs.length }, corsHeaders);
      } catch (err: any) {
        return json(
          { ok: false, error: err.message },
          corsHeaders,
          500,
        );
      }
    }

    return json({ error: "Not found" }, corsHeaders, 404);
  },
};

function json(data: any, corsHeaders: Record<string, string>, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

async function getPushSubscriptions(env: Env): Promise<any[]> {
  try {
    const raw = await env.KV.get(KEY_PUSH_SUBS);
    if (raw) return JSON.parse(raw);
  } catch {}
  return [];
}

async function getSeenIds(env: Env): Promise<Set<string>> {
  try {
    const raw = await env.KV.get(KEY_SEEN_IDS);
    if (raw) return new Set(JSON.parse(raw));
  } catch {}
  return new Set();
}

async function saveSeenIds(env: Env, ids: Set<string>) {
  // Keep last 500 IDs max
  const arr = [...ids].slice(-500);
  await env.KV.put(KEY_SEEN_IDS, JSON.stringify(arr));
}

async function checkReddit(env: Env) {
  try {
    const multiSub = SUBREDDITS.join("+");
    const redditUrl = `https://www.reddit.com/r/${multiSub}/new.json?limit=50&raw_json=1`;

    // Fetch Reddit directly (no proxy needed — CF Workers aren't IP-blocked like Vercel)
    const res = await fetch(redditUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
      },
    });

    if (!res.ok) {
      const body = await res.text();
      console.error(`Reddit fetch failed: ${res.status} — ${body.substring(0, 200)}`);
      return;
    }

    const data = (await res.json()) as any;
    const posts = (data.data?.children || []).map((c: any) => c.data);

    // Filter to image posts from last 2 hours
    const twoHoursAgo = Date.now() / 1000 - 2 * 60 * 60;
    const imagePosts = posts.filter((p: any) => {
      const hasImage =
        (p.url &&
          (p.url.match(/\.(jpg|jpeg|png|gif|webp)$/i) ||
            p.url.includes("i.redd.it") ||
            p.url.includes("i.imgur.com"))) ||
        p.preview?.images?.length > 0 ||
        (p.is_gallery && p.media_metadata);
      return hasImage && p.created_utc > twoHoursAgo;
    });

    const seenIds = await getSeenIds(env);
    const isFirstRun = seenIds.size === 0;

    // Find new posts
    const newPosts = imagePosts.filter((p: any) => !seenIds.has(p.id));

    // Only write to KV if there are actually new IDs to save (KV writes are limited to 1,000/day on free tier)
    if (newPosts.length > 0 || isFirstRun) {
      for (const p of imagePosts) {
        seenIds.add(p.id);
      }
      await saveSeenIds(env, seenIds);
    }

    // On first run, just save IDs without notifying
    if (isFirstRun || newPosts.length === 0) {
      if (isFirstRun)
        console.log(`First run: marked ${imagePosts.length} posts as seen`);
      return;
    }

    // Separate paid and free
    const paidPosts = newPosts.filter((p: any) => {
      const flair = (p.link_flair_text || "").toLowerCase();
      return flair.includes("paid") || p.title.toLowerCase().includes("[paid]");
    });
    const freePosts = newPosts.filter((p: any) => {
      const flair = (p.link_flair_text || "").toLowerCase();
      return !(
        flair.includes("paid") || p.title.toLowerCase().includes("[paid]")
      );
    });

    const subs = await getPushSubscriptions(env);
    if (subs.length === 0) return;

    // Send push notifications
    if (paidPosts.length > 0) {
      const subreddits = [...new Set(paidPosts.map((p: any) => p.subreddit))];
      const body = subreddits
        .map((s) => {
          const count = paidPosts.filter((p: any) => p.subreddit === s).length;
          return `${count} in r/${s}`;
        })
        .join(", ");

      await sendPushToAll(subs, env, {
        title: `💰 PAID: ${paidPosts.length} new request${paidPosts.length > 1 ? "s" : ""}`,
        body,
        tag: "fixtral-paid",
        url: "/app",
        postId: paidPosts[0]?.id,
      });
    }

    if (freePosts.length > 0) {
      const subreddits = [...new Set(freePosts.map((p: any) => p.subreddit))];
      const body = subreddits
        .map((s) => {
          const count = freePosts.filter((p: any) => p.subreddit === s).length;
          return `${count} in r/${s}`;
        })
        .join(", ");

      await sendPushToAll(subs, env, {
        title: `${freePosts.length} new free request${freePosts.length > 1 ? "s" : ""}`,
        body,
        tag: "fixtral-free",
        url: "/app",
        postId: freePosts[0]?.id,
      });
    }

    console.log(`Notified: ${paidPosts.length} paid, ${freePosts.length} free`);
  } catch (err) {
    console.error("checkReddit error:", err);
  }
}

// ─── Web Push (RFC 8291) implementation for Cloudflare Workers ───────

async function sendPushToAll(subs: any[], env: Env, payload: any) {
  console.log(`Sending push to ${subs.length} subscriber(s):`, JSON.stringify(payload));
  const results = await Promise.allSettled(
    subs.map((sub) => sendWebPush(sub, env, payload)),
  );

  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      console.log(`Push to sub ${i} succeeded`);
    } else {
      console.error(`Push to sub ${i} failed:`, result.reason?.message || result.reason);
    }
  });

  // Remove dead subscriptions (410 Gone / 404 only — not transient errors)
  const deadEndpoints: string[] = [];
  results.forEach((result, i) => {
    if (
      result.status === "rejected" &&
      (result.reason?.statusCode === 404 || result.reason?.statusCode === 410)
    ) {
      deadEndpoints.push(subs[i].endpoint);
    }
  });

  if (deadEndpoints.length > 0) {
    let allSubs = await getPushSubscriptions(env);
    allSubs = allSubs.filter((s: any) => !deadEndpoints.includes(s.endpoint));
    await env.KV.put(KEY_PUSH_SUBS, JSON.stringify(allSubs));
  }
}

async function sendWebPush(sub: any, env: Env, payload: any) {
  const vapidHeaders = await createVapidHeaders(
    sub.endpoint,
    env.VAPID_SUBJECT,
    env.VAPID_PUBLIC_KEY,
    env.VAPID_PRIVATE_KEY,
  );

  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = await encryptPayload(
    payloadBytes,
    sub.keys.p256dh,
    sub.keys.auth,
  );

  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      ...vapidHeaders,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "high",
    },
    body: encrypted,
  });

  if (!res.ok && res.status !== 201) {
    const text = await res.text();
    const err: any = new Error(`Push failed: ${res.status} ${text}`);
    err.statusCode = res.status;
    throw err;
  }
}

// ─── VAPID JWT ──────────────────────────────────────────────────────

async function createVapidHeaders(
  endpoint: string,
  subject: string,
  publicKey: string,
  privateKey: string,
) {
  const audience = new URL(endpoint).origin;
  const exp = Math.floor(Date.now() / 1000) + 12 * 60 * 60; // 12 hours

  const header = { typ: "JWT", alg: "ES256" };
  const claims = { aud: audience, exp, sub: subject };

  const headerB64 = base64urlEncode(
    new TextEncoder().encode(JSON.stringify(header)),
  );
  const claimsB64 = base64urlEncode(
    new TextEncoder().encode(JSON.stringify(claims)),
  );
  const unsignedToken = `${headerB64}.${claimsB64}`;

  const key = await importVapidKey(privateKey, publicKey);
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(unsignedToken),
  );

  const jwt = `${unsignedToken}.${base64urlEncode(new Uint8Array(signature))}`;
  const vapidPublic = publicKey;

  return {
    Authorization: `vapid t=${jwt}, k=${vapidPublic}`,
  };
}

async function importVapidKey(privateKeyB64: string, publicKeyB64: string) {
  const privateRaw = base64urlDecode(privateKeyB64);
  const publicRaw = base64urlDecode(publicKeyB64);

  // Build JWK from raw keys
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: base64urlEncode(publicRaw.slice(1, 33)),
    y: base64urlEncode(publicRaw.slice(33, 65)),
    d: base64urlEncode(privateRaw),
  };

  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

// ─── RFC 8291 payload encryption ─────────────────────────────────────

async function encryptPayload(
  payload: Uint8Array,
  p256dhB64: string,
  authB64: string,
): Promise<ArrayBuffer> {
  const clientPublicKey = base64urlDecode(p256dhB64);
  const authSecret = base64urlDecode(authB64);

  // Generate ephemeral ECDH key pair
  const localKeyPair = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;

  const localPublicBytes = new Uint8Array(
    await crypto.subtle.exportKey("raw", localKeyPair.publicKey),
  );

  // Import client's public key
  const clientKey = await crypto.subtle.importKey(
    "raw",
    clientPublicKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );

  // ECDH shared secret
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: clientKey },
      localKeyPair.privateKey,
      256,
    ),
  );

  // HKDF — derive IKM
  const ikmInfo = concatBytes(
    new TextEncoder().encode("WebPush: info\0"),
    clientPublicKey,
    localPublicBytes,
  );
  const ikm = await hkdfDerive(authSecret, sharedSecret, ikmInfo, 32);

  // Generate salt
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // Derive content encryption key and nonce
  const cek = await hkdfDerive(
    salt,
    ikm,
    new TextEncoder().encode("Content-Encoding: aes128gcm\0"),
    16,
  );
  const nonce = await hkdfDerive(
    salt,
    ikm,
    new TextEncoder().encode("Content-Encoding: nonce\0"),
    12,
  );

  // Pad payload (add 0x02 delimiter + zero padding)
  const paddedPayload = concatBytes(payload, new Uint8Array([2]));

  // AES-128-GCM encrypt
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
    "encrypt",
  ]);
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      paddedPayload,
    ),
  );

  // Build aes128gcm header: salt(16) + rs(4) + idLen(1) + keyId(65) + ciphertext
  const recordSize = new ArrayBuffer(4);
  new DataView(recordSize).setUint32(0, paddedPayload.length + 16); // +16 for AES-GCM auth tag

  const header = concatBytes(
    salt,
    new Uint8Array(recordSize),
    new Uint8Array([localPublicBytes.length]),
    localPublicBytes,
  );

  return concatBytes(header, encrypted).buffer;
}

async function hkdfDerive(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  // HKDF-Extract: PRK = HMAC-SHA256(salt, IKM)
  const extractKey = await crypto.subtle.importKey(
    "raw",
    salt,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const prk = new Uint8Array(
    await crypto.subtle.sign("HMAC", extractKey, ikm),
  );

  // HKDF-Expand: T(1) = HMAC-SHA256(PRK, info || 0x01)
  const expandKey = await crypto.subtle.importKey(
    "raw",
    prk,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const t1 = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      expandKey,
      concatBytes(info, new Uint8Array([1])),
    ),
  );

  return t1.slice(0, length);
}

// ─── Utilities ──────────────────────────────────────────────────────

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64urlDecode(str: string): Uint8Array {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
