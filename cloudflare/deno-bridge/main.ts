// @ts-nocheck — Web Crypto signatures are stricter in TS 6 generics; runtime is fine.
// Deno Deploy — Reddit proxy + background monitor with Web Push.
// One service replaces both CF Workers (reddit-proxy + fixtral-monitor).
// Deno egress IPs aren't (yet) on Reddit's CF blocklist.

const kv = await Deno.openKv();

const KEY_ENABLED = ["monitor", "enabled"];
const KEY_SEEN_IDS = ["monitor", "seenIds"];
const KEY_PUSH_SUBS = ["monitor", "pushSubs"];

const SUBREDDITS = [
  "PhotoshopRequest",
  "PhotoshopRequests",
  "restoration",
  "editmyphoto",
];

const PROXY_SECRET =
  Deno.env.get("PROXY_SECRET") ??
  Deno.env.get("CLOUDFLARE_PROXY_SECRET") ??
  "";
const VAPID_PUBLIC_KEY =
  Deno.env.get("VAPID_PUBLIC_KEY") ??
  Deno.env.get("NEXT_PUBLIC_VAPID_PUBLIC_KEY") ??
  "";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY") ?? "";
const VAPID_SUBJECT =
  Deno.env.get("VAPID_SUBJECT") ?? "mailto:admin@example.com";

const REDDIT_HOSTS = new Set([
  "www.reddit.com",
  "old.reddit.com",
  "oauth.reddit.com",
]);

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Proxy-Secret",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

// ───────────────────────────── Reddit fetching ──────────────────────────────
// Reddit's anti-bot now serves 403 HTML to /new.json from most cloud IPs.
// RSS (old.reddit.com/.../.rss) and HTML (old.reddit.com/.../new/) still work,
// so we fall back to RSS+HTML scraping and rebuild a Listing-shaped response.

const JSON_HEADERS = {
  "User-Agent": BROWSER_UA,
  Accept:
    "application/json,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const RSS_HEADERS = {
  "User-Agent": BROWSER_UA,
  Accept: "application/atom+xml,application/xml,text/xml,*/*",
  "Accept-Language": "en-US,en;q=0.9",
};

const HTML_HEADERS = {
  "User-Agent": BROWSER_UA,
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Cookie: "over18=1; _options=%7B%22pref_quarantine_optin%22%3A%20true%7D",
};

function decodeEntities(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#032;|&#32;/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'");
}

function stripHtml(rawContent: string) {
  let html = decodeEntities(rawContent)
    .replace(/<!--\s*SC_OFF\s*-->/gi, "")
    .replace(/<!--\s*SC_ON\s*-->/gi, "");
  const submittedIdx = html.search(/submitted\s+by/i);
  if (submittedIdx > 0) html = html.slice(0, submittedIdx);
  html = html.replace(/<\/p>/gi, "\n").replace(/<br\s*\/?>/gi, "\n");
  html = html.replace(/<[^>]+>/g, "");
  return decodeEntities(html).replace(/\n{3,}/g, "\n\n").trim();
}

function tagOf(block: string, name: string) {
  const m = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i").exec(
    block,
  );
  return decodeEntities(m?.[1]?.trim() || "");
}

function attrOf(block: string, tagName: string, attrName: string) {
  const m = new RegExp(
    `<${tagName}[^>]*${attrName}="([^"]+)"[^>]*>`,
    "i",
  ).exec(block);
  return decodeEntities(m?.[1] || "");
}

function parseSubredditRss(xml: string, fallbackSubreddit: string) {
  const children: any[] = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;
  while ((match = entryRe.exec(xml)) !== null) {
    const block = match[1];
    const id = tagOf(block, "id").replace(/^t3_/, "");
    const title = tagOf(block, "title");
    const authorBlock =
      /<author[^>]*>([\s\S]*?)<\/author>/i.exec(block)?.[1] || "";
    const author = tagOf(authorBlock, "name").replace(/^\/?u\//i, "") || "unknown";
    const subreddit = attrOf(block, "category", "term") || fallbackSubreddit;
    const permalink = attrOf(block, "link", "href");
    const rawContent = tagOf(block, "content");
    const contentHtml = decodeEntities(rawContent);
    const published = tagOf(block, "published") || tagOf(block, "updated");
    const thumbnail = attrOf(block, "media:thumbnail", "url");
    const hrefs = Array.from(contentHtml.matchAll(/href="([^"]+)"/gi)).map(
      (x) => decodeEntities(x[1]),
    );
    const directImage = hrefs.find((href) =>
      /(?:i|preview)\.redd\.it|i\.imgur\.com/i.test(href),
    );
    const url = directImage || thumbnail || "";

    if (!id || !title || !permalink) continue;

    const data: any = {
      id,
      title,
      selftext: stripHtml(rawContent) || title,
      url,
      author,
      created_utc: published
        ? Math.floor(new Date(published).getTime() / 1000)
        : Math.floor(Date.now() / 1000),
      permalink: new URL(permalink).pathname,
      score: 0,
      num_comments: 0,
      subreddit,
      thumbnail,
      upvote_ratio: null,
      link_flair_text: null,
    };

    if (url) {
      data.preview = { images: [{ source: { url } }] };
    }
    children.push({ kind: "t3", data });
  }
  return children;
}

interface GalleryItem {
  media_id: string;
  ext: string;
  width: number | null;
  height: number | null;
}

interface HtmlPostEnrichment {
  score: number;
  num_comments: number;
  link_flair_text: string | null;
  is_gallery: boolean;
  over_18: boolean;
  url: string | null;
  thumbnail: string | null;
  author: string | null;
  gallery: GalleryItem[] | null;
}

function parseThingAttr(block: string, name: string): string | null {
  const m = new RegExp(`\\sdata-${name}="([^"]*)"`, "i").exec(block);
  return m ? m[1] : null;
}

function parseGalleryFromCachedHtml(block: string): GalleryItem[] | null {
  const cachedMatch = /data-cachedhtml="((?:[^"\\]|\\.)*)"/i.exec(block);
  if (!cachedMatch) return null;
  const escaped = cachedMatch[1];
  if (!/gallery-tiles/i.test(escaped)) return null;
  const unescaped = escaped
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
  const idsMatch = /data-media-ids="([^"]+)"/i.exec(unescaped);
  if (!idsMatch) return null;
  const mediaIds = idsMatch[1].split(",").map((s) => s.trim()).filter(Boolean);
  const items: GalleryItem[] = [];
  for (const mediaId of mediaIds) {
    const linkRe = new RegExp(
      `gallery-item-thumbnail-link[^>]+href="https?:\\/\\/[^"]*?\\/${mediaId}\\.([a-z]+)\\?([^"]+)"`,
      "i",
    );
    const linkMatch = linkRe.exec(unescaped);
    let ext = "jpg";
    let width: number | null = null;
    let height: number | null = null;
    if (linkMatch) {
      ext = linkMatch[1].toLowerCase();
      const params = linkMatch[2];
      const wm = /width=(\d+)/.exec(params);
      if (wm) width = parseInt(wm[1], 10);
    }
    const imgRe = new RegExp(
      `<img[^>]+src="https?:\\/\\/[^"]*?\\/${mediaId}\\.[a-z]+[^"]*"[^>]+width="(\\d+)"[^>]+height="(\\d+)"`,
      "i",
    );
    const imgMatch = imgRe.exec(unescaped);
    if (imgMatch && width !== null) {
      const w2 = parseInt(imgMatch[1], 10);
      const h2 = parseInt(imgMatch[2], 10);
      if (w2 > 0) height = Math.round((h2 * width) / w2);
    }
    items.push({ media_id: mediaId, ext, width, height });
  }
  return items.length > 0 ? items : null;
}

function parseSubredditHtml(html: string): Map<string, HtmlPostEnrichment> {
  const enrichments = new Map<string, HtmlPostEnrichment>();
  const thingRe =
    /<div[^>]+id="thing_t3_([a-z0-9]+)"[^>]*>([\s\S]{0,20000}?)(?=<div[^>]+id="thing_t3_|<!-- END LISTING -->|<\/div>\s*<div[^>]+class="footer)/gi;
  let match: RegExpExecArray | null;
  while ((match = thingRe.exec(html)) !== null) {
    const id = match[1];
    const opening = match[0].slice(0, 1500);
    const body = match[2];

    const score = parseInt(parseThingAttr(opening, "score") || "0", 10);
    const num_comments = parseInt(
      parseThingAttr(opening, "comments-count") || "0",
      10,
    );
    const author = parseThingAttr(opening, "author");
    const url = parseThingAttr(opening, "url");
    const is_gallery = parseThingAttr(opening, "is-gallery") === "true";
    const over_18 = parseThingAttr(opening, "nsfw") === "true";

    const flairMatch =
      /<span[^>]+class="[^"]*linkflairlabel[^"]*"[^>]*title="([^"]*)"/i.exec(
        body,
      );
    const link_flair_text = flairMatch ? decodeEntities(flairMatch[1]) : null;

    const thumbMatch =
      /<a[^>]+class="[^"]*thumbnail[^"]*"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"/i.exec(
        body,
      );
    let thumbnail = thumbMatch ? thumbMatch[1] : null;
    if (thumbnail && thumbnail.startsWith("//")) thumbnail = `https:${thumbnail}`;

    const gallery = is_gallery ? parseGalleryFromCachedHtml(body) : null;

    enrichments.set(id, {
      score,
      num_comments,
      link_flair_text,
      is_gallery,
      over_18,
      url: url || null,
      thumbnail,
      author,
      gallery,
    });
  }
  return enrichments;
}

async function fetchSubredditHtml(
  sub: string,
  limit: string,
): Promise<Map<string, HtmlPostEnrichment>> {
  try {
    const htmlUrl = `https://old.reddit.com/r/${sub}/new/?limit=${encodeURIComponent(
      limit,
    )}`;
    const res = await fetch(htmlUrl, { headers: HTML_HEADERS });
    if (!res.ok) return new Map();
    return parseSubredditHtml(await res.text());
  } catch {
    return new Map();
  }
}

async function fetchSubAsListing(sub: string, limit: string) {
  const rssUrl = `https://old.reddit.com/r/${sub}/new/.rss?limit=${encodeURIComponent(
    limit,
  )}`;
  const [rssText, htmlEnrichments] = await Promise.all([
    fetch(rssUrl, { headers: RSS_HEADERS }).then(async (res) => {
      if (res.ok) return res.text();
      const fb = await fetch(
        `https://www.reddit.com/r/${sub}/new/.rss?limit=${encodeURIComponent(limit)}`,
        { headers: RSS_HEADERS },
      );
      return fb.ok ? fb.text() : "";
    }),
    fetchSubredditHtml(sub, limit),
  ]);

  if (!rssText) return [];
  const children = parseSubredditRss(rssText, sub);

  for (const child of children) {
    const e = htmlEnrichments.get(child.data.id);
    if (!e) continue;
    child.data.score = e.score;
    child.data.num_comments = e.num_comments;
    child.data.link_flair_text = e.link_flair_text;
    if (e.over_18) child.data.over_18 = true;
    if (e.is_gallery) child.data.is_gallery = true;
    if (e.thumbnail) child.data.thumbnail = e.thumbnail;
    if (e.author && child.data.author === "unknown") child.data.author = e.author;

    if (e.is_gallery && e.gallery && e.gallery.length > 0) {
      const media_metadata: Record<string, any> = {};
      for (const item of e.gallery) {
        const ext =
          item.ext === "png" ? "png" : item.ext === "gif" ? "gif" : "jpg";
        const mime =
          ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : "image/jpg";
        media_metadata[item.media_id] = {
          status: "valid",
          e: "Image",
          m: mime,
          s: {
            u: `https://i.redd.it/${item.media_id}.${ext}`,
            x: item.width || 0,
            y: item.height || 0,
          },
        };
      }
      child.data.media_metadata = media_metadata;
      child.data.gallery_data = {
        items: e.gallery.map((item, idx) => ({
          media_id: item.media_id,
          id: idx + 1,
        })),
      };
      const first = e.gallery[0];
      const firstExt =
        first.ext === "png" ? "png" : first.ext === "gif" ? "gif" : "jpg";
      const firstUrl = `https://i.redd.it/${first.media_id}.${firstExt}`;
      child.data.url = firstUrl;
      child.data.preview = {
        images: [
          {
            source: {
              url: firstUrl,
              width: first.width || 0,
              height: first.height || 0,
            },
          },
        ],
      };
    }
  }
  return children;
}

function parseSubredditsFromJsonUrl(target: URL) {
  const m = /^\/r\/([^/]+)\/new(?:\.json)?\/?$/.exec(target.pathname);
  if (!m) return [];
  return m[1].split("+").filter(Boolean);
}

// Primary fetch path: try JSON; if it returns the anti-bot block page (HTML),
// fall back to RSS+HTML scraping. Returns a Reddit-shaped Listing response.
async function proxyReddit(target: URL): Promise<Response> {
  const upstream = await fetch(target.toString(), {
    headers: JSON_HEADERS,
    redirect: "follow",
  });
  const contentType = upstream.headers.get("content-type") || "";
  if (upstream.ok && contentType.includes("application/json")) {
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": "application/json",
        ...corsHeaders,
      },
    });
  }

  // Fallback for /r/<...>/new.json
  if (target.pathname.includes("/new.json") || target.pathname.endsWith("/new")) {
    const subs = parseSubredditsFromJsonUrl(target);
    if (subs.length > 0) {
      const limit = target.searchParams.get("limit") || "50";
      const perSub = await Promise.all(
        subs.map((s) => fetchSubAsListing(s, limit)),
      );
      const listing = {
        kind: "Listing",
        data: {
          after: null,
          before: null,
          children: perSub
            .flat()
            .sort((a, b) => b.data.created_utc - a.data.created_utc),
        },
      };
      return new Response(JSON.stringify(listing), {
        status: 200,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }
  }

  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: {
      "Content-Type": contentType || "text/plain",
      ...corsHeaders,
    },
  });
}

// Monitor uses the same fallback path
async function fetchSubPosts(sub: string): Promise<any[]> {
  try {
    const children = await fetchSubAsListing(sub, "25");
    return children.map((c: any) => c.data);
  } catch (err) {
    console.error(`fetchSubPosts error for r/${sub}:`, err);
    return [];
  }
}

// ───────────────────────────── KV helpers ───────────────────────────────────

async function kvGetJSON<T>(key: Deno.KvKey, fallback: T): Promise<T> {
  const res = await kv.get<T>(key);
  return (res.value ?? fallback) as T;
}

async function getEnabled(): Promise<boolean> {
  return await kvGetJSON<boolean>(KEY_ENABLED, false);
}

async function getSeenIds(): Promise<Set<string>> {
  const arr = await kvGetJSON<string[]>(KEY_SEEN_IDS, []);
  return new Set(arr);
}

async function saveSeenIds(ids: Set<string>) {
  const arr = [...ids].slice(-500);
  await kv.set(KEY_SEEN_IDS, arr);
}

async function getPushSubscriptions(): Promise<any[]> {
  return await kvGetJSON<any[]>(KEY_PUSH_SUBS, []);
}

async function setPushSubscriptions(subs: any[]) {
  await kv.set(KEY_PUSH_SUBS, subs);
}

// ───────────────────────────── Monitor (cron) ───────────────────────────────

async function checkReddit() {
  try {
    const perSub = await Promise.all(SUBREDDITS.map((s) => fetchSubPosts(s)));
    const posts = perSub.flat();

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

    const seenIds = await getSeenIds();
    const isFirstRun = seenIds.size === 0;
    const newPosts = imagePosts.filter((p: any) => !seenIds.has(p.id));

    if (newPosts.length > 0 || isFirstRun) {
      for (const p of imagePosts) seenIds.add(p.id);
      await saveSeenIds(seenIds);
    }

    if (isFirstRun || newPosts.length === 0) {
      if (isFirstRun) {
        console.log(`First run: marked ${imagePosts.length} posts as seen`);
      }
      return;
    }

    const subs = await getPushSubscriptions();
    if (subs.length === 0) return;

    const subreddits = [...new Set(newPosts.map((p: any) => p.subreddit))];
    const body = subreddits
      .map((s) => {
        const count = newPosts.filter((p: any) => p.subreddit === s).length;
        return `${count} in r/${s}`;
      })
      .join(", ");

    await sendPushToAll(subs, {
      title: `🖌️ ${newPosts.length} new request${
        newPosts.length > 1 ? "s" : ""
      }`,
      body,
      tag: "fixtral-new",
      url: "/app",
      postId: newPosts[0]?.id,
    });

    console.log(`Notified: ${newPosts.length} new posts (${body})`);
  } catch (err) {
    console.error("checkReddit error:", err);
  }
}

// ───────────────────────────── HTTP handler ─────────────────────────────────

async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  // ── Reddit proxy ──
  // Called by Next.js `/api/reddit/posts` route. Same wire format as old CF proxy:
  //   GET /?url=<encoded-reddit-url>  with header X-Proxy-Secret
  if (url.pathname === "/" && url.searchParams.has("url")) {
    if (PROXY_SECRET) {
      const provided = request.headers.get("X-Proxy-Secret") ?? "";
      if (provided !== PROXY_SECRET) return json({ error: "Unauthorized" }, 401);
    }

    const targetRaw = url.searchParams.get("url")!;
    let target: URL;
    try {
      target = new URL(targetRaw);
    } catch {
      return json({ error: "Invalid url parameter" }, 400);
    }
    if (!REDDIT_HOSTS.has(target.hostname)) {
      return json({ error: `Host not allowed: ${target.hostname}` }, 403);
    }

    return proxyReddit(target);
  }

  // ── Status ──
  if (url.pathname === "/status" && request.method === "GET") {
    const enabled = await getEnabled();
    const subs = await getPushSubscriptions();
    return json({ enabled, subscriptionCount: subs.length });
  }

  // ── Toggle ──
  if (url.pathname === "/toggle" && request.method === "POST") {
    const body = (await request.json()) as any;
    const enable = !!body.enabled;
    await kv.set(KEY_ENABLED, enable);
    if (enable) await kv.delete(KEY_SEEN_IDS);
    return json({ ok: true, enabled: enable });
  }

  // ── Subscribe (push) ──
  if (url.pathname === "/subscribe" && request.method === "POST") {
    const body = (await request.json()) as any;
    const sub = body.subscription;
    if (!sub?.endpoint) return json({ ok: false, error: "Invalid subscription" }, 400);

    const subs = await getPushSubscriptions();
    const existing = subs.findIndex((s: any) => s.endpoint === sub.endpoint);
    if (existing >= 0) subs[existing] = sub;
    else subs.push(sub);
    await setPushSubscriptions(subs);
    return json({ ok: true, totalSubscriptions: subs.length });
  }

  // ── Unsubscribe ──
  if (url.pathname === "/unsubscribe" && request.method === "POST") {
    const body = (await request.json()) as any;
    const endpoint = body.endpoint;
    if (!endpoint) return json({ ok: false, error: "Endpoint required" }, 400);
    let subs = await getPushSubscriptions();
    subs = subs.filter((s: any) => s.endpoint !== endpoint);
    await setPushSubscriptions(subs);
    return json({ ok: true, totalSubscriptions: subs.length });
  }

  // ── Test push ──
  if (url.pathname === "/test-push" && request.method === "POST") {
    const subs = await getPushSubscriptions();
    if (subs.length === 0) return json({ ok: false, error: "No subscriptions" }, 400);
    try {
      await sendPushToAll(subs, {
        title: "Test Push",
        body: "If you see this, push notifications work!",
        tag: "fixtral-test",
        url: "/app",
      });
      return json({ ok: true, sentTo: subs.length });
    } catch (err: any) {
      return json({ ok: false, error: err.message }, 500);
    }
  }

  // ── Debug: peek a sub via the fallback path ──
  if (url.pathname === "/debug-fetch" && request.method === "GET") {
    const sub = url.searchParams.get("sub") || "PhotoshopRequest";
    const limit = url.searchParams.get("limit") || "10";
    const children = await fetchSubAsListing(sub, limit);
    return json({
      ok: true,
      count: children.length,
      sample: children.slice(0, 3).map((c: any) => ({
        id: c.data.id,
        title: c.data.title,
        subreddit: c.data.subreddit,
        created_utc: c.data.created_utc,
        url: c.data.url,
      })),
    });
  }

  return json({ error: "Not found" }, 404);
}

// ───────────────────────────── Web Push (RFC 8291) ──────────────────────────

async function sendPushToAll(subs: any[], payload: any) {
  console.log(`Sending push to ${subs.length} subscriber(s)`);
  const results = await Promise.allSettled(
    subs.map((sub) => sendWebPush(sub, payload)),
  );
  const deadEndpoints: string[] = [];
  results.forEach((result, i) => {
    if (result.status === "rejected") {
      const reason = result.reason as any;
      console.error(`Push to sub ${i} failed:`, reason?.message || reason);
      if (reason?.statusCode === 404 || reason?.statusCode === 410) {
        deadEndpoints.push(subs[i].endpoint);
      }
    }
  });
  if (deadEndpoints.length > 0) {
    let allSubs = await getPushSubscriptions();
    allSubs = allSubs.filter((s: any) => !deadEndpoints.includes(s.endpoint));
    await setPushSubscriptions(allSubs);
  }
}

async function sendWebPush(sub: any, payload: any) {
  const vapidHeaders = await createVapidHeaders(
    sub.endpoint,
    VAPID_SUBJECT,
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY,
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

async function createVapidHeaders(
  endpoint: string,
  subject: string,
  publicKey: string,
  privateKey: string,
) {
  const audience = new URL(endpoint).origin;
  const exp = Math.floor(Date.now() / 1000) + 12 * 60 * 60;

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
  return { Authorization: `vapid t=${jwt}, k=${publicKey}` };
}

async function importVapidKey(privateKeyB64: string, publicKeyB64: string) {
  const privateRaw = base64urlDecode(privateKeyB64);
  const publicRaw = base64urlDecode(publicKeyB64);
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

async function encryptPayload(
  payload: Uint8Array,
  p256dhB64: string,
  authB64: string,
): Promise<ArrayBuffer> {
  const clientPublicKey = base64urlDecode(p256dhB64);
  const authSecret = base64urlDecode(authB64);

  const localKeyPair = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;

  const localPublicBytes = new Uint8Array(
    await crypto.subtle.exportKey("raw", localKeyPair.publicKey),
  );

  const clientKey = await crypto.subtle.importKey(
    "raw",
    clientPublicKey,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );

  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: clientKey },
      localKeyPair.privateKey,
      256,
    ),
  );

  const ikmInfo = concatBytes(
    new TextEncoder().encode("WebPush: info\0"),
    clientPublicKey,
    localPublicBytes,
  );
  const ikm = await hkdfDerive(authSecret, sharedSecret, ikmInfo, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
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

  const paddedPayload = concatBytes(payload, new Uint8Array([2]));

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

  const recordSize = new ArrayBuffer(4);
  new DataView(recordSize).setUint32(0, paddedPayload.length + 16);

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
  const extractKey = await crypto.subtle.importKey(
    "raw",
    salt,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const prk = new Uint8Array(await crypto.subtle.sign("HMAC", extractKey, ikm));

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
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str: string): Uint8Array {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const binary = atob(str);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ───────────────────────────── Entry points ─────────────────────────────────

Deno.cron("reddit-monitor", "* * * * *", async () => {
  if (!(await getEnabled())) return;
  await checkReddit();
});

Deno.serve(handler);
