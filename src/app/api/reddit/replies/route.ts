// src/app/api/reddit/replies/route.ts
export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { verifyAppToken, unauthorizedResponse } from "@/lib/auth";

const DEFAULT_USERNAME = "deandean91";
const INCLUDED_REPLY_SUBS = new Set(["photoshoprequest"]);

function containsSolved(text?: string): boolean {
  return /\bsolved\b/i.test(text || "");
}

const COMMON_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "application/atom+xml,application/xml,text/xml,*/*;q=0.5",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
};

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

async function redditFetchFirstText(urls: string[]): Promise<string> {
  const failed: number[] = [];

  for (const url of urls) {
    const res = await proxyFetch(url, {
      headers: COMMON_HEADERS,
      cache: "no-store",
    });

    if (res.status === 429) throw new Error("RATE_LIMITED");
    if (res.ok) return res.text();
    failed.push(res.status);
  }

  throw new Error(
    `Reddit RSS error: ${[...new Set(failed)].join(", ") || "unknown"}`,
  );
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

function getTag(block: string, tag: string): string {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  return decodeEntities(re.exec(block)?.[1]?.trim() || "");
}

function getLinks(block: string): string[] {
  return [...block.matchAll(/<link[^>]*href="([^"]+)"/gi)].map((m) =>
    decodeEntities(m[1]),
  );
}

function getCommentId(block: string): string {
  return getTag(block, "id").replace(/^t1_/, "");
}

function getAuthor(block: string): string {
  const authorBlock = /<author[^>]*>([\s\S]*?)<\/author>/i.exec(block)?.[1] || "";
  const name = getTag(authorBlock, "name");
  return name.replace(/^\/?u\//i, "");
}

function getCreatedUtc(block: string): number {
  const raw = getTag(block, "published") || getTag(block, "updated");
  return raw ? Math.floor(new Date(raw).getTime() / 1000) : 0;
}

function extractPostId(url: string): string {
  return /\/comments\/([A-Za-z0-9]+)\//.exec(url)?.[1] || "";
}

function extractSubreddit(block: string, links: string[]): string {
  const category = /<category[^>]*term="([^"]+)"/i.exec(block)?.[1];
  if (category) return decodeEntities(category);
  const link = links.find((l) => /\/r\/[^/]+\/comments\//i.test(l));
  return /\/r\/([^/]+)\//i.exec(link || "")?.[1] || "";
}

function extractTitle(block: string): string {
  const title = getTag(block, "title");
  const prefixed = /^\/?u\/[^ ]+\s+(?:comments?\s+)?on\s+([\s\S]+)$/i.exec(title);
  if (prefixed) return prefixed[1].trim();
  const plain = /comments?\s+on\s+([\s\S]+)$/i.exec(title);
  return plain ? plain[1].trim() : title;
}

interface UserCommentRef {
  id: string;
  postId: string;
  subreddit: string;
  postTitle: string;
  createdUtc: number;
}

function parseUserCommentRefs(xml: string): UserCommentRef[] {
  const refs: UserCommentRef[] = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;

  while ((m = entryRe.exec(xml)) !== null) {
    const block = m[1];
    const id = getCommentId(block);
    const links = getLinks(block);
    const permalink = links.find((l) => /\/comments\//.test(l)) || "";
    const postId = extractPostId(permalink);
    if (!id || !postId) continue;

    refs.push({
      id,
      postId,
      subreddit: extractSubreddit(block, links),
      postTitle: extractTitle(block),
      createdUtc: getCreatedUtc(block),
    });
  }

  return refs;
}

interface FoundReply {
  replyAuthor: string;
  replyBody: string;
  postTitle: string;
  postId: string;
  replyId: string;
  subreddit: string;
  permalink: string;
  createdUtc: number;
  parentCommentId: string;
  isSolved: boolean;
}

function findParentCommentId(links: string[], ownId: string, candidates: Set<string>) {
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
  const replies: FoundReply[] = [];
  const trackedIds = new Set(trackedComments.keys());
  const userLower = username.toLowerCase();
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;

  while ((m = entryRe.exec(xml)) !== null) {
    const block = m[1];
    const replyId = getCommentId(block);
    if (!replyId || trackedIds.has(replyId)) continue;

    const replyAuthor = getAuthor(block);
    if (!replyAuthor || replyAuthor.toLowerCase() === userLower) continue;

    const links = getLinks(block);
    const parentCommentId = findParentCommentId(links, replyId, trackedIds);
    if (!parentCommentId) continue;

    const parent = trackedComments.get(parentCommentId);
    if (!parent) continue;

    replies.push({
      replyAuthor,
      replyBody: extractBody(getTag(block, "content")).slice(0, 200),
      postTitle: parent.postTitle,
      postId,
      replyId,
      subreddit: parent.subreddit,
      permalink:
        links.find((l) => /\/comments\//.test(l)) ||
        `https://www.reddit.com/comments/${postId}/_/${replyId}/`,
      createdUtc: getCreatedUtc(block),
      parentCommentId,
      isSolved: containsSolved(extractBody(getTag(block, "content"))),
    });
  }

  return replies;
}

export async function GET(req: NextRequest) {
  if (!verifyAppToken(req)) return unauthorizedResponse();

  try {
    const username = DEFAULT_USERNAME;

    let userXml = "";
    let listingBlocked = false;
    try {
      userXml = await redditFetchFirstText([
        `https://www.reddit.com/user/${username}/comments/.rss?sort=new&limit=50`,
        `https://www.reddit.com/user/${username}/comments.rss?sort=new&limit=50`,
        `https://old.reddit.com/user/${username}/comments/.rss?sort=new&limit=50`,
        `https://old.reddit.com/user/${username}/comments.rss?sort=new&limit=50`,
      ]);
    } catch (err) {
      listingBlocked = true;
      console.error("RSS replies: user comments fetch failed:", err);
    }

    if (listingBlocked) {
      return new Response(
        JSON.stringify({
          ok: true,
          source: "rss",
          partial: true,
          username,
          commentedPostIds: [],
          replies: [],
          error: "Reddit RSS blocked for replies check",
          timestamp: new Date().toISOString(),
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }
    const userComments = parseUserCommentRefs(userXml);

    const byPost = new Map<string, Map<string, UserCommentRef>>();
    for (const comment of userComments) {
      if (!INCLUDED_REPLY_SUBS.has(comment.subreddit.toLowerCase())) continue;
      if (!byPost.has(comment.postId)) byPost.set(comment.postId, new Map());
      byPost.get(comment.postId)?.set(comment.id, comment);
    }

    const postIds = [...byPost.keys()].slice(0, 5);
    const replies: FoundReply[] = [];
    let partial = false;

    for (const postId of postIds) {
      try {
        const postXml = await redditFetchFirstText([
          `https://www.reddit.com/comments/${postId}/.rss?limit=100`,
          `https://www.reddit.com/comments/${postId}.rss?limit=100`,
          `https://old.reddit.com/comments/${postId}/.rss?limit=100`,
          `https://old.reddit.com/comments/${postId}.rss?limit=100`,
        ]);
        replies.push(
          ...parseRepliesFromPostFeed(
            postXml,
            postId,
            byPost.get(postId) || new Map(),
            username,
          ),
        );
        await new Promise((r) => setTimeout(r, 400));
      } catch (err) {
        partial = true;
        console.error(`RSS replies: failed to fetch post ${postId}:`, err);
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        source: "rss",
        partial,
        username,
        commentedPostIds: postIds,
        replies,
        timestamp: new Date().toISOString(),
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    console.error("Replies endpoint error:", err);
    const isRateLimited =
      err?.message === "RATE_LIMITED" || err?.message?.includes("429");
    return new Response(
      JSON.stringify({
        ok: false,
        error: String(err?.message || err),
        rateLimited: isRateLimited,
        source: "rss",
      }),
      {
        status: isRateLimited ? 429 : 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
