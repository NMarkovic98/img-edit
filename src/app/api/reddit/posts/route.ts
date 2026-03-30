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

  const res = await fetch(TOKEN_URL, { method: "POST", headers, body });

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

  const res = await fetch(`${API_BASE}${path}`, {
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

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

// Parse a single RSS <entry> into a post object
function parseRSSEntry(entry: string, subreddit: string) {
  const get = (tag: string) => {
    const m = entry.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
    return m ? m[1].trim() : "";
  };

  const title = decodeEntities(get("title"));
  const link = entry.match(/<link[^>]*href="([^"]*)"[^>]*\/?>/)?.[1] || "";
  const id = link.match(/comments\/([a-z0-9]+)\//)?.[1] || "";
  const updated = get("updated");
  const author = entry.match(/<name>\/u\/([^<]*)<\/name>/)?.[1] || "";
  const category = entry.match(/<category[^>]*term="([^"]*)"[^>]*\/?>/)?.[1] || subreddit;

  // Content is HTML-entity encoded inside <content> — decode it to parse HTML
  const rawContent = get("content");
  const html = decodeEntities(rawContent);

  const created_utc = updated ? new Date(updated).getTime() / 1000 : 0;

  // Extract i.redd.it links first (full resolution), then fall back to preview thumbnails
  const images: string[] = [];

  // 1. Direct i.redd.it links from [link] anchors (best quality)
  const directLinkRegex = /href="(https?:\/\/i\.redd\.it\/[^"]+)"/g;
  let m;
  while ((m = directLinkRegex.exec(html)) !== null) {
    const url = m[1].replace(/&amp;/g, "&");
    if (!images.includes(url)) images.push(url);
  }

  // 2. <img> tags — convert preview.redd.it to i.redd.it
  const imgRegex = /<img[^>]*src="([^"]*)"[^>]*>/g;
  while ((m = imgRegex.exec(html)) !== null) {
    let src = m[1].replace(/&amp;/g, "&");
    const previewMatch = src.match(/preview\.redd\.it\/([a-zA-Z0-9]+)\.(jpg|jpeg|png|gif|webp)/);
    if (previewMatch) {
      src = `https://i.redd.it/${previewMatch[1]}.${previewMatch[2]}`;
    }
    if (!images.includes(src) && (src.includes("i.redd.it") || src.includes("i.imgur.com"))) {
      images.push(src);
    }
  }

  // 3. media:thumbnail as last resort
  if (images.length === 0) {
    const thumbMatch = entry.match(/<media:thumbnail[^>]*url="([^"]*)"[^>]*\/?>/);
    if (thumbMatch) {
      let src = decodeEntities(thumbMatch[1]);
      const previewMatch = src.match(/preview\.redd\.it\/([a-zA-Z0-9]+)\.(jpg|jpeg|png|gif|webp)/);
      if (previewMatch) {
        src = `https://i.redd.it/${previewMatch[1]}.${previewMatch[2]}`;
      }
      images.push(src);
    }
  }

  // Extract description (strip HTML tags)
  const description = html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const isPaid = title.toLowerCase().includes("[paid]") || description.toLowerCase().includes("will tip") || description.toLowerCase().includes("$");

  if (images.length === 0 || !id) return null;

  return {
    id,
    title,
    description: description || title,
    imageUrl: images[0],
    allImages: images,
    isGallery: images.length > 1,
    imageCount: images.length,
    postUrl: link,
    created_utc,
    created_date: new Date(created_utc * 1000).toISOString(),
    author,
    score: 0,
    num_comments: 0,
    subreddit: category,
    thumbnail: images[0],
    upvote_ratio: 0,
    flair: null,
    isPaid,
  };
}

// Fetch posts via Reddit RSS feed (less aggressive rate limiting than JSON API)
async function fetchPostsViaRSS(
  subreddits: string[] = ["PhotoshopRequest"],
) {
  const multiSub = subreddits.join("+");
  console.log(`Fetching RSS: r/${multiSub}/new.rss`);

  const res = await fetch(
    `https://www.reddit.com/r/${multiSub}/new.rss?limit=100`,
    {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
        Accept: "application/atom+xml,application/xml,text/xml,*/*",
      },
      cache: "no-store",
    },
  );

  if (res.status === 429) {
    throw new Error(`Reddit RSS rate limit — reset in ${res.headers.get("x-ratelimit-reset") || "60"}s`);
  }

  if (!res.ok) {
    throw new Error(`Reddit RSS error: ${res.status}`);
  }

  const xml = await res.text();

  // Split into entries
  const entries = xml.split("<entry>").slice(1); // skip the feed header
  const thirtyMinAgo = Date.now() / 1000 - 30 * 60;

  const posts = entries
    .map((entry) => parseRSSEntry(entry, subreddits[0]))
    .filter((p): p is NonNullable<typeof p> => p !== null && p.created_utc > thirtyMinAgo);

  console.log(`Parsed ${posts.length} image posts from RSS (${entries.length} entries total)`);
  return posts;
}

export async function GET(_req: NextRequest) {
  if (!verifyAppToken(_req)) return unauthorizedResponse();
  try {
    const url = new URL(_req.url);
    const subredditParam = url.searchParams.get("subreddits");
    const subreddits = subredditParam
      ? subredditParam.split(",").map((s) => s.trim())
      : ["PhotoshopRequest"];

    const posts = await fetchPostsViaRSS(subreddits);
    posts.sort((a: any, b: any) => b.created_utc - a.created_utc);
    console.log(`Found ${posts.length} image posts`);

    return new Response(
      JSON.stringify({
        ok: true,
        posts,
        total: posts.length,
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
    const { title, description, imageUrl, allImages } = await request.json();

    if (!imageUrl) {
      return new Response(
        JSON.stringify({ ok: false, error: "Image URL is required" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

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

    const analysisPrompt = hasMultipleImages
      ? `Look at the image(s) and the user's request. Write a short editing instruction for an image-editing AI.

USER REQUEST:
Title: "${title || "No title"}"
Description: "${description || "No description provided"}"

The FIRST image is the main image. The other image(s) are references.

STRICT RULES:
- Describe the edit using VISUAL/SPATIAL terms based on what you SEE in the image. The image editor cannot understand relationships like "my boyfriend", "my friend", "my ex". Instead describe by position or appearance: "the person on the left", "the hand on the woman's chest", "the person standing behind".
- Output ONLY what the user asked for. Nothing extra.
- Do NOT add quality improvements, color corrections, sharpening, or any enhancement.
- Do NOT mention faces, expressions, lighting, or composition unless the user did.
- If using a reference, say ONLY what the user wants copied from it.
- Maximum 1-2 sentences. Shorter is better.

${LANGUAGE_RULE}

Return ONLY the editing instruction.`
      : `Look at the image and the user's request. Write a short editing instruction for an image-editing AI.

USER REQUEST:
Title: "${title || "No title"}"
Description: "${description || "No description provided"}"

STRICT RULES:
- Describe the edit using VISUAL/SPATIAL terms based on what you SEE in the image. The image editor cannot understand relationships like "my boyfriend", "my friend", "my ex". Instead describe by position or appearance: "the person on the left", "the hand on the woman's chest", "the person standing behind".
- Output ONLY what the user asked for. Nothing extra.
- Do NOT add quality improvements, color corrections, sharpening, or any enhancement.
- Do NOT mention faces, expressions, lighting, or composition unless the user did.
- Maximum 1-2 sentences. Shorter is better.

${LANGUAGE_RULE}

Return ONLY the editing instruction.`;

    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        {
          role: "user",
          parts: [{ text: analysisPrompt }, ...imageParts],
        },
      ],
    });

    const changeSummary =
      response.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";

    if (!changeSummary) {
      throw new Error("Analysis returned empty response");
    }

    console.log("Analysis complete:", changeSummary);

    return new Response(
      JSON.stringify({
        ok: true,
        changeSummary,
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
