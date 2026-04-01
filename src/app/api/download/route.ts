// src/app/api/download/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { verifyAppToken, unauthorizedResponse } from "@/lib/auth";

/**
 * GET /api/download?url=...&name=...
 * Proxies an image URL and returns it as a downloadable file.
 * This avoids the browser navigating to fal.ai storage (slow 5-min loads).
 */
export async function GET(request: NextRequest) {
  if (!verifyAppToken(request)) return unauthorizedResponse();

  const { searchParams } = new URL(request.url);
  const imageUrl = searchParams.get("url");
  const filename = searchParams.get("name") || `pixelfixer-${Date.now()}.png`;

  if (!imageUrl) {
    return NextResponse.json({ error: "url param required" }, { status: 400 });
  }

  // Only allow known image hosts
  const allowed = [
    "fal.media",
    "fal-cdn.batuhan-941.workers.dev",
    "v3.fal.media",
    "storage.googleapis.com",
    "res.cloudinary.com",
    "i.redd.it",
    "i.imgur.com",
    "preview.redd.it",
  ];
  let hostname: string;
  try {
    hostname = new URL(imageUrl).hostname;
  } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }

  if (!allowed.some((h) => hostname.endsWith(h))) {
    return NextResponse.json({ error: "Host not allowed" }, { status: 403 });
  }

  try {
    const res = await fetch(imageUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: `Upstream returned ${res.status}` },
        { status: 502 },
      );
    }

    const contentType =
      res.headers.get("content-type") || "application/octet-stream";
    const buf = Buffer.from(await res.arrayBuffer());

    return new NextResponse(buf, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(buf.length),
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (err) {
    console.error("[download] Proxy error:", err);
    return NextResponse.json(
      { error: "Failed to fetch image" },
      { status: 500 },
    );
  }
}
