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

export interface FaceCheckResult {
  distance: number;
  verdict: "pass" | "warning" | "fail";
  verdictLabel: string;
  groups: Record<string, { avg: number; max: number }>;
  noFaceOriginal: boolean;
  noFaceEdited: boolean;
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

export async function runFaceCheck(
  originalUrl: string,
  editedUrl: string,
): Promise<FaceCheckResult> {
  await loadModels();

  const [origImg, editImg] = await Promise.all([
    loadImageElement(originalUrl),
    loadImageElement(editedUrl),
  ]);

  const [origDetection, editDetection] = await Promise.all([
    faceapi
      .detectSingleFace(origImg)
      .withFaceLandmarks()
      .withFaceDescriptor(),
    faceapi
      .detectSingleFace(editImg)
      .withFaceLandmarks()
      .withFaceDescriptor(),
  ]);

  if (!origDetection) {
    return {
      distance: -1,
      verdict: "pass",
      verdictLabel: "No face in original",
      groups: {},
      noFaceOriginal: true,
      noFaceEdited: !editDetection,
    };
  }

  if (!editDetection) {
    return {
      distance: -1,
      verdict: "fail",
      verdictLabel: "Face lost in edit",
      groups: {},
      noFaceOriginal: false,
      noFaceEdited: true,
    };
  }

  const distance = euclidean(origDetection.descriptor, editDetection.descriptor);
  const groups = analyzeLandmarkShifts(
    origDetection.landmarks.positions,
    editDetection.landmarks.positions,
  );

  let verdict: "pass" | "warning" | "fail";
  let verdictLabel: string;
  if (distance < 0.4) {
    verdict = "pass";
    verdictLabel = "Face preserved";
  } else if (distance < 0.6) {
    verdict = "warning";
    verdictLabel = "Subtle face drift";
  } else {
    verdict = "fail";
    verdictLabel = "Face shifted";
  }

  return { distance, verdict, verdictLabel, groups, noFaceOriginal: false, noFaceEdited: false };
}
