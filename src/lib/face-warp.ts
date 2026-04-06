/**
 * Face Warp — shifts faces in an edited image back to match original landmark positions.
 * Uses Delaunay triangulation + per-triangle affine warping, blended with a feathered mask.
 */
import * as faceapi from "@vladmandic/face-api";

let modelsLoaded = false;

async function loadModels() {
  if (modelsLoaded) return;
  const MODEL_URL = "/models";
  await Promise.all([
    faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
    faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
    faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
  ]);
  modelsLoaded = true;
}

function proxyUrl(url: string): string {
  try {
    const { hostname } = new URL(url);
    const needsProxy = ["i.redd.it", "i.imgur.com", "preview.redd.it", "external-preview.redd.it"];
    if (needsProxy.includes(hostname)) {
      return `/api/image-proxy?url=${encodeURIComponent(url)}`;
    }
  } catch {}
  return url;
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  const src = proxyUrl(url);
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load: ${url}`));
    img.src = src;
  });
}

// ─── Delaunay triangulation (Bowyer-Watson) ────────────────────────

interface Tri {
  a: number;
  b: number;
  c: number;
}

function delaunay(points: { x: number; y: number }[]): Tri[] {
  const n = points.length;
  // Super-triangle that contains all points
  const minX = Math.min(...points.map((p) => p.x)) - 10;
  const minY = Math.min(...points.map((p) => p.y)) - 10;
  const maxX = Math.max(...points.map((p) => p.x)) + 10;
  const maxY = Math.max(...points.map((p) => p.y)) + 10;
  const dx = maxX - minX;
  const dy = maxY - minY;
  const dmax = Math.max(dx, dy) * 2;

  const superPts = [
    { x: minX - dmax, y: minY - 1 },
    { x: minX + dmax * 2, y: minY - 1 },
    { x: minX + dmax / 2, y: minY + dmax * 2 },
  ];
  const allPts = [...points, ...superPts];
  const s0 = n, s1 = n + 1, s2 = n + 2;

  let triangles: Tri[] = [{ a: s0, b: s1, c: s2 }];

  for (let i = 0; i < n; i++) {
    const p = allPts[i];
    const bad: Tri[] = [];
    for (const t of triangles) {
      if (inCircumcircle(p, allPts[t.a], allPts[t.b], allPts[t.c])) {
        bad.push(t);
      }
    }

    // Find polygon hole boundary
    const edges: [number, number][] = [];
    for (const t of bad) {
      const triEdges: [number, number][] = [[t.a, t.b], [t.b, t.c], [t.c, t.a]];
      for (const [ea, eb] of triEdges) {
        const shared = bad.some(
          (o) => o !== t && hasEdge(o, ea, eb),
        );
        if (!shared) edges.push([ea, eb]);
      }
    }

    triangles = triangles.filter((t) => !bad.includes(t));
    for (const [ea, eb] of edges) {
      triangles.push({ a: i, b: ea, c: eb });
    }
  }

  // Remove triangles that share vertices with super-triangle
  return triangles.filter(
    (t) => t.a < n && t.b < n && t.c < n,
  );
}

function hasEdge(t: Tri, a: number, b: number): boolean {
  const verts = [t.a, t.b, t.c];
  return verts.includes(a) && verts.includes(b);
}

function inCircumcircle(
  p: { x: number; y: number },
  a: { x: number; y: number },
  b: { x: number; y: number },
  c: { x: number; y: number },
): boolean {
  const ax = a.x - p.x, ay = a.y - p.y;
  const bx = b.x - p.x, by = b.y - p.y;
  const cx = c.x - p.x, cy = c.y - p.y;
  const det =
    (ax * ax + ay * ay) * (bx * cy - cx * by) -
    (bx * bx + by * by) * (ax * cy - cx * ay) +
    (cx * cx + cy * cy) * (ax * by - bx * ay);
  return det > 0;
}

// ─── Affine warp ───────────────────────────────────────────────────

/**
 * Computes 2x3 affine matrix that maps triangle (src) -> triangle (dst).
 */
function affineMatrix(
  src: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }],
  dst: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }],
): number[] {
  const [s0, s1, s2] = src;
  const [d0, d1, d2] = dst;

  // Solve: dst = M * src
  const det = (s0.x - s2.x) * (s1.y - s2.y) - (s1.x - s2.x) * (s0.y - s2.y);
  if (Math.abs(det) < 1e-10) return [1, 0, 0, 0, 1, 0]; // degenerate

  const a = ((d0.x - d2.x) * (s1.y - s2.y) - (d1.x - d2.x) * (s0.y - s2.y)) / det;
  const b = ((s0.x - s2.x) * (d1.x - d2.x) - (s1.x - s2.x) * (d0.x - d2.x)) / det;
  const tx = d0.x - a * s0.x - b * s0.y;

  const c = ((d0.y - d2.y) * (s1.y - s2.y) - (d1.y - d2.y) * (s0.y - s2.y)) / det;
  const d_ = ((s0.x - s2.x) * (d1.y - d2.y) - (s1.x - s2.x) * (d0.y - d2.y)) / det;
  const ty = d0.y - c * s0.x - d_ * s0.y;

  return [a, b, tx, c, d_, ty];
}

function pointInTriangle(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
): boolean {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

// ─── Convex hull for face mask ─────────────────────────────────────

function convexHull(points: { x: number; y: number }[]): { x: number; y: number }[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: { x: number; y: number }, a: { x: number; y: number }, b: { x: number; y: number }) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: { x: number; y: number }[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: { x: number; y: number }[] = [];
  for (const p of sorted.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

// ─── Main warp function ────────────────────────────────────────────

export interface FaceCrop {
  label: string;
  originalCropUrl: string;
  editedCropUrl: string;
  diffCropUrl: string;
}

export interface WarpResult {
  /** Data URL of the corrected image */
  correctedDataUrl: string;
  /** Data URL showing only what changed (diff visualization) */
  diffDataUrl: string;
  facesWarped: number;
  /** Per-face cropped comparisons */
  faceCrops: FaceCrop[];
}

export async function warpFacesBack(
  originalUrl: string,
  editedUrl: string,
): Promise<WarpResult> {
  await loadModels();

  const [origImg, editImg] = await Promise.all([
    loadImage(originalUrl),
    loadImage(editedUrl),
  ]);

  const [origDetections, editDetections] = await Promise.all([
    faceapi.detectAllFaces(origImg).withFaceLandmarks().withFaceDescriptors(),
    faceapi.detectAllFaces(editImg).withFaceLandmarks().withFaceDescriptors(),
  ]);

  if (origDetections.length === 0 || editDetections.length === 0) {
    throw new Error(`No faces detected (original: ${origDetections.length}, edited: ${editDetections.length})`);
  }

  // Match faces by descriptor similarity
  const matches = matchFaces(origDetections, editDetections);

  // Create output canvas starting with the edited image
  const w = editImg.width;
  const h = editImg.height;

  const outCanvas = document.createElement("canvas");
  outCanvas.width = w;
  outCanvas.height = h;
  const outCtx = outCanvas.getContext("2d")!;
  outCtx.drawImage(editImg, 0, 0);

  // Get edited image pixel data for sampling
  const editCanvas = document.createElement("canvas");
  editCanvas.width = w;
  editCanvas.height = h;
  const editCtx = editCanvas.getContext("2d")!;
  editCtx.drawImage(editImg, 0, 0);
  const editData = editCtx.getImageData(0, 0, w, h);

  // Output pixel data
  const outData = outCtx.getImageData(0, 0, w, h);

  let facesWarped = 0;

  for (const match of matches) {
    const origLandmarks = origDetections[match.origIdx].landmarks.positions;
    const editLandmarks = editDetections[match.editIdx].landmarks.positions;

    // Convert to plain objects
    const origPts = origLandmarks.map((p) => ({ x: p.x, y: p.y }));
    const editPts = editLandmarks.map((p) => ({ x: p.x, y: p.y }));

    // Add corner points of the bounding box (expanded) to anchor the warp
    const box = editDetections[match.editIdx].detection.box;
    const pad = Math.max(box.width, box.height) * 0.3;
    const corners = [
      { x: Math.max(0, box.x - pad), y: Math.max(0, box.y - pad) },
      { x: Math.min(w, box.x + box.width + pad), y: Math.max(0, box.y - pad) },
      { x: Math.max(0, box.x - pad), y: Math.min(h, box.y + box.height + pad) },
      { x: Math.min(w, box.x + box.width + pad), y: Math.min(h, box.y + box.height + pad) },
    ];

    // Source points = edited landmarks + corners (corners map to themselves)
    const srcPoints = [...editPts, ...corners];
    // Destination points = original landmarks + same corners
    const dstPoints = [...origPts, ...corners];

    // Triangulate the source points
    const tris = delaunay(srcPoints);

    // Create face mask from convex hull of the landmarks (with feathering)
    const hull = convexHull(editPts);

    // For each triangle, warp pixels from edited -> corrected position
    for (const tri of tris) {
      const srcTri: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }] = [
        dstPoints[tri.a], dstPoints[tri.b], dstPoints[tri.c],
      ];
      const dstTri: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }] = [
        srcPoints[tri.a], srcPoints[tri.b], srcPoints[tri.c],
      ];

      // Affine: for each pixel in dst triangle, find where it comes from in src
      const mat = affineMatrix(srcTri, dstTri);

      // Bounding box of the destination (output) triangle
      const xs = [srcTri[0].x, srcTri[1].x, srcTri[2].x];
      const ys = [srcTri[0].y, srcTri[1].y, srcTri[2].y];
      const minTX = Math.max(0, Math.floor(Math.min(...xs)));
      const maxTX = Math.min(w - 1, Math.ceil(Math.max(...xs)));
      const minTY = Math.max(0, Math.floor(Math.min(...ys)));
      const maxTY = Math.min(h - 1, Math.ceil(Math.max(...ys)));

      for (let y = minTY; y <= maxTY; y++) {
        for (let x = minTX; x <= maxTX; x++) {
          if (!pointInTriangle(x, y, srcTri[0].x, srcTri[0].y, srcTri[1].x, srcTri[1].y, srcTri[2].x, srcTri[2].y)) {
            continue;
          }

          // Map back to source pixel
          const sx = mat[0] * x + mat[1] * y + mat[2];
          const sy = mat[3] * x + mat[4] * y + mat[5];

          const sx0 = Math.floor(sx);
          const sy0 = Math.floor(sy);
          if (sx0 < 0 || sx0 >= w - 1 || sy0 < 0 || sy0 >= h - 1) continue;

          // Bilinear interpolation
          const fx = sx - sx0;
          const fy = sy - sy0;
          const idx00 = (sy0 * w + sx0) * 4;
          const idx10 = idx00 + 4;
          const idx01 = idx00 + w * 4;
          const idx11 = idx01 + 4;

          // Feather: distance from convex hull edge
          const alpha = featherAlpha(x, y, hull, pad * 0.4);
          if (alpha < 0.01) continue;

          for (let c = 0; c < 3; c++) {
            const v =
              editData.data[idx00 + c] * (1 - fx) * (1 - fy) +
              editData.data[idx10 + c] * fx * (1 - fy) +
              editData.data[idx01 + c] * (1 - fx) * fy +
              editData.data[idx11 + c] * fx * fy;

            const outIdx = (y * w + x) * 4 + c;
            outData.data[outIdx] = Math.round(
              outData.data[outIdx] * (1 - alpha) + v * alpha,
            );
          }
        }
      }
      facesWarped = matches.length;
    }
  }

  outCtx.putImageData(outData, 0, 0);

  // Generate diff image: amplified absolute difference between edited and corrected
  const diffCanvas = document.createElement("canvas");
  diffCanvas.width = w;
  diffCanvas.height = h;
  const diffCtx = diffCanvas.getContext("2d")!;
  const diffData = diffCtx.createImageData(w, h);

  const editPixels = editData.data;
  const outPixels = outData.data;

  for (let i = 0; i < editPixels.length; i += 4) {
    const dr = Math.abs(editPixels[i] - outPixels[i]);
    const dg = Math.abs(editPixels[i + 1] - outPixels[i + 1]);
    const db = Math.abs(editPixels[i + 2] - outPixels[i + 2]);
    const maxDiff = Math.max(dr, dg, db);

    // Amplify diff 5x for visibility, show as heat map
    const intensity = Math.min(255, maxDiff * 5);
    if (intensity < 5) {
      // No change — show dark gray
      diffData.data[i] = 20;
      diffData.data[i + 1] = 20;
      diffData.data[i + 2] = 20;
    } else {
      // Heat map: green -> yellow -> red
      diffData.data[i] = Math.min(255, intensity * 2);     // R
      diffData.data[i + 1] = Math.max(0, 255 - intensity); // G
      diffData.data[i + 2] = 0;                            // B
    }
    diffData.data[i + 3] = 255;
  }
  diffCtx.putImageData(diffData, 0, 0);

  // ── Per-face crops ──────────────────────────────────────────────
  const faceCrops: FaceCrop[] = [];

  // We need original image pixel data for cropping
  const origCanvas = document.createElement("canvas");
  origCanvas.width = origImg.width;
  origCanvas.height = origImg.height;
  const origCtx = origCanvas.getContext("2d")!;
  origCtx.drawImage(origImg, 0, 0);

  for (let mi = 0; mi < matches.length; mi++) {
    const match = matches[mi];
    const origBox = origDetections[match.origIdx].detection.box;
    const editBox = editDetections[match.editIdx].detection.box;

    // Use a unified crop region that covers both boxes with padding
    const cropPad = 0.5;
    const cropX = Math.max(0, Math.min(origBox.x, editBox.x) - Math.max(origBox.width, editBox.width) * cropPad);
    const cropY = Math.max(0, Math.min(origBox.y, editBox.y) - Math.max(origBox.height, editBox.height) * cropPad);
    const cropR = Math.min(w, Math.max(origBox.x + origBox.width, editBox.x + editBox.width) + Math.max(origBox.width, editBox.width) * cropPad);
    const cropB = Math.min(h, Math.max(origBox.y + origBox.height, editBox.y + editBox.height) + Math.max(origBox.height, editBox.height) * cropPad);
    const cropW = Math.round(cropR - cropX);
    const cropH = Math.round(cropB - cropY);
    const cx = Math.round(cropX);
    const cy = Math.round(cropY);

    if (cropW < 10 || cropH < 10) continue;

    // Crop original face
    const origCropCanvas = document.createElement("canvas");
    origCropCanvas.width = cropW;
    origCropCanvas.height = cropH;
    origCropCanvas.getContext("2d")!.drawImage(origCanvas, cx, cy, cropW, cropH, 0, 0, cropW, cropH);

    // Crop edited face
    const editCropCanvas = document.createElement("canvas");
    editCropCanvas.width = cropW;
    editCropCanvas.height = cropH;
    editCropCanvas.getContext("2d")!.drawImage(editCanvas, cx, cy, cropW, cropH, 0, 0, cropW, cropH);

    // Per-face diff heat map
    const origCropData = origCropCanvas.getContext("2d")!.getImageData(0, 0, cropW, cropH);
    const editCropData = editCropCanvas.getContext("2d")!.getImageData(0, 0, cropW, cropH);
    const faceDiffCanvas = document.createElement("canvas");
    faceDiffCanvas.width = cropW;
    faceDiffCanvas.height = cropH;
    const faceDiffData = faceDiffCanvas.getContext("2d")!.createImageData(cropW, cropH);

    for (let i = 0; i < origCropData.data.length; i += 4) {
      const dr = Math.abs(origCropData.data[i] - editCropData.data[i]);
      const dg = Math.abs(origCropData.data[i + 1] - editCropData.data[i + 1]);
      const db = Math.abs(origCropData.data[i + 2] - editCropData.data[i + 2]);
      const maxD = Math.max(dr, dg, db);
      const intensity = Math.min(255, maxD * 4);
      if (intensity < 3) {
        faceDiffData.data[i] = 20;
        faceDiffData.data[i + 1] = 20;
        faceDiffData.data[i + 2] = 20;
      } else {
        faceDiffData.data[i] = Math.min(255, intensity * 2);
        faceDiffData.data[i + 1] = Math.max(0, 255 - intensity);
        faceDiffData.data[i + 2] = 0;
      }
      faceDiffData.data[i + 3] = 255;
    }
    faceDiffCanvas.getContext("2d")!.putImageData(faceDiffData, 0, 0);

    const total = matches.length;
    const label = total === 1
      ? "Face"
      : `Face ${mi + 1} (${editBox.x + editBox.width / 2 < w * 0.33 ? "left" : editBox.x + editBox.width / 2 > w * 0.67 ? "right" : "center"})`;

    faceCrops.push({
      label,
      originalCropUrl: origCropCanvas.toDataURL("image/png"),
      editedCropUrl: editCropCanvas.toDataURL("image/png"),
      diffCropUrl: faceDiffCanvas.toDataURL("image/png"),
    });
  }

  return {
    correctedDataUrl: outCanvas.toDataURL("image/png"),
    diffDataUrl: diffCanvas.toDataURL("image/png"),
    facesWarped,
    faceCrops,
  };
}

/** Compute feather alpha based on distance from convex hull boundary */
function featherAlpha(
  x: number,
  y: number,
  hull: { x: number; y: number }[],
  featherRadius: number,
): number {
  // Check if inside hull
  let inside = true;
  let minDist = Infinity;

  for (let i = 0; i < hull.length; i++) {
    const j = (i + 1) % hull.length;
    const a = hull[i], b = hull[j];

    // Cross product to check side
    const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (cross < 0) inside = false;

    // Distance to edge segment
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((x - a.x) * dx + (y - a.y) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = a.x + t * dx, py = a.y + t * dy;
    const dist = Math.sqrt((x - px) ** 2 + (y - py) ** 2);
    minDist = Math.min(minDist, dist);
  }

  if (inside) {
    // Inside hull — full opacity near center, feather near edges
    return minDist > featherRadius ? 1.0 : minDist / featherRadius;
  } else {
    // Outside hull — feather out
    return minDist < featherRadius ? 1.0 - minDist / featherRadius : 0;
  }
}

function matchFaces(
  origFaces: faceapi.WithFaceDescriptor<faceapi.WithFaceLandmarks<{ detection: faceapi.FaceDetection }>>[],
  editFaces: faceapi.WithFaceDescriptor<faceapi.WithFaceLandmarks<{ detection: faceapi.FaceDetection }>>[],
): { origIdx: number; editIdx: number; distance: number }[] {
  const used = new Set<number>();
  const matches: { origIdx: number; editIdx: number; distance: number }[] = [];

  for (let oi = 0; oi < origFaces.length; oi++) {
    let bestDist = Infinity;
    let bestIdx = -1;
    for (let ei = 0; ei < editFaces.length; ei++) {
      if (used.has(ei)) continue;
      const d = euclidean(origFaces[oi].descriptor, editFaces[ei].descriptor);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = ei;
      }
    }
    if (bestIdx >= 0) {
      used.add(bestIdx);
      matches.push({ origIdx: oi, editIdx: bestIdx, distance: bestDist });
    }
  }
  return matches;
}

function euclidean(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

// ─── Face Restore — paste original face pixels onto edited image ───

export interface RestoreResult {
  restoredDataUrl: string;
  diffDataUrl: string;
  faceCrops: FaceCrop[];
  facesRestored: number;
}

/**
 * Restores original face pixels onto the edited image.
 * Uses Delaunay triangulation to warp the original face region
 * to match the edited face position, then blends with a feathered mask.
 *
 * This is for when the AI regenerated the face (different features/expression).
 * Unlike warpFacesBack (which shifts edited pixels), this takes ORIGINAL pixels
 * and pastes them onto the edit.
 */
export async function restoreFaces(
  originalUrl: string,
  editedUrl: string,
): Promise<RestoreResult> {
  await loadModels();

  const [origImg, editImg] = await Promise.all([
    loadImage(originalUrl),
    loadImage(editedUrl),
  ]);

  const [origDetections, editDetections] = await Promise.all([
    faceapi.detectAllFaces(origImg).withFaceLandmarks().withFaceDescriptors(),
    faceapi.detectAllFaces(editImg).withFaceLandmarks().withFaceDescriptors(),
  ]);

  if (origDetections.length === 0 || editDetections.length === 0) {
    throw new Error(`No faces detected (original: ${origDetections.length}, edited: ${editDetections.length})`);
  }

  const matches = matchFaces(origDetections, editDetections);

  const w = editImg.width;
  const h = editImg.height;

  // Read original image pixels
  const origCanvas = document.createElement("canvas");
  origCanvas.width = origImg.width;
  origCanvas.height = origImg.height;
  const origCtx = origCanvas.getContext("2d")!;
  origCtx.drawImage(origImg, 0, 0);
  const origData = origCtx.getImageData(0, 0, origImg.width, origImg.height);

  // Start with the edited image as base
  const outCanvas = document.createElement("canvas");
  outCanvas.width = w;
  outCanvas.height = h;
  const outCtx = outCanvas.getContext("2d")!;
  outCtx.drawImage(editImg, 0, 0);
  const outData = outCtx.getImageData(0, 0, w, h);

  // Also keep a copy of edited pixels for diff
  const editCanvas = document.createElement("canvas");
  editCanvas.width = w;
  editCanvas.height = h;
  editCanvas.getContext("2d")!.drawImage(editImg, 0, 0);
  const editData = editCanvas.getContext("2d")!.getImageData(0, 0, w, h);

  let facesRestored = 0;

  for (const match of matches) {
    const origLandmarks = origDetections[match.origIdx].landmarks.positions;
    const editLandmarks = editDetections[match.editIdx].landmarks.positions;

    const origPts = origLandmarks.map((p) => ({ x: p.x, y: p.y }));
    const editPts = editLandmarks.map((p) => ({ x: p.x, y: p.y }));

    // Add bounding box corners to anchor surrounding area
    const editBox = editDetections[match.editIdx].detection.box;
    const pad = Math.max(editBox.width, editBox.height) * 0.35;

    const editCorners = [
      { x: Math.max(0, editBox.x - pad), y: Math.max(0, editBox.y - pad) },
      { x: Math.min(w, editBox.x + editBox.width + pad), y: Math.max(0, editBox.y - pad) },
      { x: Math.max(0, editBox.x - pad), y: Math.min(h, editBox.y + editBox.height + pad) },
      { x: Math.min(w, editBox.x + editBox.width + pad), y: Math.min(h, editBox.y + editBox.height + pad) },
    ];

    const origBox = origDetections[match.origIdx].detection.box;
    const origPad = Math.max(origBox.width, origBox.height) * 0.35;
    const origCorners = [
      { x: Math.max(0, origBox.x - origPad), y: Math.max(0, origBox.y - origPad) },
      { x: Math.min(origImg.width, origBox.x + origBox.width + origPad), y: Math.max(0, origBox.y - origPad) },
      { x: Math.max(0, origBox.x - origPad), y: Math.min(origImg.height, origBox.y + origBox.height + origPad) },
      { x: Math.min(origImg.width, origBox.x + origBox.width + origPad), y: Math.min(origImg.height, origBox.y + origBox.height + origPad) },
    ];

    // Triangulate on the EDITED (destination) points
    const dstPoints = [...editPts, ...editCorners];
    const srcPoints = [...origPts, ...origCorners];

    const tris = delaunay(dstPoints);
    const hull = convexHull(editPts);

    // For each triangle in the edited image, sample from original image
    for (const tri of tris) {
      const dstTri: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }] = [
        dstPoints[tri.a], dstPoints[tri.b], dstPoints[tri.c],
      ];
      const srcTri: [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }] = [
        srcPoints[tri.a], srcPoints[tri.b], srcPoints[tri.c],
      ];

      // For each pixel in dst triangle, compute where to sample from src (original)
      const mat = affineMatrix(dstTri, srcTri);

      const xs = [dstTri[0].x, dstTri[1].x, dstTri[2].x];
      const ys = [dstTri[0].y, dstTri[1].y, dstTri[2].y];
      const minTX = Math.max(0, Math.floor(Math.min(...xs)));
      const maxTX = Math.min(w - 1, Math.ceil(Math.max(...xs)));
      const minTY = Math.max(0, Math.floor(Math.min(...ys)));
      const maxTY = Math.min(h - 1, Math.ceil(Math.max(...ys)));

      for (let y = minTY; y <= maxTY; y++) {
        for (let x = minTX; x <= maxTX; x++) {
          if (!pointInTriangle(x, y, dstTri[0].x, dstTri[0].y, dstTri[1].x, dstTri[1].y, dstTri[2].x, dstTri[2].y)) {
            continue;
          }

          // Map to original image coordinates
          const sx = mat[0] * x + mat[1] * y + mat[2];
          const sy = mat[3] * x + mat[4] * y + mat[5];

          const sx0 = Math.floor(sx);
          const sy0 = Math.floor(sy);
          if (sx0 < 0 || sx0 >= origImg.width - 1 || sy0 < 0 || sy0 >= origImg.height - 1) continue;

          // Feather based on distance from face hull
          const alpha = featherAlpha(x, y, hull, pad * 0.5);
          if (alpha < 0.01) continue;

          // Bilinear sample from ORIGINAL image
          const fx = sx - sx0;
          const fy = sy - sy0;
          const ow = origImg.width;
          const idx00 = (sy0 * ow + sx0) * 4;
          const idx10 = idx00 + 4;
          const idx01 = idx00 + ow * 4;
          const idx11 = idx01 + 4;

          const outIdx = (y * w + x) * 4;
          for (let c = 0; c < 3; c++) {
            const origPixel =
              origData.data[idx00 + c] * (1 - fx) * (1 - fy) +
              origData.data[idx10 + c] * fx * (1 - fy) +
              origData.data[idx01 + c] * (1 - fx) * fy +
              origData.data[idx11 + c] * fx * fy;

            outData.data[outIdx + c] = Math.round(
              outData.data[outIdx + c] * (1 - alpha) + origPixel * alpha,
            );
          }
        }
      }
    }
    facesRestored++;
  }

  outCtx.putImageData(outData, 0, 0);

  // Diff: edited vs restored
  const diffCanvas = document.createElement("canvas");
  diffCanvas.width = w;
  diffCanvas.height = h;
  const diffCtx = diffCanvas.getContext("2d")!;
  const diffData = diffCtx.createImageData(w, h);
  for (let i = 0; i < editData.data.length; i += 4) {
    const dr = Math.abs(editData.data[i] - outData.data[i]);
    const dg = Math.abs(editData.data[i + 1] - outData.data[i + 1]);
    const db = Math.abs(editData.data[i + 2] - outData.data[i + 2]);
    const maxDiff = Math.max(dr, dg, db);
    const intensity = Math.min(255, maxDiff * 5);
    if (intensity < 5) {
      diffData.data[i] = 20; diffData.data[i + 1] = 20; diffData.data[i + 2] = 20;
    } else {
      diffData.data[i] = Math.min(255, intensity * 2);
      diffData.data[i + 1] = Math.max(0, 255 - intensity);
      diffData.data[i + 2] = 0;
    }
    diffData.data[i + 3] = 255;
  }
  diffCtx.putImageData(diffData, 0, 0);

  // Per-face crops: original vs restored vs diff
  const faceCrops: FaceCrop[] = [];
  for (let mi = 0; mi < matches.length; mi++) {
    const match = matches[mi];
    const editBox = editDetections[match.editIdx].detection.box;
    const cropPad = 0.5;
    const cx = Math.max(0, Math.round(editBox.x - editBox.width * cropPad));
    const cy = Math.max(0, Math.round(editBox.y - editBox.height * cropPad));
    const cropW = Math.min(w - cx, Math.round(editBox.width * (1 + cropPad * 2)));
    const cropH = Math.min(h - cy, Math.round(editBox.height * (1 + cropPad * 2)));
    if (cropW < 10 || cropH < 10) continue;

    // Crop from edited (before restore)
    const editCrop = document.createElement("canvas");
    editCrop.width = cropW; editCrop.height = cropH;
    editCrop.getContext("2d")!.drawImage(editCanvas, cx, cy, cropW, cropH, 0, 0, cropW, cropH);

    // Crop from restored (after restore)
    const restCrop = document.createElement("canvas");
    restCrop.width = cropW; restCrop.height = cropH;
    restCrop.getContext("2d")!.drawImage(outCanvas, cx, cy, cropW, cropH, 0, 0, cropW, cropH);

    // Diff between edited crop and restored crop
    const editCropData = editCrop.getContext("2d")!.getImageData(0, 0, cropW, cropH);
    const restCropData = restCrop.getContext("2d")!.getImageData(0, 0, cropW, cropH);
    const faceDiffCanvas = document.createElement("canvas");
    faceDiffCanvas.width = cropW; faceDiffCanvas.height = cropH;
    const fdData = faceDiffCanvas.getContext("2d")!.createImageData(cropW, cropH);
    for (let i = 0; i < editCropData.data.length; i += 4) {
      const dr = Math.abs(editCropData.data[i] - restCropData.data[i]);
      const dg = Math.abs(editCropData.data[i + 1] - restCropData.data[i + 1]);
      const db = Math.abs(editCropData.data[i + 2] - restCropData.data[i + 2]);
      const maxD = Math.max(dr, dg, db);
      const intensity = Math.min(255, maxD * 4);
      if (intensity < 3) {
        fdData.data[i] = 20; fdData.data[i + 1] = 20; fdData.data[i + 2] = 20;
      } else {
        fdData.data[i] = Math.min(255, intensity * 2);
        fdData.data[i + 1] = Math.max(0, 255 - intensity);
        fdData.data[i + 2] = 0;
      }
      fdData.data[i + 3] = 255;
    }
    faceDiffCanvas.getContext("2d")!.putImageData(fdData, 0, 0);

    const total = matches.length;
    const label = total === 1
      ? "Face"
      : `Face ${mi + 1} (${editBox.x + editBox.width / 2 < w * 0.33 ? "left" : editBox.x + editBox.width / 2 > w * 0.67 ? "right" : "center"})`;

    faceCrops.push({
      label,
      originalCropUrl: editCrop.toDataURL("image/png"),  // "before" = edited (AI-changed face)
      editedCropUrl: restCrop.toDataURL("image/png"),     // "after" = restored (original face pasted back)
      diffCropUrl: faceDiffCanvas.toDataURL("image/png"),
    });
  }

  return {
    restoredDataUrl: outCanvas.toDataURL("image/png"),
    diffDataUrl: diffCanvas.toDataURL("image/png"),
    facesRestored,
    faceCrops,
  };
}
