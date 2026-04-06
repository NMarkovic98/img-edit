#!/usr/bin/env node
/**
 * Face biometric comparison script.
 *
 * Usage:
 *   node scripts/face-check.mjs <original_image> <edited_image>
 *
 * Accepts local file paths or URLs.
 * Outputs:
 *   - Euclidean distance between face descriptors
 *   - Per-landmark shift heatmap (which facial features moved most)
 *   - Visual comparison image saved to face-check-result.png
 *
 * Thresholds:
 *   distance < 0.4  → SAME person (face preserved)
 *   distance 0.4-0.6 → WARNING (subtle drift)
 *   distance > 0.6  → DIFFERENT person (face shifted)
 */

import * as faceapi from "@vladmandic/face-api";
import canvas from "canvas";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const { Canvas, Image, ImageData, createCanvas, loadImage } = canvas;

// Patch face-api to use node-canvas
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MODEL_DIR = path.join(__dirname, "..", "node_modules", "@vladmandic", "face-api", "model");

// Landmark group labels for the 68-point model
const LANDMARK_GROUPS = {
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

async function loadModels() {
  await faceapi.nets.ssdMobilenetv1.loadFromDisk(MODEL_DIR);
  await faceapi.nets.faceLandmark68Net.loadFromDisk(MODEL_DIR);
  await faceapi.nets.faceRecognitionNet.loadFromDisk(MODEL_DIR);
}

async function loadImg(source) {
  if (source.startsWith("http://") || source.startsWith("https://")) {
    const res = await fetch(source);
    const buf = Buffer.from(await res.arrayBuffer());
    return loadImage(buf);
  }
  return loadImage(source);
}

function euclidean(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum);
}

function analyzeLandmarkShifts(origLandmarks, editLandmarks) {
  const origPts = origLandmarks.positions;
  const editPts = editLandmarks.positions;

  // Normalize: translate so nose tip (point 30) is at origin, scale by inter-eye distance
  const normalize = (pts) => {
    const noseTip = pts[30];
    const leftEye = pts[36];
    const rightEye = pts[45];
    const eyeDist = Math.sqrt((rightEye.x - leftEye.x) ** 2 + (rightEye.y - leftEye.y) ** 2);
    return pts.map((p) => ({
      x: (p.x - noseTip.x) / eyeDist,
      y: (p.y - noseTip.y) / eyeDist,
    }));
  };

  const normOrig = normalize(origPts);
  const normEdit = normalize(editPts);

  // Per-point shifts
  const shifts = normOrig.map((o, i) => {
    const e = normEdit[i];
    return Math.sqrt((o.x - e.x) ** 2 + (o.y - e.y) ** 2);
  });

  // Group analysis
  const groupShifts = {};
  for (const [name, [start, end]] of Object.entries(LANDMARK_GROUPS)) {
    const groupPts = shifts.slice(start, end + 1);
    const avg = groupPts.reduce((a, b) => a + b, 0) / groupPts.length;
    const max = Math.max(...groupPts);
    groupShifts[name] = { avg: +avg.toFixed(4), max: +max.toFixed(4) };
  }

  return { perPoint: shifts, groups: groupShifts };
}

async function drawComparison(origImg, editImg, origDetection, editDetection, shiftData, distance) {
  const W = 800;
  const scale = W / origImg.width;
  const H = Math.round(origImg.height * scale);
  const totalW = W * 2 + 40; // side by side + gap
  const totalH = H + 160; // extra for info

  const out = createCanvas(totalW, totalH);
  const ctx = out.getContext("2d");
  ctx.fillStyle = "#1a1a2e";
  ctx.fillRect(0, 0, totalW, totalH);

  // Draw images
  ctx.drawImage(origImg, 0, 0, W, H);
  ctx.drawImage(editImg, W + 40, 0, W, H);

  // Labels
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 16px sans-serif";
  ctx.fillText("ORIGINAL", 10, H + 25);
  ctx.fillText("EDITED", W + 50, H + 25);

  // Draw landmarks on both
  const drawLandmarks = (detection, offsetX) => {
    const pts = detection.landmarks.positions;
    for (let i = 0; i < pts.length; i++) {
      const x = pts[i].x * scale + offsetX;
      const y = pts[i].y * scale;

      // Color by shift amount (green=good, yellow=warning, red=bad)
      const shift = shiftData.perPoint[i];
      const r = Math.min(255, Math.round(shift * 800));
      const g = Math.max(0, 255 - Math.round(shift * 800));
      ctx.fillStyle = `rgb(${r}, ${g}, 60)`;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  drawLandmarks(origDetection, 0);
  drawLandmarks(editDetection, W + 40);

  // Info panel
  const yStart = H + 45;
  ctx.font = "bold 20px sans-serif";
  const verdict = distance < 0.4 ? "SAME PERSON" : distance < 0.6 ? "WARNING — SUBTLE DRIFT" : "DIFFERENT PERSON";
  const verdictColor = distance < 0.4 ? "#00ff88" : distance < 0.6 ? "#ffaa00" : "#ff4444";
  ctx.fillStyle = verdictColor;
  ctx.fillText(`${verdict}  (distance: ${distance.toFixed(4)})`, 10, yStart);

  // Group shifts
  ctx.font = "13px monospace";
  ctx.fillStyle = "#cccccc";
  let y = yStart + 28;
  const groups = Object.entries(shiftData.groups).sort((a, b) => b[1].avg - a[1].avg);
  for (const [name, data] of groups) {
    const bar = "█".repeat(Math.min(30, Math.round(data.avg * 100)));
    const color = data.avg < 0.03 ? "#00ff88" : data.avg < 0.08 ? "#ffaa00" : "#ff4444";
    ctx.fillStyle = color;
    ctx.fillText(`${name.padEnd(16)} avg:${data.avg.toFixed(4)}  max:${data.max.toFixed(4)}  ${bar}`, 10, y);
    y += 18;
  }

  return out;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.log("Usage: node scripts/face-check.mjs <original> <edited>");
    console.log("  Accepts file paths or URLs.");
    process.exit(1);
  }

  console.log("Loading face detection models...");
  await loadModels();

  console.log("Loading images...");
  const [origImg, editImg] = await Promise.all([loadImg(args[0]), loadImg(args[1])]);

  console.log(`Original: ${origImg.width}x${origImg.height}`);
  console.log(`Edited:   ${editImg.width}x${editImg.height}`);

  console.log("Detecting faces...");
  const origDetection = await faceapi
    .detectSingleFace(origImg)
    .withFaceLandmarks()
    .withFaceDescriptor();

  const editDetection = await faceapi
    .detectSingleFace(editImg)
    .withFaceLandmarks()
    .withFaceDescriptor();

  if (!origDetection) {
    console.error("❌ No face detected in ORIGINAL image.");
    process.exit(1);
  }
  if (!editDetection) {
    console.error("❌ No face detected in EDITED image.");
    process.exit(1);
  }

  // Biometric comparison
  const distance = euclidean(origDetection.descriptor, editDetection.descriptor);

  console.log("\n═══════════════════════════════════════════");
  console.log("  FACE BIOMETRIC COMPARISON");
  console.log("═══════════════════════════════════════════");
  console.log(`  Euclidean Distance: ${distance.toFixed(4)}`);
  console.log(`  Threshold:  < 0.4 = same person`);
  console.log(`              0.4-0.6 = subtle drift`);
  console.log(`              > 0.6 = different person`);

  if (distance < 0.4) {
    console.log(`\n  ✅ PASS — Face preserved (${distance.toFixed(4)})`);
  } else if (distance < 0.6) {
    console.log(`\n  ⚠️  WARNING — Subtle face drift (${distance.toFixed(4)})`);
  } else {
    console.log(`\n  ❌ FAIL — Face shifted significantly (${distance.toFixed(4)})`);
  }

  // Landmark shift analysis
  const shiftData = analyzeLandmarkShifts(origDetection.landmarks, editDetection.landmarks);

  console.log("\n═══════════════════════════════════════════");
  console.log("  LANDMARK SHIFT ANALYSIS (normalized)");
  console.log("═══════════════════════════════════════════");

  const sorted = Object.entries(shiftData.groups).sort((a, b) => b[1].avg - a[1].avg);
  for (const [name, data] of sorted) {
    const indicator = data.avg < 0.03 ? "✅" : data.avg < 0.08 ? "⚠️ " : "❌";
    console.log(`  ${indicator} ${name.padEnd(16)} avg: ${data.avg.toFixed(4)}  max: ${data.max.toFixed(4)}`);
  }

  // Draw visual comparison
  console.log("\nGenerating visual comparison...");
  const resultCanvas = await drawComparison(origImg, editImg, origDetection, editDetection, shiftData, distance);

  const outPath = path.join(process.cwd(), "face-check-result.png");
  const buf = resultCanvas.toBuffer("image/png");
  fs.writeFileSync(outPath, buf);
  console.log(`\n📊 Visual comparison saved to: ${outPath}`);

  // Exit code reflects result
  process.exit(distance > 0.6 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
