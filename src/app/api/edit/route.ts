// src/app/api/edit/route.ts
export const runtime = "nodejs";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { fal } from "@fal-ai/client";
import { verifyAppToken, unauthorizedResponse } from "@/lib/auth";
import type { EditCategory } from "@/types";
import { CATEGORY_MODEL_MAP, FACE_SAFE_MODELS } from "@/types";

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

// --- FLUX Kontext [pro] — best for local edits, face-safe ---
function fluxKontextPro(prompt: string, imageUrl: string): ModelChoice {
  return {
    modelId: "fal-ai/flux-pro/kontext",
    name: "FLUX Kontext Pro",
    input: {
      prompt,
      image_url: imageUrl,
    },
  };
}

// --- FLUX Kontext [max] — premium prompt adherence + typography ---
function fluxKontextMax(prompt: string, imageUrl: string): ModelChoice {
  return {
    modelId: "fal-ai/flux-pro/kontext/max",
    name: "FLUX Kontext Max",
    input: {
      prompt,
      image_url: imageUrl,
    },
  };
}

// --- FLUX.2 [pro] Edit — production-grade photorealism, multi-ref ---
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

// --- Nano Banana 2 (Gemini 3.1 Flash) — compositing king, up to 14 refs ---
function nanoBanana2(
  prompt: string,
  imageUrls: string[],
  resolution: "1K" | "2K" | "4K" = "1K",
): ModelChoice {
  return {
    modelId: "fal-ai/nano-banana-2/edit",
    name: `Nano Banana 2 (${resolution})`,
    input: {
      prompt,
      image_urls: imageUrls,
      num_images: 1,
      resolution,
      output_format: "png",
    },
  };
}

// --- Nano Banana Pro (Gemini 3 Pro) — deep reasoning, expensive ---
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

// --- Seedream 5.0 Lite — high-res scene editing, cheap ---
function seedream5Lite(prompt: string, imageUrls: string[]): ModelChoice {
  return {
    modelId: "fal-ai/bytedance/seedream/v5/lite/edit",
    name: "Seedream 5.0 Lite",
    input: {
      prompt,
      image_urls: imageUrls,
      num_images: 1,
    },
  };
}

// --- Bria RMBG 2.0 — background removal specialist ---
function briaBgRemove(imageUrl: string): ModelChoice {
  return {
    modelId: "fal-ai/bria/background/remove",
    name: "Bria RMBG 2.0",
    input: {
      image_url: imageUrl,
    },
  };
}

// --- SeedVR2 Upscale — post-edit resolution recovery ---
function seedvrUpscale(imageUrl: string, scale: 2 | 4 = 2): ModelChoice {
  return {
    modelId: "fal-ai/seedvr/upscale/image",
    name: `SeedVR2 Upscale (${scale}x)`,
    input: {
      image_url: imageUrl,
      scale,
    },
  };
}

// ---------------------------------------------------------------------------
// Resolution-aware Nano Banana resolution picker
// ---------------------------------------------------------------------------
function pickNanaBananaRes(w: number, h: number): "1K" | "2K" | "4K" {
  const max = Math.max(w, h);
  if (max >= 3840) return "4K";
  if (max >= 1920) return "2K";
  return "1K";
}

// ---------------------------------------------------------------------------
// Category-aware smart model selector
// ---------------------------------------------------------------------------
function buildModelForId(
  modelId: string,
  prompt: string,
  imageUrl: string,
  imageUrls: string[],
  dims: { width: number; height: number },
): ModelChoice {
  const nbRes = pickNanaBananaRes(dims.width, dims.height);

  switch (modelId) {
    case "fal-ai/flux-pro/kontext":
      return fluxKontextPro(prompt, imageUrl);
    case "fal-ai/flux-pro/kontext/max":
      return fluxKontextMax(prompt, imageUrl);
    case "fal-ai/flux-2-pro/edit":
      return flux2Pro(prompt, imageUrls, dims);
    case "fal-ai/nano-banana-2/edit":
      return nanoBanana2(prompt, imageUrls, nbRes);
    case "fal-ai/nano-banana-pro/edit":
      return nanoBananaPro(prompt, imageUrls, nbRes);
    case "fal-ai/bytedance/seedream/v5/lite/edit":
      return seedream5Lite(prompt, imageUrls);
    case "bria-bg-remove":
      return briaBgRemove(imageUrl);
    default:
      // Fallback to Kontext Pro
      return fluxKontextPro(prompt, imageUrl);
  }
}

function selectModelsForCategory(
  category: EditCategory,
  hasFaceEdit: boolean,
  prompt: string,
  imageUrl: string,
  imageUrls: string[],
  dims: { width: number; height: number },
): ModelChoice[] {
  const modelIds = [...CATEGORY_MODEL_MAP[category]];

  // Face-safe guard: if edit touches faces, filter out unsafe models
  const safeIds = hasFaceEdit
    ? modelIds.filter(
        (id) =>
          (FACE_SAFE_MODELS as readonly string[]).includes(id) ||
          id === "bria-bg-remove",
      )
    : modelIds;

  // If all filtered out, use FLUX Kontext Pro as safe default
  const finalIds = safeIds.length > 0 ? safeIds : ["fal-ai/flux-pro/kontext"];

  return finalIds.map((id) =>
    buildModelForId(id, prompt, imageUrl, imageUrls, dims),
  );
}

// ---------------------------------------------------------------------------
// Legacy model override resolver (backward compat with queue-view)
// ---------------------------------------------------------------------------
function resolveOverride(
  overrideId: string,
  prompt: string,
  imageUrl: string,
  imageUrls: string[],
  dims: { width: number; height: number },
): ModelChoice | null {
  switch (overrideId) {
    case "kontext-pro":
      return fluxKontextPro(prompt, imageUrl);
    case "kontext-max":
      return fluxKontextMax(prompt, imageUrl);
    case "flux-2-pro":
      return flux2Pro(prompt, imageUrls, dims);
    case "nano-banana-2":
      return nanoBanana2(
        prompt,
        imageUrls,
        pickNanaBananaRes(dims.width, dims.height),
      );
    case "nano-banana-pro":
      return nanoBananaPro(
        prompt,
        imageUrls,
        pickNanaBananaRes(dims.width, dims.height),
      );
    case "seedream-5-lite":
      return seedream5Lite(prompt, imageUrls);
    case "bria-bg-remove":
      return briaBgRemove(imageUrl);
    // Legacy IDs
    case "gpt-image":
      return fluxKontextPro(prompt, imageUrl); // Replaced GPT with Kontext
    case "nano-banana-1k":
      return nanoBananaPro(prompt, imageUrls, "1K");
    case "nano-banana-2k":
      return nanoBananaPro(prompt, imageUrls, "2K");
    case "nano-banana-4k":
      return nanoBananaPro(prompt, imageUrls, "4K");
    case "seedream-2k":
    case "seedream-4k":
      return seedream5Lite(prompt, imageUrls);
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
      if (buf[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buf[offset + 1];
      if (marker >= 0xc0 && marker <= 0xc3) {
        return {
          height: buf.readUInt16BE(offset + 5),
          width: buf.readUInt16BE(offset + 7),
        };
      }
      offset += 2 + buf.readUInt16BE(offset + 2);
    }
  }
  // WebP
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46
  ) {
    if (
      buf[12] === 0x56 &&
      buf[13] === 0x50 &&
      buf[14] === 0x38 &&
      buf[15] === 0x58
    ) {
      return {
        width: buf.readUIntLE(24, 3) + 1,
        height: buf.readUIntLE(27, 3) + 1,
      };
    }
    if (
      buf[12] === 0x56 &&
      buf[13] === 0x50 &&
      buf[14] === 0x38 &&
      buf[15] === 0x4c
    ) {
      const bits = buf.readUInt32LE(21);
      return {
        width: (bits & 0x3fff) + 1,
        height: ((bits >> 14) & 0x3fff) + 1,
      };
    }
    if (
      buf[12] === 0x56 &&
      buf[13] === 0x50 &&
      buf[14] === 0x38 &&
      buf[15] === 0x20
    ) {
      return {
        width: buf.readUInt16LE(26) & 0x3fff,
        height: buf.readUInt16LE(28) & 0x3fff,
      };
    }
  }
  return { width: 1024, height: 1024 };
}

// ---------------------------------------------------------------------------
// Call a single model via fal.ai
// ---------------------------------------------------------------------------
async function callModel(
  choice: ModelChoice,
): Promise<{ url: string; width?: number; height?: number }> {
  console.log(`[edit] Calling ${choice.name} (${choice.modelId})...`);

  const result = await fal.subscribe(choice.modelId, {
    input: choice.input as any,
    logs: true,
    onQueueUpdate: (update) => {
      if (update.status === "IN_PROGRESS" && "logs" in update) {
        update.logs
          ?.map((log) => log.message)
          .forEach((msg) => console.log(`[${choice.name}]`, msg));
      }
    },
  });

  // Bria returns { image: { url } }, most others return { images: [{ url, width, height }] }
  if (result.data?.image?.url) {
    return {
      url: result.data.image.url,
      width: result.data.image.width,
      height: result.data.image.height,
    };
  }

  const images = result.data?.images;
  if (!images || images.length === 0) {
    throw new Error(`${choice.name} returned no images`);
  }
  return {
    url: images[0].url,
    width: images[0].width,
    height: images[0].height,
  };
}

// ---------------------------------------------------------------------------
// Upscale if output is smaller than input (Golden Rule)
// ---------------------------------------------------------------------------
async function ensureResolution(
  editedUrl: string,
  editedDims: { width?: number; height?: number } | undefined,
  originalDims: { width: number; height: number },
): Promise<{ url: string; upscaled: boolean }> {
  // If we don't know edited dims, fetch and check
  let ew = editedDims?.width;
  let eh = editedDims?.height;

  if (!ew || !eh) {
    try {
      const res = await fetch(editedUrl, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        const dims = getImageDimensions(buf);
        ew = dims.width;
        eh = dims.height;
      }
    } catch {
      // Can't check — skip upscale
      return { url: editedUrl, upscaled: false };
    }
  }

  if (!ew || !eh) return { url: editedUrl, upscaled: false };

  const originalPixels = originalDims.width * originalDims.height;
  const editedPixels = ew * eh;

  // Only upscale if edited is significantly smaller (>20% fewer pixels)
  if (editedPixels < originalPixels * 0.8) {
    const scale = editedPixels < originalPixels * 0.25 ? 4 : 2;
    console.log(
      `[edit] Output ${ew}x${eh} < original ${originalDims.width}x${originalDims.height}, upscaling ${scale}x via SeedVR2`,
    );

    try {
      const upscaleChoice = seedvrUpscale(editedUrl, scale as 2 | 4);
      const upscaled = await callModel(upscaleChoice);
      return { url: upscaled.url, upscaled: true };
    } catch (err) {
      console.warn(
        "[edit] SeedVR2 upscale failed, returning original edit:",
        err instanceof Error ? err.message : err,
      );
      return { url: editedUrl, upscaled: false };
    }
  }

  return { url: editedUrl, upscaled: false };
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------
export async function POST(request: NextRequest) {
  if (!verifyAppToken(request)) return unauthorizedResponse();
  try {
    const {
      imageUrl,
      changeSummary,
      allImages,
      modelOverride,
      editCategory,
      hasFaceEdit,
    } = await request.json();

    if (!imageUrl || !changeSummary) {
      return NextResponse.json(
        { error: "Image URL and change summary are required" },
        { status: 400 },
      );
    }

    const category: EditCategory = editCategory || "remove_object";
    const faceEdit: boolean = hasFaceEdit ?? false;

    console.log(`[edit] Category: ${category} | Face edit: ${faceEdit}`);
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
      console.warn(
        "[edit] Could not detect image dimensions, defaulting 1024x1024",
      );
    }

    const tier = detectTier(mainDims.width, mainDims.height);
    console.log(
      `[edit] Input: ${mainDims.width}x${mainDims.height} → tier: ${tier}`,
    );

    // Build prompt — add preservation instructions
    const hasReferences = imageUrls.length > 1;
    let prompt: string;
    if (hasReferences) {
      prompt = `Edit the FIRST image using the other image(s) as reference.\n\n${changeSummary}\n\nDo not change any other elements of the image. Do not alter faces, expressions, skin, hair, clothing, background, or any detail not mentioned above.`;
    } else {
      prompt = `${changeSummary}\n\nDo not change any other elements of the image. Do not alter faces, expressions, skin, hair, clothing, background, or any detail not mentioned above.`;
    }

    // Select models: user override → category-based smart routing
    let models: ModelChoice[];
    if (modelOverride) {
      const overridden = resolveOverride(
        modelOverride,
        prompt,
        imageUrl,
        imageUrls,
        mainDims,
      );
      if (overridden) {
        const smartModels = selectModelsForCategory(
          category,
          faceEdit,
          prompt,
          imageUrl,
          imageUrls,
          mainDims,
        );
        const fallbacks = smartModels.filter(
          (m) => m.modelId !== overridden.modelId,
        );
        models = [overridden, ...fallbacks];
        console.log(`[edit] User override: ${overridden.name}`);
      } else {
        models = selectModelsForCategory(
          category,
          faceEdit,
          prompt,
          imageUrl,
          imageUrls,
          mainDims,
        );
      }
    } else {
      models = selectModelsForCategory(
        category,
        faceEdit,
        prompt,
        imageUrl,
        imageUrls,
        mainDims,
      );
    }
    console.log(`[edit] Model chain: ${models.map((m) => m.name).join(" → ")}`);

    // Try each model in order
    let editedUrl: string | null = null;
    let editedDims: { width?: number; height?: number } | undefined;
    let usedModel = "";
    for (const model of models) {
      try {
        const result = await callModel(model);
        editedUrl = result.url;
        editedDims = { width: result.width, height: result.height };
        usedModel = model.name;
        break;
      } catch (err) {
        console.error(
          `[edit] ${model.name} failed:`,
          err instanceof Error ? err.message : err,
        );
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

    // Golden Rule: ensure output resolution >= input resolution
    const { url: finalUrl, upscaled } = await ensureResolution(
      editedUrl,
      editedDims,
      mainDims,
    );
    if (upscaled) {
      console.log(`[edit] Upscaled to match original resolution`);
      usedModel += " + SeedVR2 Upscale";
    }

    return NextResponse.json({
      ok: true,
      edited: finalUrl,
      method: "fal_ai",
      model: usedModel,
      tier,
      category,
      hasFaceEdit: faceEdit,
      hasImageData: true,
      generatedImages: [finalUrl],
      originalDimensions: mainDims,
      upscaled,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[edit] Error:", error);
    return NextResponse.json(
      {
        ok: false,
        error:
          error instanceof Error ? error.message : "Failed to execute edit",
        timestamp: new Date().toISOString(),
      },
      { status: 500 },
    );
  }
}
