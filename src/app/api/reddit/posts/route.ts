// src/app/api/reddit/posts/route.ts
export const runtime = "nodejs"; // ensure Node runtime (Buffer required)

import type { NextRequest } from "next/server";
import { GoogleGenAI } from "@google/genai";
import { verifyAppToken, unauthorizedResponse } from "@/lib/auth";

if (!process.env.GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY not found in environment variables");
}

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY! });

const TOKEN_URL = "https://www.reddit.com/api/v1/access_token";
const API_BASE = "https://oauth.reddit.com";

// Route requests through Cloudflare Worker proxy when configured (avoids Vercel IP blocks)
async function proxyFetch(url: string, init?: RequestInit): Promise<Response> {
  const proxyUrl = process.env.CLOUDFLARE_PROXY_URL;
  const proxySecret = process.env.CLOUDFLARE_PROXY_SECRET;

  if (proxyUrl && proxySecret) {
    const target = `${proxyUrl}?url=${encodeURIComponent(url)}`;
    const headers = new Headers(init?.headers);
    headers.set("X-Proxy-Secret", proxySecret);
    console.log(`Proxying via Cloudflare: ${url.substring(0, 80)}...`);
    return fetch(target, { ...init, headers });
  }

  return fetch(url, init);
}

async function getAccessToken() {
  const clientId = process.env.REDDIT_CLIENT_ID?.replace(/"/g, "").trim();
  const clientSecret = process.env.REDDIT_CLIENT_SECRET?.replace(
    /"/g,
    "",
  ).trim();
  const username = process.env.REDDIT_USERNAME?.replace(/"/g, "").trim();
  const password = process.env.REDDIT_PASSWORD?.replace(/"/g, "");

  if (!clientId || !clientSecret || !username || !password) {
    throw new Error(
      "Reddit credentials are missing from environment variables",
    );
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

  const authString = `${clientId}:${clientSecret}`;
  const basic = Buffer.from(authString).toString("base64");

  const headers: Record<string, string> = {
    Authorization: `Basic ${basic}`,
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": userAgent,
  };

  const res = await proxyFetch(TOKEN_URL, { method: "POST", headers, body });

  if (!res.ok) {
    const text = await res.text();
    console.error(
      "Token call failed. Basic prefix:",
      `Basic ${basic.substring(0, 24)}... (compare to curl log)`,
    );
    throw new Error(`Failed to get access token: ${res.status} ${text}`);
  }

  const json = await res.json();
  return json.access_token as string;
}

async function redditGet(path: string, token: string) {
  const userAgent =
    process.env.REDDIT_USER_AGENT ||
    "windows:com.varnan.wsbmcp:v1.0.0 (by /u/Ok-Literature-9189)";

  const res = await proxyFetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `bearer ${token}`,
      "User-Agent": userAgent,
    },
    cache: "no-cache",
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Reddit API error: ${res.status} ${text}`);
  }
  return res.json();
}

// Analyze Reddit post with Gemini and generate edit prompt
async function analyzeRedditPost(postData: {
  title: string;
  description: string;
  imageUrl: string;
}) {
  const imageResponse = await fetch(postData.imageUrl);
  const imageBuffer = await imageResponse.arrayBuffer();
  const imageBase64 = Buffer.from(imageBuffer).toString("base64");

  const mimeType = postData.imageUrl.includes(".png")
    ? "image/png"
    : "image/jpeg";

  const analysisPrompt = `
You are an image-edit analyst. Read the title + description + image and return ONE concise instruction paragraph,
strictly describing what to change (no extras, no emojis, no headers). Avoid speculation.

Title: ${postData.title}
Description: ${postData.description || "No description provided"}

Focus ONLY on technical editing requirements - remove/add objects, color changes, restoration, etc. No emotional context or fluff.
`;

  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: [
      {
        role: "user",
        parts: [
          { text: analysisPrompt },
          {
            inlineData: {
              mimeType: mimeType,
              data: imageBase64,
            },
          },
        ],
      },
    ],
  });

  const generatedPrompt =
    response.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";

  return {
    analysis: generatedPrompt,
    originalPost: postData,
  };
}

// Last successful response — used ONLY as fallback when rate-limited or erroring
let lastPosts: any[] = [];

// Fetch posts via Reddit OAuth API (preferred) or public JSON API (fallback)
// Smaller subs get their own fetch so they don't get drowned out by PhotoshopRequest
const SEPARATE_FETCH_SUBS = new Set(["photoshoprequests", "editmyphoto", "estoration", "picrequests"]);

async function fetchSubredditPosts(sub: string, isOAuth: boolean, token?: string): Promise<any[]> {
  try {
    if (isOAuth && token) {
      const response = await redditGet(`/r/${sub}/new?limit=50&raw_json=1`, token);
      return response.data.children.map((child: any) => child.data);
    } else {
      const res = await proxyFetch(
        `https://www.reddit.com/r/${sub}/new.json?limit=50&raw_json=1`,
        {
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "gzip, deflate, br",
            Connection: "keep-alive",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "none",
          },
          cache: "no-store",
        },
      );
      if (!res.ok) {
        console.error(`Reddit public API error for r/${sub}: ${res.status}`);
        return [];
      }
      const data = await res.json();
      return data.data.children.map((child: any) => child.data);
    }
  } catch (err) {
    console.error(`Error fetching r/${sub}:`, err);
    return [];
  }
}

async function fetchPostsViaAPI(
  subreddits: string[] = ["PhotoshopRequest"],
): Promise<{ posts: any[]; rateLimited: boolean; resetAfter?: number }> {
  const hasRedditCredentials =
    process.env.REDDIT_CLIENT_ID &&
    process.env.REDDIT_CLIENT_SECRET &&
    process.env.REDDIT_USERNAME &&
    process.env.REDDIT_PASSWORD;

  try {
    let token: string | undefined;
    if (hasRedditCredentials) {
      token = await getAccessToken();
    }
    const isOAuth = !!token;

    // Split: main sub (PhotoshopRequest) fetched with limit=100, smaller subs fetched separately
    const mainSubs = subreddits.filter((s) => !SEPARATE_FETCH_SUBS.has(s.toLowerCase()));
    const separateSubs = subreddits.filter((s) => SEPARATE_FETCH_SUBS.has(s.toLowerCase()));

    // Fetch all in parallel
    const fetches: Promise<any[]>[] = [];

    if (mainSubs.length > 0) {
      const mainMulti = mainSubs.join("+");
      if (isOAuth) {
        console.log(`Fetching via OAuth API: r/${mainMulti}/new`);
        fetches.push(
          redditGet(`/r/${mainMulti}/new?limit=100&raw_json=1`, token!)
            .then((r) => r.data.children.map((c: any) => c.data))
            .catch((err) => { console.error(`Main fetch error:`, err); return []; })
        );
      } else {
        console.log(`Fetching from r/${mainMulti}/new.json (public API)`);
        fetches.push(
          proxyFetch(`https://www.reddit.com/r/${mainMulti}/new.json?limit=100&raw_json=1`, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
              Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7",
              "Accept-Language": "en-US,en;q=0.9",
              "Accept-Encoding": "gzip, deflate, br",
              Connection: "keep-alive",
              "Sec-Fetch-Dest": "document",
              "Sec-Fetch-Mode": "navigate",
              "Sec-Fetch-Site": "none",
            },
            cache: "no-store",
          }).then(async (res) => {
            if (res.status === 429) {
              console.warn(`Rate limited on main fetch`);
              return [];
            }
            if (!res.ok) return [];
            const data = await res.json();
            return data.data.children.map((c: any) => c.data);
          }).catch(() => [])
        );
      }
    }

    for (const sub of separateSubs) {
      console.log(`Fetching separately: r/${sub}/new`);
      fetches.push(fetchSubredditPosts(sub, isOAuth, token));
    }

    const results = await Promise.all(fetches);
    const allPosts = results.flat();

    // Deduplicate by post ID (in case of crossposts appearing in multiple subs)
    const seen = new Set<string>();
    const dedupedPosts = allPosts.filter((p) => {
      if (seen.has(p.id)) return false;
      seen.add(p.id);
      return true;
    });

    lastPosts = dedupedPosts;
    console.log(`Fetched ${dedupedPosts.length} total posts (${results.map((r) => r.length).join('+')} per fetch)`);

    return { posts: processRawPosts(dedupedPosts), rateLimited: false };
  } catch (err) {
    console.error("Reddit fetch error:", err);
    return lastPosts.length > 0
      ? { posts: processRawPosts(lastPosts), rateLimited: false }
      : { posts: [], rateLimited: false };
  }
}

function processRawPosts(allPosts: any[]) {
  const posts = allPosts;

  const twoHoursAgo = Date.now() / 1000 - 2 * 60 * 60;

  function getFullResUrl(mediaId: string, metadata: any): string {
    const mimeType = metadata?.m || "image/jpg";
    const ext = mimeType.split("/")[1] === "png" ? "png" : "jpg";
    return `https://i.redd.it/${mediaId}.${ext}`;
  }

  function extractGalleryImages(post: any): string[] {
    const images: string[] = [];
    if (!post.media_metadata) return images;

    const orderedIds = post.gallery_data?.items
      ? post.gallery_data.items.map((item: any) => item.media_id)
      : Object.keys(post.media_metadata);

    for (const mediaId of orderedIds) {
      const meta = post.media_metadata[mediaId];
      if (meta && meta.status === "valid") {
        images.push(getFullResUrl(mediaId, meta));
      }
    }
    return images;
  }

  const MAX_DIM = 4096;

  // Extract known dimensions from Reddit metadata (no extra fetches)
  function getKnownDimensions(post: any): { w: number; h: number } | null {
    // Gallery: first image in media_metadata
    if (post.media_metadata) {
      const firstId = post.gallery_data?.items?.[0]?.media_id ||
        Object.keys(post.media_metadata)[0];
      const meta = post.media_metadata[firstId];
      if (meta?.s?.x && meta?.s?.y) return { w: meta.s.x, h: meta.s.y };
    }
    // Regular post with preview
    if (post.preview?.images?.[0]?.source) {
      const src = post.preview.images[0].source;
      if (src.width && src.height) return { w: src.width, h: src.height };
    }
    // Crosspost
    if (post.crosspost_parent_list?.[0]) {
      return getKnownDimensions(post.crosspost_parent_list[0]);
    }
    return null;
  }

  // Log per-subreddit counts before filtering
  const subCounts: Record<string, number> = {};
  for (const p of posts) {
    const s = p.subreddit || "unknown";
    subCounts[s] = (subCounts[s] || 0) + 1;
  }
  console.log(`[processRawPosts] Raw posts per subreddit:`, subCounts);

  return posts
    .filter((post: any) => {
      const hasImage =
        post.url &&
        (post.url.match(/\.(jpg|jpeg|png|gif|webp)$/i) ||
          post.url.includes("i.redd.it") ||
          post.url.includes("i.imgur.com") ||
          post.url.includes("imgur.com") ||
          post.url.includes("redditmedia") ||
          (post.preview &&
            post.preview.images &&
            post.preview.images.length > 0));
      const isGallery = post.is_gallery === true && post.media_metadata;
      const hasSelfPostImages =
        post.is_self &&
        post.media_metadata &&
        Object.keys(post.media_metadata).length > 0;
      // Also detect imgur album/page links that have preview images
      const hasImgurLink = post.url && post.url.includes("imgur.com") && post.preview?.images?.length > 0;
      const subLower = (post.subreddit || "").toLowerCase();
      const isRecent = post.created_utc > twoHoursAgo;
      // Skip all filters for high-value smaller subs — show everything
      const NO_FILTER_SUBS = new Set(["photoshoprequests", "editmyphoto", "estoration"]);
      if (NO_FILTER_SUBS.has(subLower)) {
        // Check crosspost for images too
        const crosspost = post.crosspost_parent_list?.[0];
        const crossHasImage = crosspost && (
          crosspost.url?.includes("i.redd.it") ||
          crosspost.url?.match(/\.(jpg|jpeg|png|gif|webp)$/i) ||
          crosspost.preview?.images?.length > 0 ||
          (crosspost.is_gallery && crosspost.media_metadata)
        );
        const anyImage = hasImage || isGallery || hasSelfPostImages || hasImgurLink || crossHasImage;
        if (!anyImage || !isRecent) return false;
        return true;
      }

      if (!(hasImage || isGallery || hasSelfPostImages || hasImgurLink) || !isRecent) {
        return false;
      }
      // Skip images that exceed AI model limits
      const dims = getKnownDimensions(post);
      if (dims && (dims.w > MAX_DIM || dims.h > MAX_DIM)) {
        return false;
      }
      return true;
    })
    .map((post: any) => {
      let imageUrl = post.url;
      let allImages: string[] = [];

      if (
        (post.is_gallery || (post.is_self && post.media_metadata)) &&
        post.media_metadata
      ) {
        allImages = extractGalleryImages(post);
        imageUrl = allImages[0] || post.url;
      } else if (
        post.crosspost_parent_list &&
        post.crosspost_parent_list.length > 0
      ) {
        const originalPost = post.crosspost_parent_list[0];
        if (originalPost.is_gallery && originalPost.media_metadata) {
          allImages = extractGalleryImages(originalPost);
          imageUrl = allImages[0] || originalPost.url;
        } else if (
          originalPost.url &&
          (originalPost.url.match(/\.(jpg|jpeg|png|gif|webp)$/i) ||
            originalPost.url.includes("i.redd.it") ||
            originalPost.url.includes("i.imgur.com"))
        ) {
          imageUrl = originalPost.url;
        }
      } else if (
        post.preview &&
        post.preview.images &&
        post.preview.images.length > 0
      ) {
        // Try to get original i.redd.it URL from the preview image ID
        // preview.redd.it URLs are recompressed; i.redd.it URLs are originals
        const previewImage = post.preview.images[0];
        const previewUrl =
          previewImage.source?.url?.replace(/&amp;/g, "&") || "";
        const idMatch = previewUrl.match(
          /preview\.redd\.it\/([a-zA-Z0-9]+)\.(jpg|jpeg|png|gif|webp)/,
        );
        if (idMatch) {
          imageUrl = `https://i.redd.it/${idMatch[1]}.${idMatch[2]}`;
        } else if (previewImage.source?.url) {
          imageUrl = previewUrl;
        }
      }

      if (allImages.length === 0) {
        allImages = [imageUrl];
      }

      const flair = (post.link_flair_text || "").toLowerCase();
      const titleLowerPaid = post.title.toLowerCase();
      const descLower = (post.selftext || "").toLowerCase();
      const subredditLower = (post.subreddit || "").toLowerCase();
      // PhotoshopRequest uses flair reliably; other subreddits need keyword detection
      const isPhotoshopSub =
        subredditLower === "photoshoprequest" ||
        subredditLower === "photoshoprequests";
      const hasPaidKeyword =
        titleLowerPaid.includes("pay") ||
        titleLowerPaid.includes("paid") ||
        titleLowerPaid.includes("$") ||
        titleLowerPaid.includes("€") ||
        titleLowerPaid.includes("£") ||
        descLower.includes("pay") ||
        descLower.includes("paid") ||
        descLower.includes("$") ||
        descLower.includes("€") ||
        descLower.includes("£");
      const isPaid = isPhotoshopSub
        ? flair.includes("paid") || titleLowerPaid.includes("[paid]")
        : hasPaidKeyword || flair.includes("paid");

      // Detect AI policy from flair
      let aiPolicy: "ai_ok" | "no_ai" | "unknown" = "unknown";
      if (
        flair.includes("no ai") ||
        titleLowerPaid.includes("no ai") ||
        titleLowerPaid.includes("[no ai]")
      ) {
        aiPolicy = "no_ai";
      } else if (
        flair.includes("ai ok") ||
        flair.includes("ai allowed") ||
        titleLowerPaid.includes("ai ok") ||
        titleLowerPaid.includes("[ai ok]") ||
        titleLowerPaid.includes("[ai]")
      ) {
        aiPolicy = "ai_ok";
      }

      return {
        id: post.id,
        title: post.title,
        description: post.selftext || post.title,
        imageUrl,
        allImages,
        isGallery: allImages.length > 1,
        imageCount: allImages.length,
        postUrl: `https://reddit.com${post.permalink}`,
        created_utc: post.created_utc,
        created_date: new Date(post.created_utc * 1000).toISOString(),
        author: post.author,
        score: post.score,
        num_comments: post.num_comments,
        subreddit: post.subreddit,
        thumbnail: post.thumbnail,
        upvote_ratio: post.upvote_ratio,
        flair: post.link_flair_text || null,
        isPaid,
        aiPolicy,
        imageDimensions: getKnownDimensions(post),
      };
    });
}

export async function GET(_req: NextRequest) {
  if (!verifyAppToken(_req)) return unauthorizedResponse();
  try {
    const url = new URL(_req.url);
    const subredditParam = url.searchParams.get("subreddits");
    const subreddits = subredditParam
      ? subredditParam.split(",").map((s) => s.trim())
      : ["PhotoshopRequest"];

    const result = await fetchPostsViaAPI(subreddits);
    result.posts.sort((a: any, b: any) => b.created_utc - a.created_utc);
    console.log(`Found ${result.posts.length} image posts`);

    return new Response(
      JSON.stringify({
        ok: true,
        posts: result.posts,
        total: result.posts.length,
        rateLimited: result.rateLimited,
        resetAfter: result.resetAfter,
        timestamp: new Date().toISOString(),
      }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (err: any) {
    console.error("Reddit handler error:", err);
    console.error("Stack trace:", err?.stack);

    const isRateLimited =
      err?.message?.includes("rate limit") ||
      err?.message?.includes("too many requests") ||
      err?.message?.includes("429");

    return new Response(
      JSON.stringify({
        ok: false,
        error: String(err?.message || err),
        isRateLimited,
        solution: isRateLimited
          ? "Reddit is rate limiting your requests. Please wait 5-10 minutes and try again."
          : "Check your Reddit API credentials and ensure your app is properly registered.",
        stack: err?.stack,
        envCheck: {
          hasRedditClientId: !!process.env.REDDIT_CLIENT_ID,
          hasRedditClientSecret: !!process.env.REDDIT_CLIENT_SECRET,
          hasRedditUsername: !!process.env.REDDIT_USERNAME,
          hasRedditPassword: !!process.env.REDDIT_PASSWORD,
          hasGeminiApiKey: !!process.env.GEMINI_API_KEY,
          hasOpenRouterApiKey: !!process.env.OPENROUTER_API_KEY,
        },
      }),
      {
        status: isRateLimited ? 429 : 500,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}

// POST endpoint to analyze and process a specific Reddit post
export async function POST(request: NextRequest) {
  if (!verifyAppToken(request)) return unauthorizedResponse();
  try {
    const { postId } = await request.json();

    if (!postId) {
      return new Response(
        JSON.stringify({ ok: false, error: "Post ID is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    console.log(`Analyzing Reddit post: ${postId}`);

    const token = await getAccessToken();
    const postResponse = await redditGet(
      `/r/PhotoshopRequest/comments/${postId}`,
      token,
    );

    if (!postResponse || postResponse.length === 0) {
      return new Response(
        JSON.stringify({ ok: false, error: "Post not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }

    const post = postResponse[0].data.children[0].data;

    let imageUrl = post.url;

    if (post.is_gallery && post.media_metadata) {
      const firstImageId = Object.keys(post.media_metadata)[0];
      const meta = post.media_metadata[firstImageId];
      if (meta && meta.status === "valid") {
        const ext =
          (meta.m || "image/jpg").split("/")[1] === "png" ? "png" : "jpg";
        imageUrl = `https://i.redd.it/${firstImageId}.${ext}`;
      } else if (meta?.s?.u) {
        imageUrl = meta.s.u.replace(/&amp;/g, "&");
      }
    } else if (
      post.preview &&
      post.preview.images &&
      post.preview.images.length > 0
    ) {
      const previewImage = post.preview.images[0];
      const previewUrl = previewImage.source?.url?.replace(/&amp;/g, "&") || "";
      const idMatch = previewUrl.match(
        /preview\.redd\.it\/([a-zA-Z0-9]+)\.(jpg|jpeg|png|gif|webp)/,
      );
      if (idMatch) {
        imageUrl = `https://i.redd.it/${idMatch[1]}.${idMatch[2]}`;
      } else if (previewImage.source?.url) {
        imageUrl = previewUrl;
      }
    }

    const postData = {
      title: post.title,
      description: post.selftext || post.title,
      imageUrl: imageUrl,
    };

    console.log("Analyzing post with Vertex AI...");

    const analysisResult = await analyzeRedditPost(postData);

    console.log("Generated concise analysis prompt:", analysisResult.analysis);

    return new Response(
      JSON.stringify({
        ok: true,
        postId: postId,
        originalPost: postData,
        analysis: analysisResult.analysis,
        timestamp: new Date().toISOString(),
      }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (err: any) {
    console.error("Reddit post analysis error:", err);
    return new Response(
      JSON.stringify({
        ok: false,
        error: String(err?.message || err),
        postId: null,
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}

// Dedicated analysis endpoint using Vertex AI Gemini 2.5 Flash
export async function PUT(request: NextRequest) {
  if (!verifyAppToken(request)) return unauthorizedResponse();
  try {
    const {
      title,
      description,
      imageUrl,
      allImages,
      aiPolicy: rawAiPolicy,
    } = await request.json();

    if (!imageUrl) {
      return new Response(
        JSON.stringify({ ok: false, error: "Image URL is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const aiPolicy = rawAiPolicy || "unknown";

    // Build list of unique image URLs — main first, then references
    const imageUrls: string[] = [imageUrl];
    if (Array.isArray(allImages)) {
      for (const url of allImages) {
        if (url && url !== imageUrl && !imageUrls.includes(url)) {
          imageUrls.push(url);
        }
      }
    }

    console.log(
      `Analyzing with Gemini 2.5 Flash (${imageUrls.length} image(s))...`,
    );

    // Download all images in parallel
    const imageParts: { inlineData: { mimeType: string; data: string } }[] = [];
    for (const url of imageUrls) {
      try {
        const imageResponse = await fetch(url);
        if (!imageResponse.ok) continue;
        const imageBuffer = await imageResponse.arrayBuffer();
        const buf = Buffer.from(imageBuffer);
        const mimeType =
          buf[0] === 0x89
            ? "image/png"
            : buf[0] === 0x52
              ? "image/webp"
              : "image/jpeg";
        imageParts.push({
          inlineData: { mimeType, data: buf.toString("base64") },
        });
      } catch {
        console.error(`Failed to download image: ${url}`);
      }
    }

    if (imageParts.length === 0) {
      throw new Error("Failed to download any images");
    }

    const hasMultipleImages = imageParts.length > 1;

    const LANGUAGE_RULE = `LANGUAGE RULE: Do NOT use words like vape, cigarette, gun, weapon, knife, blood, drug, alcohol, nude, naked, smoke, smoking. Use neutral alternatives like "small object", "item", "beverage", "haze".`;

    const CATEGORY_INSTRUCTION = `

AFTER the editing instruction, on a NEW LINE, output a JSON object with classification:
{"edit_category": "<category>", "has_face_edit": true/false, "face_preservation": "strict"|"light"|"none"}

CATEGORIES (pick ONE):
- "remove_object" — Remove a person, object, or unwanted element
- "remove_background" — Remove or replace the background
- "enhance_beautify" — Improve quality, lighting, skin, beautification, unblur, sharpen, clear up, fix focus
- "restore_old_photo" — Fix old, damaged, or faded photo
- "face_swap" — Swap faces between people
- "add_object" — Add object/element to scene
- "color_correction" — Fix colors, skin tone, white balance
- "scene_change" — Change environment, season, weather
- "creative_fun" — Funny, creative, meme edits
- "text_edit" — Edit/add/remove text on image
- "composite_multi" — Combine multiple photos into one
- "body_modification" — Change pose, height, proportions, open/close eyes
- "professional_headshot" — Make professional portrait

has_face_edit = true ONLY when the edit directly modifies facial features (skin tone, eyes, face swap, beautify face, shadow on face, blemish removal). Removing a person or changing background = false.

face_preservation:
- "strict" = DEFAULT for any image with people. Faces must remain 100% recognizable. Use for: shadow removal on face, skin retouching, blemish removal, background swap, person removal, color correction, enhancement, body modification.
- "light" = Face may change somewhat. Use for: creative/meme edits on faces, age progression, artistic style transfer.
- "none" = No face preservation needed. Use for: images with no people, product/landscape/text edits.`;

    const aiPolicyRule =
      aiPolicy === "no_ai"
        ? "\n- CRITICAL — NO AI POLICY: The user explicitly forbids AI-generated looking results. Your prompt must describe the ABSOLUTE MINIMUM change possible. The result MUST look completely natural and unedited. Prefer clone/heal style edits over generative fills."
        : aiPolicy === "ai_ok"
          ? "\n- The user allows AI-generated content, but still keep edits minimal and focused only on what was asked."
          : "";

    const analysisPrompt = hasMultipleImages
      ? `You are an image-editing instruction writer. Read the user's request CAREFULLY and write a short editing instruction for an AI image editor.

YOUR #1 PRIORITY: Follow EXACTLY what the user asked for in their title and description. Do NOT invent, add, or hallucinate actions that the user did not request. If the user says "unblur" or "clear up" or "enhance", your instruction must be about enhancement — NOT about removing or adding objects.

USER REQUEST (THIS IS YOUR SOURCE OF TRUTH):
Title: "${title || "No title"}"
Description: "${description || "No description provided"}"

The FIRST image is the main image to edit. The other image(s) are reference images.

STRICT RULES:
- Your instruction MUST match the user's request. Re-read the title and description before writing.
- Describe the edit using VISUAL/SPATIAL terms. Instead of "my boyfriend" or "my friend", describe by position or appearance: "the person on the left", "the woman in the red dress".
- Output ONLY what the user asked for. Nothing extra. Do NOT add your own interpretation.
- Do NOT mention objects, people, or actions the user did not mention.
- Do NOT add quality improvements, color corrections, or sharpening unless the user asked for it.
- Maximum 3-6 sentences. Be specific and concise.

REFERENCE IMAGE RULES:
- DESCRIBE what the user wants from the reference in rich VISUAL detail (appearance, clothing, colors, features, pose, build).
- ALSO say "Use the second provided image as visual reference for [what]" so multi-image models can use it directly.
- NEVER just say "copy from the reference" without describing what's in it.
- For people: describe hair color/style, skin tone, build, clothing, glasses, facial hair in detail.${aiPolicyRule}

${LANGUAGE_RULE}
${CATEGORY_INSTRUCTION}`
      : `You are an image-editing instruction writer. Read the user's request CAREFULLY and write a short editing instruction for an AI image editor.

YOUR #1 PRIORITY: Follow EXACTLY what the user asked for in their title and description. Do NOT invent, add, or hallucinate actions that the user did not request. If the user says "unblur" or "clear up" or "enhance", your instruction must be about enhancement — NOT about removing or adding objects.

USER REQUEST (THIS IS YOUR SOURCE OF TRUTH):
Title: "${title || "No title"}"
Description: "${description || "No description provided"}"

STRICT RULES:
- Your instruction MUST match the user's request. Re-read the title and description before writing.
- Describe the edit using VISUAL/SPATIAL terms. Instead of "my boyfriend" or "my friend", describe by position or appearance: "the person on the left", "the woman in the red dress".
- Output ONLY what the user asked for. Nothing extra. Do NOT add your own interpretation.
- Do NOT mention objects, people, or actions the user did not mention.
- Do NOT add quality improvements, color corrections, or sharpening unless the user asked for it.
- Maximum 1-3 sentences. Be specific and concise.${aiPolicyRule}

${LANGUAGE_RULE}
${CATEGORY_INSTRUCTION}`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [{ text: analysisPrompt }, ...imageParts],
        },
      ],
    });

    const rawText =
      response.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";

    if (!rawText) {
      throw new Error("Analysis returned empty response");
    }

    // Parse: first line(s) = editing instruction, last line = JSON classification
    let changeSummary = rawText;
    let editCategory = "remove_object";
    let hasFaceEdit = false;
    let facePreservation: "strict" | "light" | "none" = "strict";

    const jsonMatch = rawText.match(/\{[^}]*"edit_category"[^}]*\}/);
    if (jsonMatch) {
      try {
        const classification = JSON.parse(jsonMatch[0]);
        editCategory = classification.edit_category || "remove_object";
        hasFaceEdit = classification.has_face_edit ?? false;
        if (["strict", "light", "none"].includes(classification.face_preservation)) {
          facePreservation = classification.face_preservation;
        }
        // Remove the JSON from the editing instruction
        changeSummary = rawText.replace(jsonMatch[0], "").trim();
      } catch {
        // Failed to parse classification JSON — keep defaults
      }
    }

    console.log(
      `Analysis complete [${editCategory}${hasFaceEdit ? " FACE" : ""} fp:${facePreservation}]:`,
      changeSummary,
    );

    return new Response(
      JSON.stringify({
        ok: true,
        changeSummary,
        editCategory,
        hasFaceEdit,
        facePreservation,
        imageCount: imageParts.length,
        timestamp: new Date().toISOString(),
      }),
      {
        headers: { "Content-Type": "application/json" },
      },
    );
  } catch (err: any) {
    console.error("Analysis error:", err);
    return new Response(
      JSON.stringify({
        ok: false,
        error: String(err?.message || err),
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
