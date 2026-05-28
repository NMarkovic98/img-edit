export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { mkdir, mkdtemp, unlink, writeFile } from "fs/promises";
import { promisify } from "util";
import os from "os";
import path from "path";
import { verifyAppToken, unauthorizedResponse } from "@/lib/auth";

const execFileAsync = promisify(execFile);

const PSR_NOT_EDITED_DIR =
  "/Users/nikolamarkovic/Desktop/private/photo-edit/PSR Not Edited";

type PhotoshopImage = {
  url: string;
  index: number;
};

function safePathPart(value: string) {
  return (
    value
      .trim()
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, "_") || "unknown"
  );
}

function buildDropBaseName(subreddit: string, postId: string) {
  return `${safePathPart(subreddit)}_${safePathPart(postId)}`;
}

function extensionFromContentType(contentType: string) {
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("gif")) return "gif";
  return "jpg";
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

function validateImageUrl(rawImageUrl: string) {
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
  const imageUrl = normalizeImageUrl(rawImageUrl);
  const hostname = new URL(imageUrl).hostname;

  if (!allowed.some((h) => hostname.endsWith(h))) {
    throw new Error(`Host not allowed: ${hostname}`);
  }

  return imageUrl;
}

async function downloadImage(url: string, filePathBase: string) {
  const imageUrl = validateImageUrl(url);
  const res = await fetch(imageUrl, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  if (!res.ok) {
    throw new Error(`Failed to download ${imageUrl}: ${res.status}`);
  }

  const contentType = res.headers.get("content-type") || "image/jpeg";
  const extension = extensionFromContentType(contentType);
  const filePath = `${filePathBase}.${extension}`;
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(filePath, buf);
  return filePath;
}

function buildPhotoshopJsx(files: { path: string; name: string }[]) {
  const payload = JSON.stringify(files);
  return `
var files = ${payload};
app.displayDialogs = DialogModes.NO;
var baseDoc = null;

function baseNameFromLayerName(name) {
  return String(name).replace(/_[0-9]+$/, "");
}

for (var i = 0; i < files.length; i++) {
  var f = new File(files[i].path);
  var layerDoc = app.open(f);
  app.activeDocument = layerDoc;
  layerDoc.selection.selectAll();
  layerDoc.selection.copy();

  if (baseDoc === null) {
    baseDoc = app.documents.add(
      layerDoc.width,
      layerDoc.height,
      layerDoc.resolution,
      baseNameFromLayerName(files[0].name),
      NewDocumentMode.RGB,
      DocumentFill.TRANSPARENT
    );
    layerDoc.close(SaveOptions.DONOTSAVECHANGES);
  } else {
    layerDoc.close(SaveOptions.DONOTSAVECHANGES);
  }

  app.activeDocument = baseDoc;
  baseDoc.paste();
  try {
    baseDoc.activeLayer.name = files[i].name;
  } catch (e) {}
  try {
    baseDoc.selection.deselect();
  } catch (e) {}
}

if (baseDoc) {
  app.activeDocument = baseDoc;
}
`;
}

async function openInPhotoshop(files: { path: string; name: string }[]) {
  const jsx = buildPhotoshopJsx(files);
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "fixtral-photoshop-"));
  const jsxPath = path.join(tmpDir, "open-layers.jsx");
  await writeFile(jsxPath, jsx, "utf8");
  const appleScript = `
tell application id "com.adobe.Photoshop"
  activate
  do javascript file (POSIX file ${JSON.stringify(jsxPath)})
end tell
`;

  try {
    await execFileAsync("osascript", ["-e", appleScript], {
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
  } catch (err) {
    const detail =
      err instanceof Error && "stderr" in err
        ? String((err as Error & { stderr?: string }).stderr || err.message)
        : err instanceof Error
          ? err.message
          : "Photoshop script failed";
    throw new Error(detail.trim() || "Photoshop script failed");
  } finally {
    unlink(jsxPath).catch(() => {});
  }
}

export async function POST(request: NextRequest) {
  if (!verifyAppToken(request)) return unauthorizedResponse();

  if (process.platform !== "darwin" || process.env.VERCEL) {
    return NextResponse.json(
      {
        error:
          "Photoshop import works only from the local macOS server, not Vercel.",
      },
      { status: 400 },
    );
  }

  try {
    const body = await request.json();
    const author = safePathPart(String(body.author || "unknown"));
    const subreddit = String(body.subreddit || "unknown");
    const postId = String(body.postId || "unknown");
    const dropBaseName = buildDropBaseName(subreddit, postId);
    const images = Array.isArray(body.images)
      ? (body.images as PhotoshopImage[])
      : [];

    if (images.length === 0) {
      return NextResponse.json({ error: "No images provided" }, { status: 400 });
    }

    const authorDir = path.join(PSR_NOT_EDITED_DIR, author);
    await mkdir(authorDir, { recursive: true });

    const files: { path: string; name: string }[] = [];
    for (const image of images) {
      const index = Number.isFinite(Number(image.index))
        ? Number(image.index)
        : files.length + 1;
      const layerName = `${dropBaseName}_${index}`;
      const fileBaseName = index === 1 ? dropBaseName : layerName;
      const firstFilePathBase = path.join(authorDir, fileBaseName);
      const savedPath = await downloadImage(image.url, firstFilePathBase);
      files.push({ path: savedPath, name: layerName });
    }

    await openInPhotoshop(files);

    return NextResponse.json({
      ok: true,
      files,
      folder: authorDir,
      dropBaseName,
    });
  } catch (err) {
    console.error("[photoshop/open] Failed:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to open Photoshop" },
      { status: 500 },
    );
  }
}
