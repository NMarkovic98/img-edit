// Cloudflare Worker — background Reddit monitor with Web Push
// Runs every minute via cron. New-request alerts are gated by KV; solved replies stay on.

export interface Env {
  KV: KVNamespace;
  REDDIT_PROXY_URL: string;
  REDDIT_PROXY: Fetcher;
  PROXY_SECRET: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
}

// KV keys
const KEY_ENABLED = "monitor:enabled";
const KEY_SEEN_IDS = "monitor:seenIds";
const KEY_SEEN_REPLY_IDS = "monitor:seenReplyIds";
const KEY_PUSH_SUBS = "monitor:pushSubscriptions";
const KEY_USERNAME = "monitor:username";

const DEFAULT_USERNAME = "deandean91";
const INCLUDED_REPLY_SUBS = new Set(["photoshoprequest"]);

const SUBREDDITS = [
  "PhotoshopRequest",
  "PhotoshopRequests",
  "restoration",
  "editmyphoto",
];

function containsSolved(text?: string): boolean {
  return /\bsolved\b/i.test(text || "");
}

export default {
  // Cron trigger — runs every minute. New-post check runs twice (0s + 30s) only
  // when request monitoring is enabled. Solved/reply check always runs for subscribers.
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    const enabled = await env.KV.get(KEY_ENABLED);

    // Reply check is independent from new-request notifications.
    ctx.waitUntil(checkReplies(env));

    if (enabled !== "true") return;

    // First post check immediately
    await checkReddit(env);

    // Second post check after 30 seconds
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
      const username = (await env.KV.get(KEY_USERNAME)) || DEFAULT_USERNAME;
      return json(
        { enabled, subscriptionCount: subs.length, username },
        corsHeaders,
      );
    }

    // GET /username — read monitored username
    if (url.pathname === "/username" && request.method === "GET") {
      const username = (await env.KV.get(KEY_USERNAME)) || DEFAULT_USERNAME;
      return json({ ok: true, username }, corsHeaders);
    }

    // POST /username — set monitored username
    if (url.pathname === "/username" && request.method === "POST") {
      const body = (await request.json()) as any;
      const next = (body.username || "").toString().trim().replace(/^u\//, "");
      if (!next) {
        return json({ ok: false, error: "username required" }, corsHeaders, 400);
      }
      const prev = await env.KV.get(KEY_USERNAME);
      await env.KV.put(KEY_USERNAME, next);
      // If username changed, clear seen-reply cache so we re-baseline
      if (prev !== next) {
        await env.KV.delete(KEY_SEEN_REPLY_IDS);
      }
      return json({ ok: true, username: next }, corsHeaders);
    }

    // POST /test-reply-push — send a test reply-style push to debug ringing
    if (url.pathname === "/test-reply-push" && request.method === "POST") {
      const subs = await getPushSubscriptions(env);
      if (subs.length === 0) {
        return json({ ok: false, error: "No subscriptions" }, corsHeaders, 400);
      }
      try {
        await sendPushToAll(subs, env, {
          title: "💬 Test reply",
          body: "If you see this and feel three vibrations, replies work.",
          tag: `fixtral-reply-test-${Date.now()}`,
          url: "/app",
          type: "reply",
          vibrate: [400, 200, 400, 200, 400],
          requireInteraction: true,
        });
        return json({ ok: true, sentTo: subs.length }, corsHeaders);
      } catch (err: any) {
        return json({ ok: false, error: err.message }, corsHeaders, 500);
      }
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

// Route through reddit-proxy via service binding — Reddit 403s direct CF Worker egress IPs,
// and public Worker→Worker fetch on same account returns 1042.
async function redditProxyFetch(env: Env, redditUrl: string): Promise<Response> {
  const proxyHeaders: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  };
  if (env.PROXY_SECRET) proxyHeaders["X-Proxy-Secret"] = env.PROXY_SECRET;
  const proxyRequestUrl = `https://reddit-proxy/?url=${encodeURIComponent(redditUrl)}`;
  return env.REDDIT_PROXY.fetch(proxyRequestUrl, { headers: proxyHeaders });
}

async function checkReddit(env: Env) {
  try {
    const multiSub = SUBREDDITS.join("+");
    const redditUrl = `https://www.reddit.com/r/${multiSub}/new.json?limit=50&raw_json=1`;
    const res = await redditProxyFetch(env, redditUrl);

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

    const subs = await getPushSubscriptions(env);
    if (subs.length === 0) return;

    // Notify for ALL new posts
    const subreddits = [...new Set(newPosts.map((p: any) => p.subreddit))];
    const body = subreddits
      .map((s) => {
        const count = newPosts.filter((p: any) => p.subreddit === s).length;
        return `${count} in r/${s}`;
      })
      .join(", ");

    await sendPushToAll(subs, env, {
      title: `🖌️ ${newPosts.length} new request${newPosts.length > 1 ? "s" : ""}`,
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

// ─── Reply monitoring ────────────────────────────────────────────────
// Polls Reddit for u/{username}'s recent comments, then walks each commented
// post's tree to find new replies. Sends a 3-pulse push for each new reply.

const ALLOWED_SUBS_LOWER = new Set(SUBREDDITS.map((s) => s.toLowerCase()));
const REPLY_LOOKBACK_SECONDS = 48 * 60 * 60; // only care about posts user commented on in last 48h
const REPLY_MAX_POSTS = 5; // cap on post threads we fetch per cron
const REPLY_REQUEST_GAP_MS = 600;

async function getSeenReplyIds(env: Env): Promise<Set<string>> {
  try {
    const raw = await env.KV.get(KEY_SEEN_REPLY_IDS);
    if (raw) return new Set(JSON.parse(raw));
  } catch {}
  return new Set();
}

async function saveSeenReplyIds(env: Env, ids: Set<string>) {
  // Keep last 1000 IDs
  const arr = [...ids].slice(-1000);
  await env.KV.put(KEY_SEEN_REPLY_IDS, JSON.stringify(arr));
}

interface FoundReply {
  replyId: string;
  replyAuthor: string;
  replyBody: string;
  parentCommentId: string;
  postId: string;
  postTitle: string;
  subreddit: string;
  permalink: string;
  createdUtc: number;
  isSolved: boolean;
}

interface UserCommentRef {
  id: string;
  postId: string;
  subreddit: string;
  postTitle: string;
  createdUtc: number;
}

function decodeEntities(s: string): string {
  return s
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

function getTag(block: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  return decodeEntities(re.exec(block)?.[1]?.trim() || "");
}

function getLinks(block: string): string[] {
  return [...block.matchAll(/<link[^>]*href="([^"]+)"/gi)].map((m) =>
    decodeEntities(m[1]),
  );
}

function extractRssBody(rawContent: string): string {
  let html = decodeEntities(rawContent)
    .replace(/^<!\[CDATA\[/, "")
    .replace(/\]\]>$/, "")
    .replace(/<!--\s*SC_OFF\s*-->/gi, "")
    .replace(/<!--\s*SC_ON\s*-->/gi, "");

  const submittedIdx = html.search(/submitted\s+by/i);
  if (submittedIdx > 0) html = html.slice(0, submittedIdx);

  html = html.replace(/<\/p>/gi, "\n").replace(/<br\s*\/?>/gi, "\n");
  html = html.replace(/<[^>]+>/g, "");
  return decodeEntities(html).replace(/\n{3,}/g, "\n\n").trim();
}

function getRssCommentId(block: string): string {
  return getTag(block, "id").replace(/^t1_/, "");
}

function getRssAuthor(block: string): string {
  const authorBlock = /<author[^>]*>([\s\S]*?)<\/author>/i.exec(block)?.[1] || "";
  return getTag(authorBlock, "name").replace(/^\/?u\//i, "");
}

function getRssCreatedUtc(block: string): number {
  const raw = getTag(block, "published") || getTag(block, "updated");
  return raw ? Math.floor(new Date(raw).getTime() / 1000) : 0;
}

function extractRssPostId(url: string): string {
  return /\/comments\/([A-Za-z0-9]+)\//.exec(url)?.[1] || "";
}

function extractRssSubreddit(block: string, links: string[]): string {
  const category = /<category[^>]*term="([^"]+)"/i.exec(block)?.[1];
  if (category) return decodeEntities(category);
  const link = links.find((l) => /\/r\/[^/]+\/comments\//i.test(l));
  return /\/r\/([^/]+)\//i.exec(link || "")?.[1] || "";
}

function extractRssPostTitle(block: string): string {
  const title = getTag(block, "title");
  const prefixed = /^\/?u\/[^ ]+\s+(?:comments?\s+)?on\s+([\s\S]+)$/i.exec(title);
  if (prefixed) return prefixed[1].trim();
  const plain = /comments?\s+on\s+([\s\S]+)$/i.exec(title);
  return plain ? plain[1].trim() : title;
}

function parseUserCommentRefs(xml: string): UserCommentRef[] {
  const refs: UserCommentRef[] = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;

  while ((m = entryRe.exec(xml)) !== null) {
    const block = m[1];
    const id = getRssCommentId(block);
    const links = getLinks(block);
    const permalink = links.find((l) => /\/comments\//.test(l)) || "";
    const postId = extractRssPostId(permalink);
    if (!id || !postId) continue;

    refs.push({
      id,
      postId,
      subreddit: extractRssSubreddit(block, links),
      postTitle: extractRssPostTitle(block),
      createdUtc: getRssCreatedUtc(block),
    });
  }

  return refs;
}

function findParentCommentId(
  links: string[],
  ownId: string,
  candidates: Set<string>,
): string {
  for (const link of links) {
    const parts = link.split("?")[0].split("#")[0].split("/").filter(Boolean);
    const ownIdx = parts.indexOf(ownId);
    if (ownIdx <= 0) continue;
    for (let i = ownIdx - 1; i >= 0; i--) {
      if (candidates.has(parts[i])) return parts[i];
    }
  }
  return "";
}

function parseRepliesFromPostFeed(
  xml: string,
  postId: string,
  trackedComments: Map<string, UserCommentRef>,
  username: string,
): FoundReply[] {
  const found: FoundReply[] = [];
  const trackedIds = new Set(trackedComments.keys());
  const userLower = username.toLowerCase();
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;

  while ((m = entryRe.exec(xml)) !== null) {
    const block = m[1];
    const replyId = getRssCommentId(block);
    if (!replyId || trackedIds.has(replyId)) continue;

    const replyAuthor = getRssAuthor(block);
    if (!replyAuthor || replyAuthor.toLowerCase() === userLower) continue;

    const links = getLinks(block);
    const parentCommentId = findParentCommentId(links, replyId, trackedIds);
    const parent = trackedComments.get(parentCommentId);
    if (!parent) continue;

    const replyBody = extractRssBody(getTag(block, "content"));
    found.push({
      replyId,
      replyAuthor,
      replyBody,
      parentCommentId,
      postId,
      postTitle: parent.postTitle,
      subreddit: parent.subreddit,
      permalink:
        links.find((l) => /\/comments\//.test(l)) ||
        `https://www.reddit.com/comments/${postId}/_/${replyId}/`,
      createdUtc: getRssCreatedUtc(block),
      isSolved: containsSolved(replyBody),
    });
  }

  return found;
}

async function redditProxyFetchFirstText(
  env: Env,
  urls: string[],
): Promise<string | null> {
  for (const url of urls) {
    const res = await redditProxyFetch(env, url);
    if (res.ok) return res.text();
    console.error(`reddit rss fetch failed ${res.status}: ${url}`);
    if (res.status === 429) return null;
  }
  return null;
}

async function checkReplies(env: Env) {
  try {
    const username =
      (await env.KV.get(KEY_USERNAME)) || DEFAULT_USERNAME;

    const userXml = await redditProxyFetchFirstText(env, [
      `https://www.reddit.com/user/${username}/comments/.rss?sort=new&limit=50`,
      `https://www.reddit.com/user/${username}/comments.rss?sort=new&limit=50`,
      `https://old.reddit.com/user/${username}/comments/.rss?sort=new&limit=50`,
      `https://old.reddit.com/user/${username}/comments.rss?sort=new&limit=50`,
    ]);
    if (!userXml) return;
    const userComments = parseUserCommentRefs(userXml);

    const cutoff = Date.now() / 1000 - REPLY_LOOKBACK_SECONDS;

    // Group by post; only keep posts in monitored subs + recent enough
    interface PostInfo {
      commentIds: Set<string>;
      subreddit: string;
      postTitle: string;
      latestUtc: number;
    }
    const byPost = new Map<string, PostInfo>();
    for (const c of userComments) {
      const postId = c.postId;
      if (!postId) continue;
      const sub = c.subreddit.toLowerCase();
      if (!ALLOWED_SUBS_LOWER.has(sub)) continue;
      if (!INCLUDED_REPLY_SUBS.has(sub)) continue;
      if (!c.createdUtc || c.createdUtc < cutoff) continue;

      let entry = byPost.get(postId);
      if (!entry) {
        entry = {
          commentIds: new Set<string>(),
          subreddit: c.subreddit,
          postTitle: c.postTitle,
          latestUtc: c.createdUtc,
        };
        byPost.set(postId, entry);
      }
      entry.commentIds.add(c.id);
      if (c.createdUtc > entry.latestUtc) entry.latestUtc = c.createdUtc;
    }

    if (byPost.size === 0) return;

    // Most-recently-commented posts first, capped
    const sortedPosts = [...byPost.entries()]
      .sort(([, a], [, b]) => b.latestUtc - a.latestUtc)
      .slice(0, REPLY_MAX_POSTS);

    const seenIds = await getSeenReplyIds(env);
    const isFirstRun = seenIds.size === 0;

    const allReplies: FoundReply[] = [];

    for (let i = 0; i < sortedPosts.length; i++) {
      const [postId, info] = sortedPosts[i];
      try {
        const postXml = await redditProxyFetchFirstText(env, [
          `https://www.reddit.com/comments/${postId}/.rss?limit=100`,
          `https://www.reddit.com/comments/${postId}.rss?limit=100`,
          `https://old.reddit.com/comments/${postId}/.rss?limit=100`,
          `https://old.reddit.com/comments/${postId}.rss?limit=100`,
        ]);
        if (!postXml) continue;
        const tracked = new Map<string, UserCommentRef>();
        for (const commentId of info.commentIds) {
          tracked.set(commentId, {
            id: commentId,
            postId,
            subreddit: info.subreddit,
            postTitle: info.postTitle,
            createdUtc: info.latestUtc,
          });
        }
        const collected = parseRepliesFromPostFeed(
          postXml,
          postId,
          tracked,
          username,
        );
        allReplies.push(...collected);
      } catch (err) {
        console.error(`checkReplies: post ${postId} error:`, err);
      }

      // Small gap between requests to be polite
      if (i < sortedPosts.length - 1) {
        await new Promise((r) => setTimeout(r, REPLY_REQUEST_GAP_MS));
      }
    }

    const freshReplies = allReplies.filter((r) => !seenIds.has(r.replyId));

    // Persist all observed reply IDs (even non-fresh) so the set drifts forward
    if (allReplies.length > 0 && (freshReplies.length > 0 || isFirstRun)) {
      for (const r of allReplies) seenIds.add(r.replyId);
      await saveSeenReplyIds(env, seenIds);
    }

    if (isFirstRun) {
      console.log(
        `checkReplies first run: baselined ${allReplies.length} replies for u/${username}`,
      );
      return;
    }

    if (freshReplies.length === 0) return;

    const subs = await getPushSubscriptions(env);
    if (subs.length === 0) {
      console.log(
        `checkReplies: ${freshReplies.length} new replies but no subscribers`,
      );
      return;
    }

    // Sort oldest first so notifications arrive in chronological order
    freshReplies.sort((a, b) => a.createdUtc - b.createdUtc);

    for (const reply of freshReplies) {
      const bodyPreview =
        (reply.replyBody || "").trim() ||
        reply.postTitle ||
        "New reply to your comment";
      if (reply.isSolved) {
        await sendPushToAll(subs, env, {
          title: "✅ SOLVED EDIT!",
          body: `u/${reply.replyAuthor}: ${bodyPreview}`.slice(0, 180),
          tag: `fixtral-solved-${reply.replyId}`,
          url: "/app",
          type: "solved",
          vibrate: [500, 200, 500, 200, 500],
          requireInteraction: true,
          postId: reply.postId,
          replyId: reply.replyId,
        });
        continue;
      }
      await sendPushToAll(subs, env, {
        title: `💬 u/${reply.replyAuthor} replied in r/${reply.subreddit}`,
        body: bodyPreview.slice(0, 180),
        tag: `fixtral-reply-${reply.replyId}`,
        url: "/app",
        type: "reply",
        vibrate: [400, 200, 400, 200, 400],
        requireInteraction: true,
        postId: reply.postId,
        replyId: reply.replyId,
      });
    }

    console.log(
      `checkReplies: notified ${freshReplies.length} new replies for u/${username}`,
    );
  } catch (err) {
    console.error("checkReplies error:", err);
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
