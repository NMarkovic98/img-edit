import { execFile } from "child_process";
import http from "http";
import { mkdir, mkdtemp, unlink, writeFile } from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const HOST = "127.0.0.1";
const PORT = Number(process.env.PHOTOSHOP_HELPER_PORT || 3999);
const PSR_NOT_EDITED_DIR =
  "/Users/nikolamarkovic/Desktop/private/photo-edit/PSR Not Edited";

function safePathPart(value) {
  return (
    String(value || "")
      .trim()
      .replace(/[\\/:*?"<>|]+/g, "_")
      .replace(/\s+/g, "_") || "unknown"
  );
}

function buildDropBaseName(subreddit, postId) {
  return `${safePathPart(subreddit)}_${safePathPart(postId)}`;
}

function extensionFromContentType(contentType) {
  if (contentType.includes("jpeg") || contentType.includes("jpg")) return "jpg";
  if (contentType.includes("png")) return "png";
  if (contentType.includes("webp")) return "webp";
  if (contentType.includes("gif")) return "gif";
  return "jpg";
}

function normalizeImageUrl(imageUrl) {
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

function validateImageUrl(rawImageUrl) {
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

async function downloadImage(url, filePathBase) {
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

function buildPhotoshopJsx(files) {
  const payload = JSON.stringify(files);
  return `
var files = ${payload};
app.displayDialogs = DialogModes.NO;
var baseDoc = null;

for (var i = 0; i < files.length; i++) {
  var f = new File(files[i].path);
  if (i === 0) {
    baseDoc = app.open(f);
    try {
      baseDoc.activeLayer.name = files[i].name;
    } catch (e) {}
  } else {
    var layerDoc = app.open(f);
    var duplicated = layerDoc.activeLayer.duplicate(baseDoc, ElementPlacement.PLACEATBEGINNING);
    duplicated.name = files[i].name;
    layerDoc.close(SaveOptions.DONOTSAVECHANGES);
    app.activeDocument = baseDoc;
  }
}

if (baseDoc) {
  app.activeDocument = baseDoc;
}
`;
}

async function openInPhotoshop(files) {
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
  } finally {
    unlink(jsxPath).catch(() => {});
  }
}

async function importPostImages(body) {
  if (process.platform !== "darwin") {
    throw new Error("Photoshop helper only works on macOS.");
  }

  const author = safePathPart(body.author || "unknown");
  const dropBaseName = buildDropBaseName(
    body.subreddit || "unknown",
    body.postId || "unknown",
  );
  const images = Array.isArray(body.images) ? body.images : [];

  if (images.length === 0) {
    throw new Error("No images provided.");
  }

  const authorDir = path.join(PSR_NOT_EDITED_DIR, author);
  await mkdir(authorDir, { recursive: true });

  const files = [];
  for (const image of images) {
    const index = Number.isFinite(Number(image.index))
      ? Number(image.index)
      : files.length + 1;
    const layerName = `${dropBaseName}_${index}`;
    const fileBaseName = index === 1 ? dropBaseName : layerName;
    const savedPath = await downloadImage(
      image.url,
      path.join(authorDir, fileBaseName),
    );
    files.push({ path: savedPath, name: layerName });
  }

  await openInPhotoshop(files);

  return {
    ok: true,
    files,
    folder: authorDir,
    dropBaseName,
  };
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  });
  res.end(JSON.stringify(payload));
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method !== "POST" || req.url !== "/photoshop/open") {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    const result = await importPostImages(body);
    sendJson(res, 200, result);
  } catch (err) {
    console.error("[photoshop-helper] Failed:", err);
    sendJson(res, 500, {
      error: err instanceof Error ? err.message : "Photoshop import failed",
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Photoshop helper listening on http://${HOST}:${PORT}`);
});
