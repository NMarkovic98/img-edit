// src/lib/cloudinary.ts
import { createHash } from "crypto";

const CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME!;
const API_KEY = process.env.CLOUDINARY_API_KEY!;
const API_SECRET = process.env.CLOUDINARY_API_SECRET!;
const FOLDER = "PixelFixer-Edits";

// ---------------------------------------------------------------------------
// Signed upload — preserves full quality (no re-encoding)
// ---------------------------------------------------------------------------
interface UploadMeta {
  author: string; // Reddit username
  postId: string; // Reddit post ID
  editCategory?: string;
  model?: string;
  prompt?: string;
}

export interface CloudinaryResult {
  secure_url: string;
  public_id: string;
  width: number;
  height: number;
  bytes: number;
  format: string;
  created_at: string;
}

function generateSignature(params: Record<string, string | number>): string {
  // Sort params alphabetically, join as key=value&key=value, append secret
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join("&");
  return createHash("sha1")
    .update(sorted + API_SECRET)
    .digest("hex");
}

/**
 * Upload an image URL to Cloudinary without quality loss.
 * The image is fetched directly by Cloudinary from the source URL.
 */
export async function uploadToCloudinary(
  imageUrl: string,
  meta: UploadMeta,
): Promise<CloudinaryResult | null> {
  if (!CLOUD_NAME || !API_KEY || !API_SECRET) {
    console.warn("[cloudinary] Missing credentials, skipping upload");
    return null;
  }

  // Build public_id: author_postId_timestamp
  const safeAuthor = meta.author.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50);
  const safePostId = meta.postId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const ts = Date.now();
  const publicId = `${FOLDER}/${safeAuthor}_${safePostId}_${ts}`;

  const timestamp = Math.floor(Date.now() / 1000);

  // Context metadata (stored on the Cloudinary resource)
  const context = [
    `author=${meta.author}`,
    `post_id=${meta.postId}`,
    meta.editCategory ? `category=${meta.editCategory}` : "",
    meta.model ? `model=${meta.model}` : "",
  ]
    .filter(Boolean)
    .join("|");

  // Params that go into the signature (alphabetical)
  const signedParams: Record<string, string | number> = {
    context,
    folder: FOLDER,
    public_id: publicId,
    tags: `pixelfixer,${safeAuthor},${safePostId}`,
    timestamp,
  };

  const signature = generateSignature(signedParams);

  const formData = new FormData();
  formData.append("file", imageUrl); // Cloudinary fetches from URL directly
  formData.append("api_key", API_KEY);
  formData.append("signature", signature);
  formData.append("timestamp", String(timestamp));
  formData.append("public_id", publicId);
  formData.append("folder", FOLDER);
  formData.append("tags", `pixelfixer,${safeAuthor},${safePostId}`);
  formData.append("context", context);
  // No transformation = no quality loss

  try {
    const res = await fetch(
      `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`,
      { method: "POST", body: formData },
    );

    if (!res.ok) {
      const errText = await res.text();
      console.error("[cloudinary] Upload failed:", res.status, errText);
      return null;
    }

    const data = await res.json();
    console.log(
      `[cloudinary] Uploaded: ${data.public_id} (${data.width}x${data.height}, ${data.bytes} bytes)`,
    );

    return {
      secure_url: data.secure_url,
      public_id: data.public_id,
      width: data.width,
      height: data.height,
      bytes: data.bytes,
      format: data.format,
      created_at: data.created_at,
    };
  } catch (err) {
    console.error("[cloudinary] Upload error:", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Admin API — list edit history from Cloudinary
// ---------------------------------------------------------------------------
export interface HistoryItem {
  publicId: string;
  url: string;
  width: number;
  height: number;
  format: string;
  bytes: number;
  createdAt: string;
  author: string;
  postId: string;
  category: string;
  model: string;
}

/**
 * Fetch edit history from Cloudinary's Admin API.
 * Supports optional filtering by author or postId.
 */
export async function getEditHistory(opts?: {
  author?: string;
  postId?: string;
  maxResults?: number;
}): Promise<HistoryItem[]> {
  if (!CLOUD_NAME || !API_KEY || !API_SECRET) {
    return [];
  }

  const maxResults = opts?.maxResults ?? 50;
  let expression = `folder:${FOLDER}`;
  if (opts?.author) expression += ` AND tags:${opts.author}`;
  if (opts?.postId) expression += ` AND tags:${opts.postId}`;

  const authHeader =
    "Basic " + Buffer.from(`${API_KEY}:${API_SECRET}`).toString("base64");

  try {
    const params = new URLSearchParams({
      expression,
      sort_by: "created_at",
      direction: "desc",
      max_results: String(maxResults),
    });
    params.append("with_field", "context");
    params.append("with_field", "tags");

    const res = await fetch(
      `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/resources/search?${params}`,
      {
        headers: { Authorization: authHeader },
      },
    );

    if (!res.ok) {
      console.error("[cloudinary] Search failed:", res.status);
      return [];
    }

    const data = await res.json();
    return (data.resources || []).map((r: any) => ({
      publicId: r.public_id,
      url: r.secure_url,
      width: r.width,
      height: r.height,
      format: r.format,
      bytes: r.bytes,
      createdAt: r.created_at,
      author: r.context?.custom?.author || "",
      postId: r.context?.custom?.post_id || "",
      category: r.context?.custom?.category || "",
      model: r.context?.custom?.model || "",
    }));
  } catch (err) {
    console.error("[cloudinary] History fetch error:", err);
    return [];
  }
}
