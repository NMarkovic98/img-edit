// src/app/api/reddit/posts/route.ts
export const runtime = "nodejs"; // ensure Node runtime (Buffer required)

import type { NextRequest } from "next/server";
import { GoogleGenAI } from "@google/genai";

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

// In-memory cache to avoid hammering Reddit
let postsCache: { posts: any[]; timestamp: number } = {
  posts: [],
  timestamp: 0,
};
const CACHE_TTL_MS = 25000; // 25 seconds — slightly less than the 30s refresh interval

// Fetch posts via Reddit's public JSON API using multi-subreddit endpoint (1 request for all)
async function fetchPostsViaPublicAPI(
  subreddits: string[] = ["PhotoshopRequest"],
) {
  // Return cached data if fresh enough
  const now = Date.now();
  if (
    postsCache.posts.length > 0 &&
    now - postsCache.timestamp < CACHE_TTL_MS
  ) {
    console.log(
      `Returning cached posts (${postsCache.posts.length} posts, ${Math.round((now - postsCache.timestamp) / 1000)}s old)`,
    );
    // Still filter by selected subreddits from the cache
    const subSet = new Set(subreddits.map((s) => s.toLowerCase()));
    const filtered = postsCache.posts.filter((p: any) =>
      subSet.has((p.subreddit || "").toLowerCase()),
    );
    return processRawPosts(filtered);
  }

  // Use multi-subreddit endpoint: r/sub1+sub2+sub3/new.json — ONE request
  const multiSub = subreddits.join("+");
  console.log(
    `Fetching from r/${multiSub}/new.json (single request for ${subreddits.length} subreddits)`,
  );

  try {
    const res = await fetch(
      `https://www.reddit.com/r/${multiSub}/new.json?limit=100&raw_json=1`,
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

    if (res.status === 429) {
      const resetAfter = parseInt(
        res.headers.get("x-ratelimit-reset") || "60",
        10,
      );
      console.warn(
        `Rate limited, reset in ${resetAfter}s. Returning cached data.`,
      );
      // Return stale cache instead of nothing
      if (postsCache.posts.length > 0) {
        const subSet = new Set(subreddits.map((s) => s.toLowerCase()));
        const filtered = postsCache.posts.filter((p: any) =>
          subSet.has((p.subreddit || "").toLowerCase()),
        );
        return processRawPosts(filtered);
      }
      return [];
    }

    if (!res.ok) {
      console.error(`Reddit public API error: ${res.status}`);
      return postsCache.posts.length > 0
        ? processRawPosts(postsCache.posts)
        : [];
    }

    const data = await res.json();
    const allPosts = data.data.children.map((child: any) => child.data);

    // Update cache
    postsCache = { posts: allPosts, timestamp: Date.now() };
    console.log(`Fetched ${allPosts.length} posts from Reddit`);

    return processRawPosts(allPosts);
  } catch (err) {
    console.error("Reddit fetch error:", err);
    // Return stale cache on error
    return postsCache.posts.length > 0 ? processRawPosts(postsCache.posts) : [];
  }
}

function processRawPosts(allPosts: any[]) {
  const posts = allPosts;

  const thirtyMinAgo = Date.now() / 1000 - 30 * 60;

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

  return posts
    .filter((post: any) => {
      const hasImage =
        post.url &&
        (post.url.match(/\.(jpg|jpeg|png|gif|webp)$/i) ||
          post.url.includes("i.redd.it") ||
          post.url.includes("i.imgur.com") ||
          post.url.includes("redditmedia") ||
          (post.preview &&
            post.preview.images &&
            post.preview.images.length > 0));
      const isGallery = post.is_gallery === true && post.media_metadata;
      const hasSelfPostImages =
        post.is_self &&
        post.media_metadata &&
        Object.keys(post.media_metadata).length > 0;
      const isRecent = post.created_utc > thirtyMinAgo;
      return (hasImage || isGallery || hasSelfPostImages) && isRecent;
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
      const isPaid =
        flair.includes("paid") || post.title.toLowerCase().includes("[paid]");

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
      };
    });
}

export async function GET(_req: NextRequest) {
  try {
    const url = new URL(_req.url);
    const subredditParam = url.searchParams.get("subreddits");
    const subreddits = subredditParam
      ? subredditParam.split(",").map((s) => s.trim())
      : ["PhotoshopRequest"];

    const hasRedditCredentials =
      process.env.REDDIT_CLIENT_ID &&
      process.env.REDDIT_CLIENT_SECRET &&
      process.env.REDDIT_USERNAME &&
      process.env.REDDIT_PASSWORD;

    if (!hasRedditCredentials) {
      console.log(
        `Reddit credentials not configured, using public JSON API for: ${subreddits.join(", ")}`,
      );
      const publicPosts = await fetchPostsViaPublicAPI(subreddits);
      publicPosts.sort((a: any, b: any) => b.created_utc - a.created_utc);
      console.log(`Found ${publicPosts.length} image posts via public API`);
      return new Response(
        JSON.stringify({
          ok: true,
          posts: publicPosts,
          total: publicPosts.length,
          timestamp: new Date().toISOString(),
          source: "public",
        }),
        {
          headers: { "Content-Type": "application/json" },
        },
      );
    }

    console.log("Starting Reddit GET request...");
    const token = await getAccessToken();
    console.log("Token obtained, fetching posts...");

    const response = await redditGet("/r/PhotoshopRequest/new?limit=50", token);
    console.log("Reddit API response received successfully");

    const posts = response.data.children.map((child: any) => child.data);

    const thirtyMinAgo = Date.now() / 1000 - 30 * 60;

    const imagePosts = posts
      .filter((post: any) => {
        const hasImage =
          post.url &&
          (post.url.match(/\.(jpg|jpeg|png|gif|webp)$/i) ||
            post.url.includes("i.redd.it") ||
            post.url.includes("i.imgur.com") ||
            post.url.includes("redditmedia") ||
            (post.preview &&
              post.preview.images &&
              post.preview.images.length > 0));

        const isRecent = post.created_utc > thirtyMinAgo;

        return hasImage && isRecent;
      })
      .map((post: any) => {
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
          post.crosspost_parent_list &&
          post.crosspost_parent_list.length > 0
        ) {
          const originalPost = post.crosspost_parent_list[0];
          if (
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

        const flair = (post.link_flair_text || "").toLowerCase();
        const isPaid =
          flair.includes("paid") || post.title.toLowerCase().includes("[paid]");

        return {
          id: post.id,
          title: post.title,
          description: post.selftext || post.title,
          imageUrl: imageUrl,
          allImages: [imageUrl],
          isGallery: false,
          imageCount: 1,
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
        };
      });

    console.log(
      `Found ${imagePosts.length} image posts from r/PhotoshopRequest in the last 24 hours`,
    );

    return new Response(
      JSON.stringify({
        ok: true,
        posts: imagePosts,
        total: imagePosts.length,
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
          ? "Reddit is rate limiting your requests. Please wait 5-10 minutes and try again. If this persists, consider using a different IP or implementing longer delays between requests."
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
