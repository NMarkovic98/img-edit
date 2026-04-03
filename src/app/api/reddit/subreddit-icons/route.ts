export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { verifyAppToken, unauthorizedResponse } from "@/lib/auth";

// In-memory cache — 1 hour TTL
const iconCache: Record<string, { url: string | null; ts: number }> = {};
const CACHE_TTL = 60 * 60 * 1000;

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

async function fetchSubredditIcon(subreddit: string): Promise<string | null> {
  try {
    // Use public JSON API — no OAuth needed
    const res = await proxyFetch(
      `https://www.reddit.com/r/${subreddit}/about.json?raw_json=1`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
          Accept: "application/json",
        },
        cache: "no-store",
      },
    );

    if (!res.ok) {
      console.error(`Subreddit icon fetch ${subreddit}: HTTP ${res.status}`);
      return null;
    }

    const data = await res.json();
    const about = data?.data;
    if (!about) return null;

    // Try icon fields in priority order (header_img is a banner, not a logo)
    const candidates: string[] = [
      about.community_icon,
      about.icon_img,
    ].filter(Boolean);

    for (const raw of candidates) {
      // Reddit encodes &amp; in JSON sometimes
      const cleaned = raw.replace(/&amp;/g, "&").trim();
      if (cleaned && cleaned.startsWith("http")) return cleaned;
    }

    return null;
  } catch (err) {
    console.error(`Subreddit icon error ${subreddit}:`, err);
    return null;
  }
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
    await Promise.all(
      needed.map(async (sub) => {
        const iconUrl = await fetchSubredditIcon(sub);
        iconCache[sub.toLowerCase()] = { url: iconUrl, ts: now };
      }),
    );
  }

  const icons: Record<string, string | null> = {};
  for (const sub of subreddits) {
    icons[sub] = iconCache[sub.toLowerCase()]?.url ?? null;
  }

  return Response.json({ ok: true, icons });
}
