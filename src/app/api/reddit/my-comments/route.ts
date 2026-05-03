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

async function redditFetch(url: string) {
  const res = await proxyFetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
    },
    cache: "no-store",
  });

  if (res.status === 429) {
    throw new Error("RATE_LIMITED");
  }

  if (!res.ok) {
    throw new Error(`Reddit API error: ${res.status}`);
  }

  return res.json();
}

interface ReplyInfo {
  count: number;
  topAuthor?: string;
  topBody?: string;
}

// Walk a comment tree, find a comment by id, then count direct + nested replies that aren't from the user
function countRepliesForComment(
  comments: any[],
  targetCommentId: string,
  username: string,
): ReplyInfo {
  const result: ReplyInfo = { count: 0 };

  function walkChildren(nodes: any[]) {
    for (const node of nodes) {
      if (node.kind !== "t1") continue;
      const c = node.data;
      if (c.author?.toLowerCase() !== username.toLowerCase()) {
        result.count += 1;
        if (!result.topAuthor) {
          result.topAuthor = c.author;
          result.topBody = (c.body || "").slice(0, 160);
        }
      }
      if (c.replies && c.replies.data?.children) {
        walkChildren(c.replies.data.children);
      }
    }
  }

  function findAndCount(nodes: any[]): boolean {
    for (const node of nodes) {
      if (node.kind !== "t1") continue;
      const c = node.data;
      if (c.id === targetCommentId) {
        if (c.replies && c.replies.data?.children) {
          walkChildren(c.replies.data.children);
        }
        return true;
      }
      if (c.replies && c.replies.data?.children) {
        if (findAndCount(c.replies.data.children)) return true;
      }
    }
    return false;
  }

  findAndCount(comments);
  return result;
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

    const userComments = await redditFetch(
      `https://www.reddit.com/user/${username}/comments.json?limit=50&raw_json=1`,
    );

    const rawComments = userComments.data?.children || [];

    const comments = rawComments
      .filter((c: any) => c.kind === "t1")
      .map((c: any) => {
        const d = c.data;
        const postId = (d.link_id || "").replace("t3_", "");
        return {
          id: d.id as string,
          body: (d.body || "") as string,
          score: typeof d.score === "number" ? d.score : 0,
          createdUtc: typeof d.created_utc === "number" ? d.created_utc : 0,
          subreddit: (d.subreddit || "") as string,
          postId,
          postTitle: (d.link_title || "") as string,
          postPermalink: d.link_permalink
            ? (d.link_permalink as string)
            : `https://www.reddit.com/comments/${postId}`,
          permalink: d.permalink
            ? `https://www.reddit.com${d.permalink}`
            : `https://www.reddit.com/comments/${postId}/_/${d.id}/`,
          replyCount: 0,
          topReplyAuthor: undefined as string | undefined,
          topReplyBody: undefined as string | undefined,
        };
      });

    if (enrich && comments.length > 0) {
      // Pick the most-recent unique posts to enrich (avoid hammering Reddit)
      const seen = new Set<string>();
      const enrichTargets: typeof comments = [];
      for (const c of comments) {
        if (!c.postId || seen.has(c.postId)) continue;
        seen.add(c.postId);
        enrichTargets.push(c);
        if (enrichTargets.length >= enrichLimit) break;
      }

      // Map postId -> array of (commentId, index in `comments`)
      const byPost: Record<string, { commentId: string; idx: number }[]> = {};
      comments.forEach((c: any, idx: number) => {
        if (!c.postId) return;
        if (!byPost[c.postId]) byPost[c.postId] = [];
        byPost[c.postId].push({ commentId: c.id, idx });
      });

      for (const target of enrichTargets) {
        try {
          const postComments = await redditFetch(
            `https://www.reddit.com/comments/${target.postId}.json?raw_json=1&limit=200`,
          );
          if (Array.isArray(postComments) && postComments.length > 1) {
            const tree = postComments[1].data?.children || [];
            for (const entry of byPost[target.postId] || []) {
              const info = countRepliesForComment(
                tree,
                entry.commentId,
                username,
              );
              comments[entry.idx].replyCount = info.count;
              comments[entry.idx].topReplyAuthor = info.topAuthor;
              comments[entry.idx].topReplyBody = info.topBody;
            }
          }
          await new Promise((r) => setTimeout(r, 400));
        } catch (err) {
          console.error(
            `[my-comments] Failed to enrich post ${target.postId}:`,
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
        enriched: enrich,
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
