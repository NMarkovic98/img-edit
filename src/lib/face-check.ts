import * as faceapi from "@vladmandic/face-api";

let modelsLoaded = false;

const LANDMARK_GROUPS: Record<string, [number, number]> = {
  jaw: [0, 16],
  left_eyebrow: [17, 21],
  right_eyebrow: [22, 26],
  nose_bridge: [27, 30],
  nose_tip: [31, 35],
  left_eye: [36, 41],
  right_eye: [42, 47],
  outer_lip: [48, 59],
  inner_lip: [60, 67],
};

export interface SingleFaceResult {
  label: string; // e.g. "Face 1 (left)", "Face 2 (right)"
  distance: number;
  verdict: "pass" | "warning" | "fail";
  verdictLabel: string;
  groups: Record<string, { avg: number; max: number }>;
  boundingBox: { x: number; y: number; width: number; height: number };
}

export interface FaceCheckResult {
  /** Overall worst verdict across all faces */
  distance: number;
  verdict: "pass" | "warning" | "fail";
  verdictLabel: string;
  groups: Record<string, { avg: number; max: number }>;
  noFaceOriginal: boolean;
  noFaceEdited: boolean;
  /** Per-face breakdown (populated when multiple faces detected) */
  faces: SingleFaceResult[];
  facesDetectedOriginal: number;
  facesDetectedEdited: number;
}

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

function euclidean(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

function analyzeLandmarkShifts(
  origPts: faceapi.Point[],
  editPts: faceapi.Point[],
): Record<string, { avg: number; max: number }> {
  const normalize = (pts: faceapi.Point[]) => {
    const nose = pts[30];
    const leftEye = pts[36];
    const rightEye = pts[45];
    const eyeDist = Math.sqrt(
      (rightEye.x - leftEye.x) ** 2 + (rightEye.y - leftEye.y) ** 2,
    );
    return pts.map((p) => ({
      x: (p.x - nose.x) / eyeDist,
      y: (p.y - nose.y) / eyeDist,
    }));
  };

  const normOrig = normalize(origPts);
  const normEdit = normalize(editPts);

  const shifts = normOrig.map((o, i) => {
    const e = normEdit[i];
    return Math.sqrt((o.x - e.x) ** 2 + (o.y - e.y) ** 2);
  });

  const groups: Record<string, { avg: number; max: number }> = {};
  for (const [name, [start, end]] of Object.entries(LANDMARK_GROUPS)) {
    const g = shifts.slice(start, end + 1);
    groups[name] = {
      avg: +(g.reduce((a, b) => a + b, 0) / g.length).toFixed(4),
      max: +Math.max(...g).toFixed(4),
    };
  }
  return groups;
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

async function loadImageElement(url: string): Promise<HTMLImageElement> {
  const src = proxyUrl(url);
  return new Promise((resolve, reject) => {
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error(`Failed to load image: ${url}`));
    img.src = src;
  });
}

function classifyVerdict(distance: number): { verdict: "pass" | "warning" | "fail"; verdictLabel: string } {
  if (distance < 0.4) return { verdict: "pass", verdictLabel: "Face preserved" };
  if (distance < 0.6) return { verdict: "warning", verdictLabel: "Subtle face drift" };
  return { verdict: "fail", verdictLabel: "Face shifted" };
}

function faceLabel(index: number, box: faceapi.Box, imageWidth: number, total: number): string {
  if (total === 1) return "Face";
  const centerX = box.x + box.width / 2;
  const position = centerX < imageWidth * 0.33 ? "left" : centerX > imageWidth * 0.67 ? "right" : "center";
  return `Face ${index + 1} (${position})`;
}

/**
 * Match each original face to the closest edited face by descriptor similarity.
 * Uses greedy nearest-neighbor (good enough for typical 2-5 faces).
 */
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

export async function runFaceCheck(
  originalUrl: string,
  editedUrl: string,
): Promise<FaceCheckResult> {
  await loadModels();

  const [origImg, editImg] = await Promise.all([
    loadImageElement(originalUrl),
    loadImageElement(editedUrl),
  ]);

  const [origDetections, editDetections] = await Promise.all([
    faceapi.detectAllFaces(origImg).withFaceLandmarks().withFaceDescriptors(),
    faceapi.detectAllFaces(editImg).withFaceLandmarks().withFaceDescriptors(),
  ]);

  const emptyResult = (
    verdict: "pass" | "fail",
    label: string,
    noOrig: boolean,
    noEdit: boolean,
  ): FaceCheckResult => ({
    distance: -1, verdict, verdictLabel: label, groups: {},
    noFaceOriginal: noOrig, noFaceEdited: noEdit,
    faces: [], facesDetectedOriginal: origDetections.length, facesDetectedEdited: editDetections.length,
  });

  if (origDetections.length === 0) {
    return emptyResult("pass", "No face in original", true, editDetections.length === 0);
  }
  if (editDetections.length === 0) {
    return emptyResult("fail", "All faces lost in edit", false, true);
  }

  // Match original faces to edited faces by descriptor similarity
  const matches = matchFaces(origDetections, editDetections);

  // Build per-face results
  const faceResults: SingleFaceResult[] = matches.map((m) => {
    const orig = origDetections[m.origIdx];
    const edit = editDetections[m.editIdx];
    const groups = analyzeLandmarkShifts(orig.landmarks.positions, edit.landmarks.positions);
    const box = orig.detection.box;
    const { verdict, verdictLabel } = classifyVerdict(m.distance);

    return {
      label: faceLabel(m.origIdx, box, origImg.width, origDetections.length),
      distance: m.distance,
      verdict,
      verdictLabel,
      groups,
      boundingBox: { x: box.x, y: box.y, width: box.width, height: box.height },
    };
  });

  // Sort by position (left to right)
  faceResults.sort((a, b) => a.boundingBox.x - b.boundingBox.x);

  // Overall verdict = worst across all faces
  // Use a combined score: descriptor distance + max landmark shift avg
  const severityScore = (f: SingleFaceResult) => {
    const maxLandmarkAvg = Object.values(f.groups).reduce((m, g) => Math.max(m, g.avg), 0);
    // Verdict priority: fail=2, warning=1, pass=0
    const verdictPrio = f.verdict === "fail" ? 2 : f.verdict === "warning" ? 1 : 0;
    return verdictPrio * 1000 + f.distance + maxLandmarkAvg * 2;
  };
  const worstFace = faceResults.reduce((worst, f) =>
    severityScore(f) > severityScore(worst) ? f : worst, faceResults[0]);

  return {
    distance: worstFace.distance,
    verdict: worstFace.verdict,
    verdictLabel: faceResults.length > 1
      ? `${worstFace.verdictLabel} (${worstFace.label})`
      : worstFace.verdictLabel,
    groups: worstFace.groups,
    noFaceOriginal: false,
    noFaceEdited: false,
    faces: faceResults,
    facesDetectedOriginal: origDetections.length,
    facesDetectedEdited: editDetections.length,
  };
}
