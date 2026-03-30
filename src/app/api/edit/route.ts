// src/app/api/edit/route.ts
export const runtime = "nodejs";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { fal } from "@fal-ai/client";
import { verifyAppToken, unauthorizedResponse } from "@/lib/auth";

fal.config({
  credentials: process.env.FAL_KEY!,
});

// ---------------------------------------------------------------------------
// Resolution tiers
// ---------------------------------------------------------------------------
type Tier = "SD" | "HD" | "FHD" | "2K" | "4K+";

function detectTier(w: number, h: number): Tier {
  const max = Math.max(w, h);
  if (max >= 4097) return "4K+";
  if (max >= 2560) return "2K";
  if (max >= 1920) return "FHD";
  if (max >= 1280) return "HD";
  return "SD";
}

// ---------------------------------------------------------------------------
// Model configs — each returns { modelId, input }
// ---------------------------------------------------------------------------
interface ModelChoice {
  modelId: string;
  name: string;
  input: Record<string, unknown>;
}

function gptImage15(
  prompt: string,
  imageUrls: string[],
  dims: { width: number; height: number },
): ModelChoice {
  const isLandscape = dims.width > dims.height;
  const isSquare = Math.abs(dims.width - dims.height) < 100;
  const imageSize = isSquare
    ? "1024x1024"
    : isLandscape
      ? "1536x1024"
      : "1024x1536";

  return {
    modelId: "fal-ai/gpt-image-1.5/edit",
    name: "GPT Image 1.5",
    input: {
      prompt,
      image_urls: imageUrls,
      image_size: imageSize,
      quality: "high",
      num_images: 1,
    },
  };
}

function nanoBananaPro(
  prompt: string,
  imageUrls: string[],
  resolution: "1K" | "2K" | "4K",
): ModelChoice {
  return {
    modelId: "fal-ai/nano-banana-pro/edit",
    name: `Nano Banana Pro (${resolution})`,
    input: {
      prompt,
      image_urls: imageUrls,
      num_images: 1,
      resolution,
      output_format: "png",
      safety_tolerance: "6",
    },
  };
}

function seedream45(
  prompt: string,
  imageUrls: string[],
  sizePreset: "auto_2K" | "auto_4K",
): ModelChoice {
  return {
    modelId: "fal-ai/bytedance/seedream/v4.5/edit",
    name: `Seedream v4.5 (${sizePreset})`,
    input: {
      prompt,
      image_urls: imageUrls,
      image_size: sizePreset,
      num_images: 1,
    },
  };
}

function flux2Pro(
  prompt: string,
  imageUrls: string[],
  dims: { width: number; height: number },
): ModelChoice {
  return {
    modelId: "fal-ai/flux-2-pro/edit",
    name: "FLUX 2 Pro",
    input: {
      prompt,
      image_urls: imageUrls,
      image_size: { width: dims.width, height: dims.height },
      num_images: 1,
    },
  };
}

// ---------------------------------------------------------------------------
// Smart model selector — returns [primary, ...fallbacks]
// ---------------------------------------------------------------------------
function selectModels(
  prompt: string,
  imageUrls: string[],
  dims: { width: number; height: number },
): ModelChoice[] {
  const tier = detectTier(dims.width, dims.height);

  switch (tier) {
    case "SD":
      // GPT Image 1.5 primary (great quality at low res), Nano Banana Pro 1K fallback
      return [
        gptImage15(prompt, imageUrls, dims),
        nanoBananaPro(prompt, imageUrls, "1K"),
      ];

    case "HD":
      // Nano Banana Pro 2K — solid at this range
      return [nanoBananaPro(prompt, imageUrls, "2K")];

    case "FHD":
      // Seedream v4.5 auto_2K primary ($0.04 flat), Nano Banana Pro 2K fallback
      return [
        seedream45(prompt, imageUrls, "auto_2K"),
        nanoBananaPro(prompt, imageUrls, "2K"),
      ];

    case "2K":
      // Seedream v4.5 auto_4K primary ($0.04 flat), Nano Banana Pro 4K fallback
      return [
        seedream45(prompt, imageUrls, "auto_4K"),
        nanoBananaPro(prompt, imageUrls, "4K"),
      ];

    case "4K+":
      // FLUX 2 Pro (only model that supports >4096px), Nano Banana Pro 4K fallback
      return [
        flux2Pro(prompt, imageUrls, dims),
        nanoBananaPro(prompt, imageUrls, "4K"),
      ];
  }
}

// ---------------------------------------------------------------------------
// Override resolver — maps UI model IDs to a specific ModelChoice
// ---------------------------------------------------------------------------
function resolveOverride(
  overrideId: string,
  prompt: string,
  imageUrls: string[],
  dims: { width: number; height: number },
): ModelChoice | null {
  switch (overrideId) {
    case "gpt-image":
      return gptImage15(prompt, imageUrls, dims);
    case "nano-banana-1k":
      return nanoBananaPro(prompt, imageUrls, "1K");
    case "nano-banana-2k":
      return nanoBananaPro(prompt, imageUrls, "2K");
    case "nano-banana-4k":
      return nanoBananaPro(prompt, imageUrls, "4K");
    case "seedream-2k":
      return seedream45(prompt, imageUrls, "auto_2K");
    case "seedream-4k":
      return seedream45(prompt, imageUrls, "auto_4K");
    case "flux-2-pro":
      return flux2Pro(prompt, imageUrls, dims);
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Image dimension detection from raw bytes (JPEG, PNG, WebP)
// ---------------------------------------------------------------------------
function getImageDimensions(buf: Buffer): { width: number; height: number } {
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset < buf.length - 8) {
      if (buf[offset] !== 0xff) { offset++; continue; }
      const marker = buf[offset + 1];
      if (marker >= 0xc0 && marker <= 0xc3) {
        return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
      }
      offset += 2 + buf.readUInt16BE(offset + 2);
    }
  }
  // WebP
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) {
    if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x58) {
      return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
    }
    if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x4c) {
      const bits = buf.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x20) {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
    }
  }
  return { width: 1024, height: 1024 };
}

// ---------------------------------------------------------------------------
// Call a single model via fal.ai
// ---------------------------------------------------------------------------
async function callModel(choice: ModelChoice): Promise<string> {
  console.log(`[edit] Calling ${choice.name} (${choice.modelId})...`);

  const result = await fal.subscribe(choice.modelId, {
    input: choice.input as any,
    logs: true,
    onQueueUpdate: (update) => {
      if (update.status === "IN_PROGRESS" && "logs" in update) {
        update.logs?.map((log) => log.message).forEach((msg) => console.log(`[${choice.name}]`, msg));
      }
    },
  });

  const images = result.data?.images;
  if (!images || images.length === 0) {
    throw new Error(`${choice.name} returned no images`);
  }
  return images[0].url;
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  if (!verifyAppToken(request)) return unauthorizedResponse();
  try {
    const { imageUrl, changeSummary, allImages, modelOverride } = await request.json();

    if (!imageUrl || !changeSummary) {
      return NextResponse.json(
        { error: "Image URL and change summary are required" },
        { status: 400 },
      );
    }

    console.log("[edit] Starting smart edit...");
    console.log("[edit] Prompt:", changeSummary);

    // Build unique image URLs list — main first, then references
    const imageUrls: string[] = [imageUrl];
    if (Array.isArray(allImages)) {
      for (const url of allImages) {
        if (url && url !== imageUrl && !imageUrls.includes(url)) {
          imageUrls.push(url);
        }
      }
    }

    console.log(`[edit] ${imageUrls.length} image(s)`);

    // Detect main image dimensions
    let mainDims = { width: 1024, height: 1024 };
    try {
      const res = await fetch(imageUrl, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        mainDims = getImageDimensions(buf);
      }
    } catch {
      console.warn("[edit] Could not detect image dimensions, defaulting 1024x1024");
    }

    const tier = detectTier(mainDims.width, mainDims.height);
    console.log(`[edit] Input: ${mainDims.width}x${mainDims.height} → tier: ${tier}`);

    // Build prompt
    const hasReferences = imageUrls.length > 1;
    let prompt: string;
    if (hasReferences) {
      prompt = `Edit the FIRST image using the other image(s) as reference.\n\n${changeSummary}\n\nDo not change any other elements of the image. Do not alter faces, expressions, skin, hair, clothing, background, or any detail not mentioned above.`;
    } else {
      prompt = `${changeSummary}\n\nDo not change any other elements of the image. Do not alter faces, expressions, skin, hair, clothing, background, or any detail not mentioned above.`;
    }

    // Select models: user override or smart auto-select
    let models: ModelChoice[];
    if (modelOverride) {
      const overridden = resolveOverride(modelOverride, prompt, imageUrls, mainDims);
      if (overridden) {
        // User chose a specific model — use it as primary, keep smart fallback
        const smartModels = selectModels(prompt, imageUrls, mainDims);
        const fallbacks = smartModels.filter((m) => m.modelId !== overridden.modelId);
        models = [overridden, ...fallbacks];
        console.log(`[edit] User override: ${overridden.name}`);
      } else {
        models = selectModels(prompt, imageUrls, mainDims);
      }
    } else {
      models = selectModels(prompt, imageUrls, mainDims);
    }
    console.log(`[edit] Model chain: ${models.map((m) => m.name).join(" → ")}`);

    // Try each model in order
    let editedUrl: string | null = null;
    let usedModel = "";
    for (const model of models) {
      try {
        editedUrl = await callModel(model);
        usedModel = model.name;
        break;
      } catch (err) {
        console.error(`[edit] ${model.name} failed:`, err instanceof Error ? err.message : err);
        if (model === models[models.length - 1]) {
          throw err; // last model, rethrow
        }
        console.log("[edit] Trying fallback...");
      }
    }

    if (!editedUrl) {
      throw new Error("All models failed");
    }

    console.log(`[edit] Success via ${usedModel}! Output: ${editedUrl}`);

    return NextResponse.json({
      ok: true,
      edited: editedUrl,
      method: "fal_ai",
      model: usedModel,
      tier,
      hasImageData: true,
      generatedImages: [editedUrl],
      originalDimensions: mainDims,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[edit] Error:", error);
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : "Failed to execute edit",
        timestamp: new Date().toISOString(),
      },
      { status: 500 },
    );
  }
}
