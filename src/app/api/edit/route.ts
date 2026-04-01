// src/app/api/edit/route.ts
export const runtime = "nodejs";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { fal } from "@fal-ai/client";
import { verifyAppToken, unauthorizedResponse } from "@/lib/auth";
import { uploadToCloudinary } from "@/lib/cloudinary";
import { analyzeImageQuality, applyCorrections } from "@/lib/image-analysis";
import type { EditCategory, AiPolicy } from "@/types";
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

// --- FLUX Kontext [pro] — $0.04/img, face-safe, ~1024px output, no image_size param ---
function fluxKontextPro(prompt: string, imageUrl: string): ModelChoice {
  return {
    modelId: "fal-ai/flux-pro/kontext",
    name: "FLUX Kontext Pro",
    input: {
      prompt,
      image_url: imageUrl,
      output_format: "png",
    },
  };
}

// --- FLUX Kontext [max] — $0.08/img, best prompt adherence + typography, ~1024px output ---
function fluxKontextMax(prompt: string, imageUrl: string): ModelChoice {
  return {
    modelId: "fal-ai/flux-pro/kontext/max",
    name: "FLUX Kontext Max",
    input: {
      prompt,
      image_url: imageUrl,
      output_format: "png",
    },
  };
}

// --- FLUX.2 [pro] Edit — $0.03/1MP + $0.015/extra MP, multi-ref up to 9 imgs (9MP total) ---
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
      output_format: "png",
    },
  };
}

// --- Nano Banana 2 (Gemini 3.1 Flash) — $0.08(1K)/$0.12(2K)/$0.16(4K), up to 14 refs ---
function nanoBanana2(
  prompt: string,
  imageUrls: string[],
  resolution: "0.5K" | "1K" | "2K" | "4K" = "1K",
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

// --- Nano Banana Pro (Gemini 3 Pro) — $0.15(1K)/$0.30(4K), deep reasoning ---
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

// --- Seedream 5.0 Lite — $0.035/img, 3.7-9.4MP (2560x1440 to 3072x3072), up to 10 refs ---
function seedream5Lite(
  prompt: string,
  imageUrls: string[],
  dims: { width: number; height: number },
): ModelChoice {
  const MAX_SIDE = 3072;
  const MAX_PIXELS = 3072 * 3072; // 9.43MP
  let { width, height } = dims;
  // Cap to max side
  const longest = Math.max(width, height);
  if (longest > MAX_SIDE) {
    const scale = MAX_SIDE / longest;
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  // Cap total pixels to 9.43MP
  const pixels = width * height;
  if (pixels > MAX_PIXELS) {
    const scale = Math.sqrt(MAX_PIXELS / pixels);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  return {
    modelId: "fal-ai/bytedance/seedream/v5/lite/edit",
    name: "Seedream 5.0 Lite",
    input: {
      prompt,
      image_urls: imageUrls,
      image_size: { width, height },
      num_images: 1,
    },
  };
}

// --- Bria RMBG 2.0 — $0.018/gen, max 1024x1024, background removal only ---
function briaBgRemove(imageUrl: string): ModelChoice {
  return {
    modelId: "fal-ai/bria/background/remove",
    name: "Bria RMBG 2.0",
    input: {
      image_url: imageUrl,
    },
  };
}

// --- SeedVR2 Upscale — $0.001/MP, 2x or 4x scale ---
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
function pickNanaBananaRes(w: number, h: number): "0.5K" | "1K" | "2K" | "4K" {
  const max = Math.max(w, h);
  if (max >= 3840) return "4K";
  if (max >= 1920) return "2K";
  if (max >= 768) return "1K";
  return "0.5K";
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
  // Nano Banana Pro doesn't support 0.5K — floor to 1K
  const nbProRes: "1K" | "2K" | "4K" = nbRes === "0.5K" ? "1K" : nbRes;

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
      return nanoBananaPro(prompt, imageUrls, nbProRes);
    case "fal-ai/bytedance/seedream/v5/lite/edit":
      return seedream5Lite(prompt, imageUrls, dims);
    case "bria-bg-remove":
      return briaBgRemove(imageUrl);
    default:
      // Fallback to Kontext Pro
      return fluxKontextPro(prompt, imageUrl);
  }
}

// ---------------------------------------------------------------------------
// Resolution-aware smart model selector
// Budget: ≤$0.30/request OK. Pick best model that handles the resolution natively.
//
// Resolution routing:
//   4K+ (≥3840px) → Nano Banana 2/Pro 4K ($0.16/$0.30) or FLUX 2 Pro
//   2K (1920-3839px) → Nano Banana 2 2K ($0.12), FLUX 2 Pro, or Seedream
//   1K-FHD (≤1919px) → Kontext Pro/Max ($0.04/$0.08), Seedream ($0.035), NB2 1K ($0.08)
// ---------------------------------------------------------------------------
function selectModelsForCategory(
  category: EditCategory,
  hasFaceEdit: boolean,
  prompt: string,
  imageUrl: string,
  imageUrls: string[],
  dims: { width: number; height: number },
): ModelChoice[] {
  const maxSide = Math.max(dims.width, dims.height);
  const isHighRes = maxSide >= 1920; // 2K+
  const is4K = maxSide >= 3840; // 4K+
  const nbRes = pickNanaBananaRes(dims.width, dims.height);
  const nbProRes: "1K" | "2K" | "4K" = nbRes === "0.5K" ? "1K" : nbRes;

  // For background removal, always use Bria first
  if (category === "remove_background") {
    return [briaBgRemove(imageUrl), fluxKontextPro(prompt, imageUrl)];
  }

  // Start with category-preferred models from the table
  const categoryModelIds = [...CATEGORY_MODEL_MAP[category]];

  // For HIGH-RES (2K+): prioritize models that handle resolution natively
  let modelIds: string[];
  if (is4K) {
    // 4K: Only NanoBanana 2/Pro (4K tier) and FLUX 2 Pro can handle this
    modelIds = [
      "fal-ai/nano-banana-2/edit", // $0.16 at 4K
      "fal-ai/flux-2-pro/edit", // ~$0.20 at 12MP
      "fal-ai/nano-banana-pro/edit", // $0.30 at 4K (fallback, expensive)
    ];
    console.log(`[edit] 4K+ image (${maxSide}px) → NB2/FLUX2Pro/NBPro routing`);
  } else if (isHighRes) {
    // 2K: NanoBanana 2 (2K=$0.12), FLUX 2 Pro, Seedream are all fine
    modelIds = [
      "fal-ai/nano-banana-2/edit", // $0.12 at 2K
      "fal-ai/flux-2-pro/edit", // ~$0.06 at 2MP
      "fal-ai/bytedance/seedream/v5/lite/edit", // $0.035 up to 3072px
    ];
    console.log(
      `[edit] 2K image (${maxSide}px) → NB2/FLUX2Pro/Seedream routing`,
    );
  } else {
    // SD/HD/FHD (≤1919px): use cheaper models, category table drives selection
    modelIds = categoryModelIds;
    console.log(`[edit] ≤FHD image (${maxSide}px) → category-based routing`);
  }

  // For high-res, keep category preferences but ensure hi-res capable models come first
  if (isHighRes) {
    // Add any category-preferred models that are already high-res capable
    for (const id of categoryModelIds) {
      if (
        !modelIds.includes(id) &&
        id !== "fal-ai/flux-pro/kontext" &&
        id !== "fal-ai/flux-pro/kontext/max"
      ) {
        modelIds.push(id);
      }
    }
  }

  // Face-safe guard: if edit touches faces, filter out unsafe models
  if (hasFaceEdit) {
    const safeIds = modelIds.filter(
      (id) =>
        (FACE_SAFE_MODELS as readonly string[]).includes(id) ||
        id === "bria-bg-remove",
    );
    modelIds = safeIds.length > 0 ? safeIds : ["fal-ai/flux-pro/kontext"];
  }

  // Deduplicate
  modelIds = [...new Set(modelIds)];

  return modelIds.map((id) =>
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
    case "nano-banana-pro": {
      const r = pickNanaBananaRes(dims.width, dims.height);
      return nanoBananaPro(prompt, imageUrls, r === "0.5K" ? "1K" : r);
    }
    case "seedream-5-lite":
      return seedream5Lite(prompt, imageUrls, dims);
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
      return seedream5Lite(prompt, imageUrls, dims);
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
      imageUrl: rawImageUrl,
      changeSummary,
      allImages,
      modelOverride,
      editCategory,
      hasFaceEdit,
      aiPolicy: rawAiPolicy,
      author,
      postId,
      applyCorrections: shouldCorrect,
      skipAnalysisHints: rawSkipAnalysisHints,
    } = await request.json();

    if (!rawImageUrl || !changeSummary) {
      return NextResponse.json(
        { error: "Image URL and change summary are required" },
        { status: 400 },
      );
    }

    // imageUrl may be replaced with corrected version below
    let imageUrl: string = rawImageUrl;

    const category: EditCategory = editCategory || "remove_object";
    const faceEdit: boolean = hasFaceEdit ?? false;
    const aiPolicy: AiPolicy = rawAiPolicy || "unknown";
    const skipAnalysisHints: boolean = rawSkipAnalysisHints ?? false;

    console.log(
      `[edit] Category: ${category} | Face edit: ${faceEdit} | AI policy: ${aiPolicy}`,
    );
    console.log("[edit] Prompt:", changeSummary);

    // Build unique image URLs list — main first, then references
    const imageUrls: string[] = [imageUrl];
    if (Array.isArray(allImages)) {
      for (const url of allImages) {
        if (url && url !== rawImageUrl && !imageUrls.includes(url)) {
          imageUrls.push(url);
        }
      }
    }

    console.log(`[edit] ${imageUrls.length} image(s)`);

    // Detect main image dimensions + quality analysis
    let mainDims = { width: 1024, height: 1024 };
    let imageBuf: Buffer | null = null;
    try {
      const res = await fetch(imageUrl, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (res.ok) {
        imageBuf = Buffer.from(await res.arrayBuffer());
        mainDims = getImageDimensions(imageBuf);
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

    // Apply deterministic sharp corrections if requested
    let correctionApplied = false;
    if (shouldCorrect && imageBuf) {
      try {
        const correction = await applyCorrections(imageBuf);
        if (correction.applied.length > 0) {
          console.log(
            `[edit] Applying ${correction.applied.length} sharp correction(s)`,
          );
          // Upload corrected image to Cloudinary as temporary
          const correctedDataUrl = `data:image/png;base64,${correction.buffer.toString("base64")}`;
          const correctedUpload = await uploadToCloudinary(correctedDataUrl, {
            author: author || "unknown",
            postId: `corrected_${postId || "unknown"}`,
          });
          if (correctedUpload?.secure_url) {
            imageUrl = correctedUpload.secure_url;
            imageUrls[0] = imageUrl;
            correctionApplied = true;
            console.log(`[edit] Using corrected image: ${imageUrl}`);
          }
        }
      } catch (corrErr) {
        console.warn(
          "[edit] Sharp corrections failed (non-blocking):",
          corrErr,
        );
      }
    }

    // Analyze image quality (12 checks: exposure, contrast, saturation, color cast,
    // dynamic range, highlight/shadow clipping, color temp, tonal compression,
    // sharpness, noise, vignetting)
    // Skip for categories where color corrections don't make sense
    const SKIP_ANALYSIS_CATEGORIES: EditCategory[] = [
      "remove_background",
      "text_edit",
      "creative_fun",
    ];
    let qualityHints = "";
    let analysisMetrics: Record<string, number> | undefined;
    if (imageBuf && !SKIP_ANALYSIS_CATEGORIES.includes(category)) {
      const analysis = await analyzeImageQuality(imageBuf);
      analysisMetrics = analysis.metrics;
      if (analysis.hints.length > 0) {
        console.log(`[edit] ${analysis.summary}`);
        console.log(`[edit] Metrics: ${JSON.stringify(analysis.metrics)}`);
        // Skip hints if: NO AI policy, or user explicitly opted out
        if (aiPolicy !== "no_ai" && !skipAnalysisHints) {
          qualityHints =
            "\n\nAlso subtly improve the following image quality issues while performing the edit (apply corrections naturally, do not overcorrect): " +
            analysis.hints.join(" ");
        } else if (skipAnalysisHints) {
          console.log("[edit] Analysis hints skipped (user opt-out)");
        }
      } else {
        console.log("[edit] Image quality OK — no corrections needed");
      }
    }

    // Build prompt — adapt based on AI policy
    const hasReferences = imageUrls.length > 1;
    const preservationRule =
      "Do not change any other elements of the image. Do not alter faces, expressions, skin, hair, clothing, background, or any detail not mentioned above.";

    // NO AI policy = extremely strict minimal edits
    const noAiRule =
      aiPolicy === "no_ai"
        ? "\n\nCRITICAL: This image must look completely natural and unedited. Make the ABSOLUTE MINIMUM change possible. The edit must be invisible — no artifacts, no style changes, no color shifts, no visible AI manipulation. Preserve every pixel that doesn't need to change."
        : "";

    let prompt: string;
    if (hasReferences) {
      prompt = `Edit the FIRST image using the other image(s) as reference.\n\n${changeSummary}\n\n${preservationRule}${noAiRule}${qualityHints}`;
    } else {
      prompt = `${changeSummary}\n\n${preservationRule}${noAiRule}${qualityHints}`;
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
    if (editedDims?.width && editedDims?.height) {
      console.log(
        `[edit] Output dimensions: ${editedDims.width}x${editedDims.height}`,
      );
    }

    // Upload to Cloudinary for permanent storage + history
    let cloudinaryUrl: string | null = null;
    let cloudinaryPublicId: string | null = null;
    try {
      const cloudResult = await uploadToCloudinary(editedUrl, {
        author: author || "unknown",
        postId: postId || "unknown",
        editCategory: category,
        model: usedModel,
        prompt: changeSummary?.slice(0, 200),
      });
      if (cloudResult) {
        cloudinaryUrl = cloudResult.secure_url;
        cloudinaryPublicId = cloudResult.public_id;
        console.log(`[edit] Cloudinary: ${cloudinaryUrl}`);
      }
    } catch (err) {
      console.warn("[edit] Cloudinary upload failed (non-blocking):", err);
    }

    return NextResponse.json({
      ok: true,
      edited: editedUrl,
      method: "fal_ai",
      model: usedModel,
      tier,
      category,
      hasFaceEdit: faceEdit,
      aiPolicy,
      hasImageData: true,
      generatedImages: [editedUrl],
      cloudinaryUrl,
      cloudinaryPublicId,
      imageAnalysis: analysisMetrics || undefined,
      correctionApplied,
      originalDimensions: mainDims,
      outputDimensions: editedDims?.width
        ? { width: editedDims.width, height: editedDims.height }
        : undefined,
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
