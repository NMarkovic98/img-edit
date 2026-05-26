// src/app/api/reddit/my-comments/route.ts
export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { verifyAppToken, unauthorizedResponse } from "@/lib/auth";

const DEFAULT_USERNAME = "deandean91";
const EXCLUDED_SUBS = new Set(["beamazed"]);

async function proxyFetch(url: string, init?: RequestInit): Promise<Response> {
  const proxyUrl = process.env.CLOUDFLARE_PROXY_URL;
  const proxySecret = process.env.CLOUDFLARE_PROXY_SECRET;

  if (proxyUrl && proxySecret) {
    const target = `${proxyUrl}?url=${encodeURIComponent(url)}`;
    const headers = new Headers(init?.headers);
    headers.set("X-Proxy-Secret", proxySecret);
    return fetch(target, { ...init, headers });
  }

  return fetch(url, init);
}

const COMMON_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept:
    "application/atom+xml,application/xml,text/xml,application/json;q=0.9,*/*;q=0.5",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
};

async function redditFetchFirstText(urls: string[]): Promise<{
  text: string;
  sourceUrl: string;
  failed: { url: string; status: number }[];
}> {
  const failed: { url: string; status: number }[] = [];

  for (const url of urls) {
    const res = await proxyFetch(url, {
      headers: COMMON_HEADERS,
      cache: "no-store",
    });

    if (res.status === 429) throw new Error("RATE_LIMITED");
    if (res.ok) {
      return { text: await res.text(), sourceUrl: url, failed };
    }
    failed.push({ url, status: res.status });
  }

  const statuses = [...new Set(failed.map((f) => f.status))].join(", ");
  throw new Error(`Reddit RSS error: ${statuses || "unknown"}`);
}

async function redditFetchJson(url: string): Promise<any> {
  const res = await proxyFetch(url, {
    headers: COMMON_HEADERS,
    cache: "no-store",
  });
  if (res.status === 429) throw new Error("RATE_LIMITED");
  if (!res.ok) throw new Error(`Reddit JSON enrichment error: ${res.status}`);
  return res.json();
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

// Reddit's atom <content> wraps the comment HTML and then appends a footer like
// `submitted by /u/X to /r/Y [link] [comment]`. Trim that off and strip tags.
function extractBody(rawContent: string): string {
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

function extractPostTitle(rawTitle: string): string {
  const title = decodeEntities(rawTitle).trim();
  const prefixed = /^\/?u\/[^ ]+\s+(?:comments?\s+)?on\s+([\s\S]+)$/i.exec(title);
  if (prefixed) return prefixed[1].trim();
  const plain = /comments?\s+on\s+([\s\S]+)$/i.exec(title);
  return plain ? plain[1].trim() : title;
}

interface MyComment {
  id: string;
  body: string;
  score: number;
  createdUtc: number;
  subreddit: string;
  postAuthor?: string;
  postId: string;
  postTitle: string;
  postText?: string;
  postImageUrl?: string;
  postThumbnailUrl?: string;
  postCommentCount?: number;
  postPermalink: string;
  permalink: string;
  replyCount: number;
  topReplyAuthor?: string;
  topReplyBody?: string;
  commentTree?: CommentNode[];
}

function parseAtomFeed(xml: string): MyComment[] {
  const out: MyComment[] = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = entryRe.exec(xml)) !== null) {
    const block = m[1];

    const idMatch = /<id>([\s\S]*?)<\/id>/.exec(block);
    const linkMatch = /<link[^>]*href="([^"]+)"/i.exec(block);
    const subMatch = /<category[^>]*term="([^"]+)"/i.exec(block);
    const publishedMatch = /<published>([^<]+)<\/published>/.exec(block);
    const updatedMatch = /<updated>([^<]+)<\/updated>/.exec(block);
    const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/.exec(block);
    const contentMatch = /<content[^>]*>([\s\S]*?)<\/content>/.exec(block);

    if (!idMatch || !linkMatch) continue;

    const rawId = idMatch[1].trim();
    const commentId = rawId.replace(/^t1_/, "");
    if (!commentId) continue;

    const permalink = linkMatch[1];
    const subreddit = subMatch?.[1] || "";
    const publishedRaw = publishedMatch?.[1] || updatedMatch?.[1] || "";
    const createdUtc = publishedRaw
      ? Math.floor(new Date(publishedRaw).getTime() / 1000)
      : 0;

    let postTitle = "";
    if (titleMatch) {
      postTitle = extractPostTitle(titleMatch[1]);
    }

    let postId = "";
    const pm = /\/comments\/([A-Za-z0-9]+)\//.exec(permalink);
    if (pm) postId = pm[1];

    const postPermalink = postId
      ? `https://www.reddit.com/comments/${postId}`
      : permalink;

    const body = contentMatch ? extractBody(contentMatch[1]) : "";

    out.push({
      id: commentId,
      body,
      score: 0, // Atom feed doesn't include score — enrichment will fill this in
      createdUtc,
      subreddit,
      postId,
      postTitle,
      postPermalink,
      permalink,
      replyCount: 0,
    });
  }
  return out;
}

interface EnrichInfo {
  score: number;
  replyCount: number;
  topReplyAuthor?: string;
  topReplyBody?: string;
}

interface CommentNode {
  id: string;
  author: string;
  body: string;
  score: number;
  createdUtc: number;
  depth: number;
  isMine: boolean;
  children: CommentNode[];
}

interface PostInfo {
  postAuthor?: string;
  postText?: string;
  postImageUrl?: string;
  postThumbnailUrl?: string;
  postCommentCount?: number;
}

function isImageUrl(url?: string): boolean {
  return !!url && /\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(url);
}

function cleanImageUrl(url?: string): string | undefined {
  return url ? decodeEntities(url).replace(/&amp;/g, "&") : undefined;
}

function imageFromPost(post: any): string | undefined {
  if (!post) return undefined;

  if (post.is_gallery && post.media_metadata) {
    const firstImageId = post.gallery_data?.items?.[0]?.media_id ||
      Object.keys(post.media_metadata)[0];
    const meta = post.media_metadata[firstImageId];
    if (meta?.status === "valid") {
      const ext = (meta.m || "image/jpg").split("/")[1] === "png" ? "png" : "jpg";
      return `https://i.redd.it/${firstImageId}.${ext}`;
    }
    if (meta?.s?.u) return cleanImageUrl(meta.s.u);
  }

  if (post.preview?.images?.[0]?.source?.url) {
    const previewUrl = cleanImageUrl(post.preview.images[0].source.url) || "";
    const idMatch = previewUrl.match(
      /preview\.redd\.it\/([a-zA-Z0-9]+)\.(jpg|jpeg|png|gif|webp)/,
    );
    if (idMatch) return `https://i.redd.it/${idMatch[1]}.${idMatch[2]}`;
    return previewUrl;
  }

  if (isImageUrl(post.url) || post.url?.includes("i.redd.it")) {
    return cleanImageUrl(post.url);
  }

  const crosspost = post.crosspost_parent_list?.[0];
  return crosspost ? imageFromPost(crosspost) : undefined;
}

function postInfoFromListing(post: any): PostInfo {
  if (!post) return {};
  const thumbnail = cleanImageUrl(post.thumbnail);
  const postText = (post.selftext || "").trim();
  const title = (post.title || "").trim();
  return {
    postAuthor: post.author || undefined,
    postText: postText && postText !== title ? postText : undefined,
    postImageUrl: imageFromPost(post),
    postThumbnailUrl:
      thumbnail && thumbnail.startsWith("http") ? thumbnail : undefined,
    postCommentCount:
      typeof post.num_comments === "number" ? post.num_comments : undefined,
  };
}

function buildCommentTree(
  nodes: any[],
  username: string,
  depth = 0,
): CommentNode[] {
  const userLower = username.toLowerCase();
  const out: CommentNode[] = [];

  for (const node of nodes) {
    if (node.kind !== "t1") continue;
    const c = node.data;
    const author = String(c.author || "[deleted]");
    const children =
      c.replies?.data?.children && depth < 8
        ? buildCommentTree(c.replies.data.children, username, depth + 1)
        : [];

    out.push({
      id: String(c.id || ""),
      author,
      body: String(c.body || "").trim(),
      score: typeof c.score === "number" ? c.score : 0,
      createdUtc: typeof c.created_utc === "number" ? c.created_utc : 0,
      depth,
      isMine: author.toLowerCase() === userLower,
      children,
    });
  }

  return out;
}

// Find the user's comment in the post tree, return its score + count direct/nested
// replies that aren't from the user.
function enrichFromTree(
  nodes: any[],
  targetCommentId: string,
  username: string,
): EnrichInfo | null {
  let found: EnrichInfo | null = null;

  function countReplies(children: any[]): {
    count: number;
    topAuthor?: string;
    topBody?: string;
  } {
    let count = 0;
    let topAuthor: string | undefined;
    let topBody: string | undefined;
    function walk(ns: any[]) {
      for (const n of ns) {
        if (n.kind !== "t1") continue;
        const c = n.data;
        if (c.author?.toLowerCase() !== username.toLowerCase()) {
          count += 1;
          if (!topAuthor) {
            topAuthor = c.author;
            topBody = (c.body || "").slice(0, 160);
          }
        }
        if (c.replies && c.replies.data?.children) {
          walk(c.replies.data.children);
        }
      }
    }
    walk(children);
    return { count, topAuthor, topBody };
  }

  function walk(ns: any[]): boolean {
    for (const n of ns) {
      if (n.kind !== "t1") continue;
      const c = n.data;
      if (c.id === targetCommentId) {
        const info = c.replies?.data?.children
          ? countReplies(c.replies.data.children)
          : { count: 0 };
        found = {
          score: typeof c.score === "number" ? c.score : 0,
          replyCount: info.count,
          topReplyAuthor: info.topAuthor,
          topReplyBody: info.topBody,
        };
        return true;
      }
      if (c.replies?.data?.children) {
        if (walk(c.replies.data.children)) return true;
      }
    }
    return false;
  }

  walk(nodes);
  return found;
}

export async function GET(req: NextRequest) {
  if (!verifyAppToken(req)) return unauthorizedResponse();
  try {
    const url = new URL(req.url);
    const username = DEFAULT_USERNAME;
    const enrichParam = url.searchParams.get("enrich");
    const enrich = enrichParam !== "false"; // default true
    const enrichLimit = Math.max(
      0,
      Math.min(15, parseInt(url.searchParams.get("enrichLimit") || "12", 10)),
    );

    // Primary listing: Atom feed (Reddit blocks the JSON endpoint for many cloud IPs)
    let listing: Awaited<ReturnType<typeof redditFetchFirstText>>;
    try {
      listing = await redditFetchFirstText([
        `https://www.reddit.com/user/${username}/comments/.rss?sort=new&limit=50`,
        `https://www.reddit.com/user/${username}/comments.rss?sort=new&limit=50`,
        `https://old.reddit.com/user/${username}/comments/.rss?sort=new&limit=50`,
        `https://old.reddit.com/user/${username}/comments.rss?sort=new&limit=50`,
      ]);
    } catch (err) {
      console.error("my-comments RSS listing failed:", err);
      return new Response(
        JSON.stringify({
          ok: true,
          username,
          count: 0,
          comments: [],
          enriched: false,
          enrichmentFailed: false,
          source: "rss",
          rssBlocked: true,
          error: "Reddit RSS blocked for comments listing",
          timestamp: new Date().toISOString(),
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }
    const xml = listing.text;
    const comments = parseAtomFeed(xml).filter(
      (c) => !EXCLUDED_SUBS.has(c.subreddit.toLowerCase()),
    );

    let enrichedAny = false;
    let enrichmentFailed = false;

    if (enrich && comments.length > 0) {
      const seen = new Set<string>();
      const enrichTargets: MyComment[] = [];
      for (const c of comments) {
        if (!c.postId || seen.has(c.postId)) continue;
        seen.add(c.postId);
        enrichTargets.push(c);
        if (enrichTargets.length >= enrichLimit) break;
      }

      const byPost: Record<string, { commentId: string; idx: number }[]> = {};
      comments.forEach((c, idx) => {
        if (!c.postId) return;
        if (!byPost[c.postId]) byPost[c.postId] = [];
        byPost[c.postId].push({ commentId: c.id, idx });
      });

      for (const target of enrichTargets) {
        try {
          const postData = await redditFetchJson(
            `https://www.reddit.com/comments/${target.postId}.json?raw_json=1&limit=200`,
          );
          if (Array.isArray(postData) && postData.length > 1) {
            const postInfo = postInfoFromListing(
              postData[0]?.data?.children?.[0]?.data,
            );
            const tree = postData[1].data?.children || [];
            const commentTree = buildCommentTree(tree, username);
            for (const entry of byPost[target.postId] || []) {
              comments[entry.idx].postAuthor = postInfo.postAuthor;
              comments[entry.idx].postText = postInfo.postText;
              comments[entry.idx].postImageUrl = postInfo.postImageUrl;
              comments[entry.idx].postThumbnailUrl = postInfo.postThumbnailUrl;
              comments[entry.idx].postCommentCount = postInfo.postCommentCount;
              comments[entry.idx].commentTree = commentTree;
              const info = enrichFromTree(tree, entry.commentId, username);
              if (info) {
                comments[entry.idx].score = info.score;
                comments[entry.idx].replyCount = info.replyCount;
                comments[entry.idx].topReplyAuthor = info.topReplyAuthor;
                comments[entry.idx].topReplyBody = info.topReplyBody;
                enrichedAny = true;
              }
            }
          }
          await new Promise((r) => setTimeout(r, 400));
        } catch (err) {
          enrichmentFailed = true;
          console.error(
            `[my-comments] enrichment failed for ${target.postId}:`,
            err,
          );
        }
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        username,
        count: comments.length,
        comments,
        enriched: enrichedAny,
        enrichmentFailed,
        source: "rss",
        sourceUrl: listing.sourceUrl,
        sourceFallbacksFailed: listing.failed,
        timestamp: new Date().toISOString(),
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    console.error("my-comments endpoint error:", err);
    const isRateLimited =
      err?.message === "RATE_LIMITED" || err?.message?.includes("429");
    return new Response(
      JSON.stringify({
        ok: false,
        error: String(err?.message || err),
        rateLimited: isRateLimited,
      }),
      {
        status: isRateLimited ? 429 : 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
