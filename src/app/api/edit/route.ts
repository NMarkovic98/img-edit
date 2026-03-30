// src/app/api/edit/route.ts
export const runtime = "nodejs";
export const maxDuration = 300;

import { NextRequest, NextResponse } from "next/server";
import { fal } from "@fal-ai/client";

fal.config({
  credentials: process.env.FAL_KEY!,
});

/**
 * Pick resolution based on the longest dimension of the input.
 */
function pickResolution(width: number, height: number): "1K" | "2K" | "4K" {
  const maxDim = Math.max(width, height);
  if (maxDim <= 1024) return "1K";
  if (maxDim <= 2048) return "2K";
  return "4K";
}

/**
 * Extract width/height from raw image bytes (JPEG, PNG, WebP).
 */
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

export async function POST(request: NextRequest) {
  try {
    const { imageUrl, changeSummary, allImages } = await request.json();

    if (!imageUrl || !changeSummary) {
      return NextResponse.json(
        { error: "Image URL and change summary are required" },
        { status: 400 },
      );
    }

    console.log("[edit] Starting fal.ai edit...");
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

    // Detect main image dimensions for resolution
    let resolution: "1K" | "2K" | "4K" = "1K";
    let mainDims = { width: 1024, height: 1024 };
    try {
      const res = await fetch(imageUrl, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        mainDims = getImageDimensions(buf);
        resolution = pickResolution(mainDims.width, mainDims.height);
      }
    } catch {
      console.warn("[edit] Could not detect image dimensions, using 1K");
    }

    console.log(`[edit] Main: ${mainDims.width}x${mainDims.height}, resolution: ${resolution}`);

    // Build prompt
    const hasReferences = imageUrls.length > 1;
    let prompt: string;
    if (hasReferences) {
      prompt = `Edit the FIRST image using the other image(s) as reference.\n\n${changeSummary}\n\nDo not change any other elements of the image. Do not alter faces, expressions, skin, hair, clothing, background, or any detail not mentioned above.`;
    } else {
      prompt = `${changeSummary}\n\nDo not change any other elements of the image. Do not alter faces, expressions, skin, hair, clothing, background, or any detail not mentioned above.`;
    }

    // Call fal.ai nano-banana-pro/edit
    const result = await fal.subscribe("fal-ai/nano-banana-pro/edit", {
      input: {
        prompt,
        image_urls: imageUrls,
        num_images: 1,
        resolution,
        output_format: "png",
        safety_tolerance: "6",
      } as any,
      logs: true,
      onQueueUpdate: (update) => {
        if (update.status === "IN_PROGRESS" && "logs" in update) {
          update.logs?.map((log) => log.message).forEach((msg) => console.log("[fal]", msg));
        }
      },
    });

    const images = result.data?.images;
    if (!images || images.length === 0) {
      throw new Error("fal.ai returned no images");
    }

    const editedUrl = images[0].url;
    console.log(`[edit] Success! Output: ${editedUrl}`);

    return NextResponse.json({
      ok: true,
      edited: editedUrl,
      method: "fal_ai",
      model: "nano-banana-pro/edit",
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
