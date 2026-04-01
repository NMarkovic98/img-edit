export const runtime = "nodejs";
export const maxDuration = 30;

import { NextRequest, NextResponse } from "next/server";
import { verifyAppToken, unauthorizedResponse } from "@/lib/auth";
import { analyzeImageQuality, applyCorrections } from "@/lib/image-analysis";

export async function POST(req: NextRequest) {
  if (!verifyAppToken(req)) return unauthorizedResponse();

  const { imageUrl } = await req.json();
  if (!imageUrl || typeof imageUrl !== "string") {
    return NextResponse.json(
      { ok: false, error: "imageUrl is required" },
      { status: 400 },
    );
  }

  try {
    // Fetch the image
    const res = await fetch(imageUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: `Failed to fetch image: ${res.status}` },
        { status: 502 },
      );
    }
    const buf = Buffer.from(await res.arrayBuffer());

    // Run analysis
    const analysis = await analyzeImageQuality(buf);

    // If no issues found, return early
    if (analysis.hints.length === 0) {
      return NextResponse.json({
        ok: true,
        hasCorrections: false,
        analysis: {
          summary: analysis.summary,
          hints: analysis.hints,
          metrics: analysis.metrics,
        },
        applied: [],
      });
    }

    // Apply corrections
    const correction = await applyCorrections(buf);

    // Convert corrected buffer to base64 data URL
    const base64 = correction.buffer.toString("base64");
    const correctedDataUrl = `data:image/png;base64,${base64}`;

    return NextResponse.json({
      ok: true,
      hasCorrections: correction.applied.length > 0,
      correctedImageUrl: correctedDataUrl,
      analysis: {
        summary: analysis.summary,
        hints: analysis.hints,
        metrics: analysis.metrics,
      },
      applied: correction.applied,
    });
  } catch (err) {
    console.error("[preview-corrections] Error:", err);
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Failed to analyze image",
      },
      { status: 500 },
    );
  }
}
