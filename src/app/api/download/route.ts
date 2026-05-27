// src/app/api/download/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { verifyAppToken, unauthorizedResponse } from "@/lib/auth";
import { mkdir, writeFile } from "fs/promises";
import path from "path";

const PSR_NOT_EDITED_DIR =
  "/Users/nikolamarkovic/Desktop/private/photo-edit/PSR Not Edited";

function safePathPart(value: string) {
  return (
    value
      .trim()
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, "_") || "unknown"
  );
}

function extensionFromContentType(contentType: string) {
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("gif")) return "gif";
  return "png";
}

function withExtension(filename: string, contentType: string) {
  if (path.extname(filename)) return filename;
  return `${filename}.${extensionFromContentType(contentType)}`;
}

function normalizeImageUrl(imageUrl: string) {
  const url = new URL(imageUrl);
  const wrappedUrl = url.searchParams.get("url");

  if (
    wrappedUrl &&
    (url.hostname === "reddit.com" || url.hostname === "www.reddit.com") &&
    url.pathname.startsWith("/media")
  ) {
    return wrappedUrl;
  }

  return imageUrl;
}

/**
 * GET /api/download?url=...&name=...
 * Proxies an image URL and returns it as a downloadable file.
 * This avoids the browser navigating to fal.ai storage (slow 5-min loads).
 */
export async function GET(request: NextRequest) {
  if (!verifyAppToken(request)) return unauthorizedResponse();

  const { searchParams } = new URL(request.url);
  const rawImageUrl = searchParams.get("url");
  const filename = searchParams.get("name") || `pixelfixer-${Date.now()}.png`;
  const saveToPsr = searchParams.get("psr") === "1";
  const author = searchParams.get("author") || "unknown";
  const imageIndex = searchParams.get("imageIndex") || "1";

  if (!rawImageUrl) {
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
    "external-preview.redd.it",
    "redditmedia.com",
  ];
  let imageUrl: string;
  let hostname: string;
  try {
    imageUrl = normalizeImageUrl(rawImageUrl);
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
    const responseFilename = withExtension(safePathPart(filename), contentType);
    let savedPath: string | undefined;
    let saveError: string | undefined;

    if (saveToPsr) {
      try {
        const safeAuthor = safePathPart(author);
        const safeImageIndex = safePathPart(imageIndex);
        const extension = extensionFromContentType(contentType);
        const authorDir = path.join(PSR_NOT_EDITED_DIR, safeAuthor);
        savedPath = path.join(
          authorDir,
          `${safeAuthor}-${safeImageIndex}.${extension}`,
        );
        await mkdir(authorDir, { recursive: true });
        await writeFile(savedPath, buf);
      } catch (err) {
        saveError = err instanceof Error ? err.message : "Unknown save error";
        console.warn("[download] PSR save failed:", saveError);
        savedPath = undefined;
      }
    }

    return new NextResponse(buf, {
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${responseFilename}"`,
        "Content-Length": String(buf.length),
        "Cache-Control": "private, max-age=3600",
        ...(savedPath ? { "X-Saved-To": savedPath } : {}),
        ...(saveError ? { "X-Save-Error": saveError } : {}),
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
