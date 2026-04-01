export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { verifyAppToken, unauthorizedResponse } from "@/lib/auth";
import { uploadToCloudinary } from "@/lib/cloudinary";

export async function POST(req: NextRequest) {
  if (!verifyAppToken(req)) return unauthorizedResponse();

  const { imageDataUrl, author } = await req.json();
  if (!imageDataUrl || typeof imageDataUrl !== "string") {
    return NextResponse.json(
      { ok: false, error: "imageDataUrl is required" },
      { status: 400 },
    );
  }

  try {
    const result = await uploadToCloudinary(imageDataUrl, {
      author: author || "unknown",
      postId: `sharp_${Date.now()}`,
      editCategory: "no_ai_edit",
      model: "sharp",
    });

    if (!result) {
      return NextResponse.json(
        { ok: false, error: "Cloudinary upload failed" },
        { status: 500 },
      );
    }

    return NextResponse.json({
      ok: true,
      url: result.secure_url,
      publicId: result.public_id,
      width: result.width,
      height: result.height,
    });
  } catch (err) {
    console.error("[upload-correction] Error:", err);
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Upload failed",
      },
      { status: 500 },
    );
  }
}
