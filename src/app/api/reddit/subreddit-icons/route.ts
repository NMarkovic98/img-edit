export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { verifyAppToken, unauthorizedResponse } from "@/lib/auth";

const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const API_BASE = "https://oauth.reddit.com";

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

async function getAccessToken(): Promise<string> {
  const clientId = process.env.REDDIT_CLIENT_ID?.replace(/"/g, "").trim();
  const clientSecret = process.env.REDDIT_CLIENT_SECRET?.replace(/"/g, "").trim();
  const username = process.env.REDDIT_USERNAME?.replace(/"/g, "").trim();
  const password = process.env.REDDIT_PASSWORD?.replace(/"/g, "");

  if (!clientId || !clientSecret || !username || !password) {
    throw new Error("Reddit credentials missing");
  }

  const userAgent =
    process.env.REDDIT_USER_AGENT?.replace(/"/g, "").trim() ||
    "windows:com.varnan.wsbmcp:v1.0.0 (by /u/This_Cancel_5950)";

  const body = new URLSearchParams({
    grant_type: "password",
    username,
    password,
    scope: "identity,read",
  }).toString();

  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const res = await proxyFetch(TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": userAgent,
    },
    body,
  });

  if (!res.ok) throw new Error(`Token error: ${res.status}`);
  const json = await res.json();
  return json.access_token as string;
}

// In-memory cache so we don't re-fetch on every queue render
const iconCache: Record<string, { url: string | null; ts: number }> = {};
const CACHE_TTL = 60 * 60 * 1000; // 1 hour

async function fetchSubredditIcon(
  subreddit: string,
  token: string,
): Promise<string | null> {
  const userAgent =
    process.env.REDDIT_USER_AGENT ||
    "windows:com.varnan.wsbmcp:v1.0.0 (by /u/This_Cancel_5950)";

  const res = await proxyFetch(`${API_BASE}/r/${subreddit}/about?raw_json=1`, {
    headers: {
      Authorization: `bearer ${token}`,
      "User-Agent": userAgent,
    },
    cache: "no-cache",
  });

  if (!res.ok) return null;
  const data = await res.json();
  const about = data?.data;

  // community_icon is usually the proper high-res icon; icon_img is fallback
  const raw: string =
    about?.community_icon || about?.icon_img || "";

  // Reddit encodes & as &amp; in these fields
  return raw.replace(/&amp;/g, "&").split("?")[0] || null;
}

export async function GET(req: NextRequest) {
  if (!verifyAppToken(req)) return unauthorizedResponse();

  const url = new URL(req.url);
  const param = url.searchParams.get("subreddits") || "";
  const subreddits = param
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (subreddits.length === 0) {
    return Response.json({ ok: true, icons: {} });
  }

  const now = Date.now();
  const needed = subreddits.filter(
    (s) =>
      !iconCache[s.toLowerCase()] ||
      now - iconCache[s.toLowerCase()].ts > CACHE_TTL,
  );

  if (needed.length > 0) {
    try {
      const token = await getAccessToken();
      await Promise.all(
        needed.map(async (sub) => {
          const iconUrl = await fetchSubredditIcon(sub, token);
          iconCache[sub.toLowerCase()] = { url: iconUrl, ts: now };
        }),
      );
    } catch (err) {
      console.error("Subreddit icon fetch error:", err);
    }
  }

  const icons: Record<string, string | null> = {};
  for (const sub of subreddits) {
    icons[sub] = iconCache[sub.toLowerCase()]?.url ?? null;
  }

  return Response.json({ ok: true, icons });
}
