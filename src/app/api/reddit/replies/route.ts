// src/app/api/reddit/replies/route.ts
export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { verifyAppToken, unauthorizedResponse } from "@/lib/auth";

// Route requests through Cloudflare Worker proxy when configured (avoids Vercel IP blocks)
async function proxyFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
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
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
    },
    cache: "no-store",
  });

  if (!res.ok) {
    throw new Error(`Reddit API error: ${res.status}`);
  }

  return res.json();
}

// Walk a comment tree looking for replies to a specific user
function findRepliesToUser(
  comments: any[],
  username: string,
): {
  replyAuthor: string;
  replyBody: string;
  postTitle: string;
  postId: string;
  replyId: string;
  subreddit: string;
}[] {
  const replies: any[] = [];

  function walk(nodes: any[], parentAuthor: string | null) {
    for (const node of nodes) {
      if (node.kind !== "t1") continue;
      const c = node.data;

      // If the parent comment was by our user and this comment is by someone else
      if (
        parentAuthor?.toLowerCase() === username.toLowerCase() &&
        c.author?.toLowerCase() !== username.toLowerCase()
      ) {
        replies.push({
          replyAuthor: c.author,
          replyBody: (c.body || "").slice(0, 200),
          postTitle: c.link_title || "",
          postId: (c.link_id || "").replace("t3_", ""),
          replyId: c.id,
          subreddit: c.subreddit,
        });
      }

      // Recurse into child replies
      if (c.replies && c.replies.data?.children) {
        walk(c.replies.data.children, c.author);
      }
    }
  }

  walk(comments, null);
  return replies;
}

export async function GET(req: NextRequest) {
  if (!verifyAppToken(req)) return unauthorizedResponse();
  try {
    const url = new URL(req.url);
    const username = url.searchParams.get("username");

    if (!username) {
      return new Response(
        JSON.stringify({ ok: false, error: "username parameter required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    // Step 1: Fetch user's recent comments to find which posts they commented on
    const userComments = await redditFetch(
      `https://www.reddit.com/user/${username}/comments.json?limit=50&raw_json=1`,
    );

    const comments = userComments.data?.children || [];

    // Extract unique post IDs the user commented on
    const commentedPostIds = new Set<string>();
    const commentedPostMap: Record<
      string,
      { subreddit: string; commentId: string }
    > = {};

    for (const c of comments) {
      const postId = (c.data.link_id || "").replace("t3_", "");
      if (postId) {
        commentedPostIds.add(postId);
        commentedPostMap[postId] = {
          subreddit: c.data.subreddit,
          commentId: c.data.id,
        };
      }
    }

    // Step 2: For recent posts (limit to 5 to avoid rate limits), check for replies
    const postIds = [...commentedPostIds].slice(0, 5);
    const allReplies: any[] = [];

    for (const postId of postIds) {
      try {
        const postComments = await redditFetch(
          `https://www.reddit.com/comments/${postId}.json?raw_json=1&limit=100`,
        );

        if (Array.isArray(postComments) && postComments.length > 1) {
          const commentTree = postComments[1].data?.children || [];
          const replies = findRepliesToUser(commentTree, username);
          allReplies.push(...replies);
        }

        // Small delay between requests
        await new Promise((r) => setTimeout(r, 500));
      } catch (err) {
        console.error(`Failed to fetch comments for post ${postId}:`, err);
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        commentedPostIds: [...commentedPostIds],
        replies: allReplies,
        timestamp: new Date().toISOString(),
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    console.error("Replies endpoint error:", err);
    return new Response(
      JSON.stringify({ ok: false, error: String(err?.message || err) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
