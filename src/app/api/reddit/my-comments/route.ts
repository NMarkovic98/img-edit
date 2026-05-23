// src/app/api/reddit/my-comments/route.ts
export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { verifyAppToken, unauthorizedResponse } from "@/lib/auth";

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

async function redditFetchText(url: string): Promise<string> {
  const res = await proxyFetch(url, {
    headers: COMMON_HEADERS,
    cache: "no-store",
  });
  if (res.status === 429) throw new Error("RATE_LIMITED");
  if (!res.ok) throw new Error(`Reddit error: ${res.status}`);
  return res.text();
}

async function redditFetchJson(url: string): Promise<any> {
  const res = await proxyFetch(url, {
    headers: COMMON_HEADERS,
    cache: "no-store",
  });
  if (res.status === 429) throw new Error("RATE_LIMITED");
  if (!res.ok) throw new Error(`Reddit error: ${res.status}`);
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
  let html = rawContent
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

interface MyComment {
  id: string;
  body: string;
  score: number;
  createdUtc: number;
  subreddit: string;
  postId: string;
  postTitle: string;
  postPermalink: string;
  permalink: string;
  replyCount: number;
  topReplyAuthor?: string;
  topReplyBody?: string;
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
      const t = decodeEntities(titleMatch[1].trim());
      // Title format is typically "{author} comments on {Post Title}"
      const tm = /comments?\s+on\s+([\s\S]+)$/i.exec(t);
      postTitle = tm ? tm[1].trim() : t;
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
    const username = url.searchParams.get("username");
    const enrichParam = url.searchParams.get("enrich");
    const enrich = enrichParam !== "false"; // default true
    const enrichLimit = Math.max(
      0,
      Math.min(15, parseInt(url.searchParams.get("enrichLimit") || "8", 10)),
    );

    if (!username) {
      return new Response(
        JSON.stringify({ ok: false, error: "username parameter required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Primary listing: Atom feed (Reddit blocks the JSON endpoint for many cloud IPs)
    const xml = await redditFetchText(
      `https://www.reddit.com/user/${username}/comments.rss?sort=new&limit=50`,
    );
    const comments = parseAtomFeed(xml);

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
            const tree = postData[1].data?.children || [];
            for (const entry of byPost[target.postId] || []) {
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
