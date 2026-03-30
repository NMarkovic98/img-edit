// src/app/api/gemini/edit/route.ts
import { NextRequest, NextResponse } from "next/server";
import { fal } from "@fal-ai/client";
import { verifyAppToken, unauthorizedResponse } from "@/lib/auth";

export const runtime = "nodejs";
export const maxDuration = 300;

fal.config({
  credentials: process.env.FAL_KEY!,
});

interface EditRequest {
  imageUrl: string;
  brief: {
    task_type: string;
    instructions: string;
    objects_to_remove: string[];
    objects_to_add: string[];
    style: string;
    mask_needed: boolean;
    nsfw_flag: boolean;
    additional_instructions?: string;
  };
}

function pickResolution(width: number, height: number): "1K" | "2K" | "4K" {
  const maxDim = Math.max(width, height);
  if (maxDim <= 1024) return "1K";
  if (maxDim <= 2048) return "2K";
  return "4K";
}

function getImageDimensions(buf: Buffer): { width: number; height: number } {
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
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
  if (!verifyAppToken(request)) return unauthorizedResponse();
  const startTime = Date.now();

  try {
    const { imageUrl, brief }: EditRequest = await request.json();

    if (!imageUrl || !brief) {
      return NextResponse.json(
        { error: "Image URL and brief are required" },
        { status: 400 },
      );
    }

    // Detect image dimensions for resolution
    let resolution: "1K" | "2K" | "4K" = "1K";
    try {
      const res = await fetch(imageUrl, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (res.ok) {
        const buf = Buffer.from(await res.arrayBuffer());
        const dims = getImageDimensions(buf);
        resolution = pickResolution(dims.width, dims.height);
        console.log(`[gemini/edit] Input: ${dims.width}x${dims.height}, resolution: ${resolution}`);
      }
    } catch {
      console.warn("[gemini/edit] Could not detect dimensions, using 1K");
    }

    // Build prompt from brief
    const prompt = [
      brief.instructions,
      brief.style && brief.style !== "realistic" ? `Style: ${brief.style}` : "",
      Array.isArray(brief.objects_to_remove) && brief.objects_to_remove.length
        ? `Remove: ${brief.objects_to_remove.join(", ")}`
        : "",
      Array.isArray(brief.objects_to_add) && brief.objects_to_add.length
        ? `Add: ${brief.objects_to_add.join(", ")}`
        : "",
      brief.additional_instructions || "",
      "",
      "Do not change any other elements of the image. Do not alter faces, expressions, skin, hair, clothing, background, or any detail not mentioned above.",
    ]
      .filter(Boolean)
      .join("\n");

    console.log(`[gemini/edit] Prompt: ${prompt.slice(0, 200)}`);

    // Call fal.ai nano-banana-pro/edit
    const result = await fal.subscribe("fal-ai/nano-banana-pro/edit", {
      input: {
        prompt,
        image_urls: [imageUrl],
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
    console.log(`[gemini/edit] Success! Output: ${editedUrl}`);

    return NextResponse.json({
      success: true,
      content: editedUrl,
      processingTime: Date.now() - startTime,
    });
  } catch (error) {
    console.error("[gemini/edit] Error:", error);
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to process image edit",
        processingTime: Date.now() - startTime,
      },
      { status: 500 },
    );
  }
}
