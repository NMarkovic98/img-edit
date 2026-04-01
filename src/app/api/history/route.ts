// src/app/api/history/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { verifyAppToken, unauthorizedResponse } from "@/lib/auth";
import { getEditHistory } from "@/lib/cloudinary";

/**
 * GET /api/history — Fetch edit history from Cloudinary
 *
 * Query params:
 *   author  — filter by Reddit username
 *   postId  — filter by Reddit post ID
 *   limit   — max results (default 50)
 */
export async function GET(request: NextRequest) {
  if (!verifyAppToken(request)) return unauthorizedResponse();

  const { searchParams } = new URL(request.url);
  const author = searchParams.get("author") || undefined;
  const postId = searchParams.get("postId") || undefined;
  const limit = Math.min(
    parseInt(searchParams.get("limit") || "50", 10) || 50,
    100,
  );

  try {
    const items = await getEditHistory({
      author,
      postId,
      maxResults: limit,
    });

    return NextResponse.json({
      ok: true,
      items,
      total: items.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[history] Error:", err);
    return NextResponse.json(
      {
        ok: false,
        error: err instanceof Error ? err.message : "Failed to fetch history",
      },
      { status: 500 },
    );
  }
}
