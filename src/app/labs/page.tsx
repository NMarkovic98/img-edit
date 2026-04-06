"use client";

import { useState, useRef, useEffect } from "react";
import type { FaceCheckResult } from "@/lib/face-check";

const TEST_POST_URL = "https://www.reddit.com/r/test12331/comments/1sbijra/test/";

export default function LabsPage() {
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [redditUrl, setRedditUrl] = useState(TEST_POST_URL);
  const [botUrl, setBotUrl] = useState("");
  const [status, setStatus] = useState<string>("");
  const [progress, setProgress] = useState<string>("");
  const [logs, setLogs] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  // Face Check state
  const [fcOriginal, setFcOriginal] = useState<string | null>(null);
  const [fcEdited, setFcEdited] = useState<string | null>(null);
  const [fcResult, setFcResult] = useState<FaceCheckResult | null>(null);
  const [fcRunning, setFcRunning] = useState(false);
  const fcOrigRef = useRef<HTMLInputElement>(null);
  const fcEditRef = useRef<HTMLInputElement>(null);

  // Face Warp state
  const [warpRunning, setWarpRunning] = useState(false);
  const [warpResult, setWarpResult] = useState<{
    correctedDataUrl: string;
    diffDataUrl: string;
    facesWarped: number;
    faceCrops: { label: string; originalCropUrl: string; editedCropUrl: string; diffCropUrl: string }[];
  } | null>(null);
  const [warpPreviewMode, setWarpPreviewMode] = useState<"corrected" | "diff" | "sidebyside" | "facecrops">("facecrops");

  useEffect(() => {
    const saved = localStorage.getItem("bot_url");
    setBotUrl((process.env.NEXT_PUBLIC_BOT_URL || saved || "http://localhost:3099").trim());
  }, []);

  function log(msg: string) {
    const ts = new Date().toLocaleTimeString();
    setLogs((prev) => [`[${ts}] ${msg}`, ...prev]);
  }

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImageFile(file);
    const url = URL.createObjectURL(file);
    setImagePreview(url);
    log(`Selected: ${file.name} (${(file.size / 1024).toFixed(0)} KB)`);
  }

  async function sendToBot() {
    if (!imageFile) {
      log("ERROR: No image selected");
      return;
    }
    if (!redditUrl.trim()) {
      log("ERROR: No Reddit URL");
      return;
    }

    setStatus("sending");
    setProgress("Preparing image...");
    log(`Sending to bot at ${botUrl}/reply ...`);
    log(`Reddit URL: ${redditUrl}`);

    try {
      setProgress("Uploading image to bot server...");
      const formData = new FormData();
      const safeName = (imageFile.name || "upload.jpg").replace(/[^\w.\-]+/g, "_");
      formData.append("image", imageFile, safeName);
      formData.append("redditUrl", redditUrl);
      const paypal = localStorage.getItem("paypal_link") || "";
      if (paypal) formData.append("paypalLink", paypal);
      const secret = localStorage.getItem("bot_secret") || process.env.NEXT_PUBLIC_BOT_SECRET || "";
      if (secret) formData.append("secret", secret);

      setProgress("Bot is opening Reddit post...");

      const startTime = Date.now();
      const progressInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        if (elapsed < 5) setProgress("Bot is opening Reddit post...");
        else if (elapsed < 10) setProgress("Bot is clicking comment box...");
        else if (elapsed < 15) setProgress("Bot is uploading image to Reddit...");
        else if (elapsed < 22) setProgress("Bot is waiting for image upload...");
        else if (elapsed < 28) setProgress("Bot is typing comment text...");
        else if (elapsed < 35) setProgress("Bot is submitting comment...");
        else setProgress("Almost done, waiting for confirmation...");
      }, 1000);

      const cleanBotUrl = botUrl.trim().replace(/\/$/, "");
      const res = await fetch(`${cleanBotUrl}/reply`, {
        method: "POST",
        body: formData,
      });

      clearInterval(progressInterval);

      const data = await res.json();

      if (data.success) {
        setStatus("success");
        setProgress("Comment posted successfully!");
        log("SUCCESS: Reply posted to Reddit!");
      } else {
        setStatus("error");
        setProgress("Failed to post comment");
        log(`FAILED: ${data.error || "Unknown error"}`);
        if (data.screenshot) log(`Screenshot saved: ${data.screenshot}`);
      }
    } catch (err: any) {
      setStatus("error");
      setProgress("Connection failed");
      log(`CONNECTION ERROR: ${err.message}`);
    }
  }

  async function checkHealth() {
    log(`Checking bot health at ${botUrl}/health ...`);
    setProgress("Checking bot connection...");
    try {
      const res = await fetch(`${botUrl}/health`);
      const data = await res.json();
      const msg = data.ok ? "ONLINE" : "OFFLINE";
      log(`Bot status: ${msg}`);
      setProgress(data.ok ? "Bot is online!" : "Bot is offline");
    } catch (err: any) {
      log(`Bot unreachable: ${err.message}`);
      setProgress("Bot unreachable");
    }
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-white p-4 sm:p-8">
      <div className="max-w-2xl mx-auto space-y-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold">Reddit Bot Labs</h1>
          <p className="text-zinc-400 text-xs sm:text-sm mt-1">
            Test sending images to the Reddit reply bot
          </p>
        </div>

        {/* Progress banner */}
        {progress && (
          <div
            className={`rounded-lg p-3 text-sm font-medium flex items-center gap-3 ${
              status === "success"
                ? "bg-green-900/50 text-green-300 border border-green-700"
                : status === "error"
                ? "bg-red-900/50 text-red-300 border border-red-700"
                : "bg-yellow-900/50 text-yellow-300 border border-yellow-700"
            }`}
          >
            {status === "sending" && (
              <svg
                className="animate-spin h-5 w-5 shrink-0"
                viewBox="0 0 24 24"
                fill="none"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
            )}
            {status === "success" && <span className="text-lg">✓</span>}
            {status === "error" && <span className="text-lg">✕</span>}
            <span>{progress}</span>
          </div>
        )}

        {/* Bot connection */}
        <div className="bg-zinc-900 rounded-lg p-3 sm:p-4 space-y-2">
          <h2 className="font-semibold text-xs text-zinc-400 uppercase">
            Bot Server
          </h2>
          <div className="flex gap-2">
            <input
              type="text"
              value={botUrl}
              onChange={(e) => {
                setBotUrl(e.target.value);
                localStorage.setItem("bot_url", e.target.value.trim());
              }}
              className="flex-1 bg-zinc-800 rounded px-3 py-2 text-sm border border-zinc-700 min-w-0"
              placeholder="http://localhost:3099"
            />
            <button
              onClick={checkHealth}
              className="px-3 py-2 bg-zinc-700 hover:bg-zinc-600 rounded text-sm whitespace-nowrap"
            >
              Check
            </button>
          </div>
        </div>

        {/* Reddit URL */}
        <div className="bg-zinc-900 rounded-lg p-3 sm:p-4 space-y-2">
          <h2 className="font-semibold text-xs text-zinc-400 uppercase">
            Reddit Post URL
          </h2>
          <input
            type="text"
            value={redditUrl}
            onChange={(e) => setRedditUrl(e.target.value)}
            className="w-full bg-zinc-800 rounded px-3 py-2 text-sm border border-zinc-700"
            placeholder="https://www.reddit.com/r/..."
          />
        </div>

        {/* Image upload */}
        <div className="bg-zinc-900 rounded-lg p-3 sm:p-4 space-y-2">
          <h2 className="font-semibold text-xs text-zinc-400 uppercase">
            Image
          </h2>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            onChange={handleFile}
            className="hidden"
          />
          <button
            onClick={() => fileRef.current?.click()}
            className="w-full px-4 py-3 bg-zinc-700 hover:bg-zinc-600 rounded text-sm border border-dashed border-zinc-500"
          >
            {imageFile ? imageFile.name : "Tap to choose image"}
          </button>
          {imagePreview && (
            <img
              src={imagePreview}
              alt="Preview"
              className="max-h-48 rounded border border-zinc-700 mx-auto"
            />
          )}
        </div>

        {/* Send button */}
        <button
          onClick={sendToBot}
          disabled={!imageFile || !redditUrl || status === "sending"}
          className={`w-full py-4 rounded-lg font-semibold text-sm transition-colors ${
            status === "sending"
              ? "bg-yellow-600 cursor-wait animate-pulse"
              : status === "success"
              ? "bg-green-600 hover:bg-green-700"
              : status === "error"
              ? "bg-red-600 hover:bg-red-700"
              : "bg-orange-600 hover:bg-orange-700"
          } disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          {status === "sending"
            ? "Posting to Reddit..."
            : status === "success"
            ? "Sent! Send again?"
            : "Send to Reddit Bot"}
        </button>

        {/* Logs */}
        <div className="bg-zinc-900 rounded-lg p-3 sm:p-4 space-y-2">
          <div className="flex justify-between items-center">
            <h2 className="font-semibold text-xs text-zinc-400 uppercase">
              Logs
            </h2>
            <button
              onClick={() => setLogs([])}
              className="text-xs text-zinc-500 hover:text-zinc-300"
            >
              Clear
            </button>
          </div>
          <div className="bg-black rounded p-3 max-h-48 overflow-y-auto font-mono text-xs space-y-1">
            {logs.length === 0 ? (
              <span className="text-zinc-600">No logs yet...</span>
            ) : (
              logs.map((l, i) => (
                <div
                  key={i}
                  className={
                    l.includes("ERROR") ||
                    l.includes("FAILED") ||
                    l.includes("CONNECTION ERROR")
                      ? "text-red-400"
                      : l.includes("SUCCESS")
                      ? "text-green-400"
                      : "text-zinc-400"
                  }
                >
                  {l}
                </div>
              ))
            )}
          </div>
        </div>

        {/* ── Face Check ── */}
        <div className="border-t border-zinc-800 pt-6 mt-6">
          <h1 className="text-xl sm:text-2xl font-bold">Face Check</h1>
          <p className="text-zinc-400 text-xs sm:text-sm mt-1">
            Biometric face comparison — upload two images to compare. Runs locally, no API cost.
          </p>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {/* Original */}
          <div className="bg-zinc-900 rounded-lg p-3 space-y-2">
            <h2 className="font-semibold text-xs text-zinc-400 uppercase">Original</h2>
            <input
              ref={fcOrigRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  setFcOriginal(URL.createObjectURL(f));
                  setFcResult(null); setWarpResult(null);
                }
              }}
            />
            <button
              onClick={() => fcOrigRef.current?.click()}
              className="w-full px-3 py-2 bg-zinc-700 hover:bg-zinc-600 rounded text-sm border border-dashed border-zinc-500"
            >
              {fcOriginal ? "Change" : "Upload original"}
            </button>
            {fcOriginal && (
              <img src={fcOriginal} alt="Original" className="max-h-48 rounded border border-zinc-700 mx-auto" />
            )}
          </div>

          {/* Edited */}
          <div className="bg-zinc-900 rounded-lg p-3 space-y-2">
            <h2 className="font-semibold text-xs text-zinc-400 uppercase">Edited</h2>
            <input
              ref={fcEditRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) {
                  setFcEdited(URL.createObjectURL(f));
                  setFcResult(null); setWarpResult(null);
                }
              }}
            />
            <button
              onClick={() => fcEditRef.current?.click()}
              className="w-full px-3 py-2 bg-zinc-700 hover:bg-zinc-600 rounded text-sm border border-dashed border-zinc-500"
            >
              {fcEdited ? "Change" : "Upload edited"}
            </button>
            {fcEdited && (
              <img src={fcEdited} alt="Edited" className="max-h-48 rounded border border-zinc-700 mx-auto" />
            )}
          </div>
        </div>

        {/* URL inputs for remote images */}
        <div className="bg-zinc-900 rounded-lg p-3 sm:p-4 space-y-2">
          <h2 className="font-semibold text-xs text-zinc-400 uppercase">Or paste image URLs</h2>
          <input
            type="text"
            placeholder="Original image URL"
            className="w-full bg-zinc-800 rounded px-3 py-2 text-sm border border-zinc-700"
            onBlur={(e) => {
              if (e.target.value.trim()) {
                setFcOriginal(e.target.value.trim());
                setFcResult(null); setWarpResult(null);
              }
            }}
          />
          <input
            type="text"
            placeholder="Edited image URL"
            className="w-full bg-zinc-800 rounded px-3 py-2 text-sm border border-zinc-700"
            onBlur={(e) => {
              if (e.target.value.trim()) {
                setFcEdited(e.target.value.trim());
                setFcResult(null); setWarpResult(null);
              }
            }}
          />
        </div>

        {/* Run button */}
        <button
          disabled={!fcOriginal || !fcEdited || fcRunning}
          onClick={async () => {
            if (!fcOriginal || !fcEdited) return;
            setFcRunning(true);
            setFcResult(null);
            try {
              const { runFaceCheck } = await import("@/lib/face-check");
              const result = await runFaceCheck(fcOriginal, fcEdited);
              setFcResult(result);
            } catch (err: any) {
              alert("Face check failed: " + (err.message || "Unknown error"));
            }
            setFcRunning(false);
          }}
          className={`w-full py-4 rounded-lg font-semibold text-sm transition-colors ${
            fcRunning
              ? "bg-blue-600 cursor-wait animate-pulse"
              : "bg-blue-600 hover:bg-blue-700"
          } disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          {fcRunning ? "Analyzing faces..." : "Run Face Check"}
        </button>

        {/* Results */}
        {fcResult && (
          <div className="bg-zinc-900 rounded-lg p-4 space-y-3">
            {/* Verdict */}
            <div className="flex items-center justify-between">
              <span className="text-zinc-400 text-sm">Verdict</span>
              <span
                className={`px-3 py-1 rounded-full text-sm font-bold ${
                  fcResult.verdict === "pass"
                    ? "bg-green-900/50 text-green-300 border border-green-700"
                    : fcResult.verdict === "warning"
                    ? "bg-yellow-900/50 text-yellow-300 border border-yellow-700"
                    : "bg-red-900/50 text-red-300 border border-red-700"
                }`}
              >
                {fcResult.verdictLabel}
              </span>
            </div>

            {/* Distance */}
            {fcResult.distance >= 0 && (
              <div className="flex items-center justify-between">
                <span className="text-zinc-400 text-sm">Euclidean Distance</span>
                <span className="font-mono text-sm">
                  <span
                    className={
                      fcResult.distance < 0.4
                        ? "text-green-400"
                        : fcResult.distance < 0.6
                        ? "text-yellow-400"
                        : "text-red-400"
                    }
                  >
                    {fcResult.distance.toFixed(4)}
                  </span>
                  <span className="text-zinc-500 ml-2 text-xs">(&lt;0.4 same / &gt;0.6 different)</span>
                </span>
              </div>
            )}

            {/* Per-face breakdown for multi-face images */}
            {(fcResult as any).faces && (fcResult as any).faces.length > 1 ? (
              <div className="space-y-3 pt-2 border-t border-zinc-800">
                <h3 className="text-xs text-zinc-400 uppercase font-semibold">
                  {(fcResult as any).facesDetectedOriginal} faces detected — per-face shifts
                </h3>
                {(fcResult as any).faces.map((face: any) => (
                  <div key={face.label} className="space-y-1 pl-3 border-l-2 border-zinc-700">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">{face.label}</span>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${
                        face.verdict === "pass" ? "bg-green-900/50 text-green-300 border border-green-700"
                          : face.verdict === "warning" ? "bg-yellow-900/50 text-yellow-300 border border-yellow-700"
                          : "bg-red-900/50 text-red-300 border border-red-700"
                      }`}>
                        {face.distance.toFixed(4)}
                      </span>
                    </div>
                    {Object.entries(face.groups as Record<string, { avg: number; max: number }>)
                      .sort(([, a], [, b]) => b.avg - a.avg)
                      .map(([name, data]) => (
                        <div key={name} className="flex items-center gap-2 text-xs">
                          <span className="text-zinc-400 w-28">{name.replace(/_/g, " ")}</span>
                          <div className="flex-1 bg-zinc-800 rounded-full h-2 overflow-hidden">
                            <div
                              className={`h-full rounded-full ${data.avg < 0.03 ? "bg-green-500" : data.avg < 0.08 ? "bg-yellow-500" : "bg-red-500"}`}
                              style={{ width: `${Math.min(100, data.avg * 500)}%` }}
                            />
                          </div>
                          <span className={`font-mono w-14 text-right ${data.avg < 0.03 ? "text-green-400" : data.avg < 0.08 ? "text-yellow-400" : "text-red-400"}`}>
                            {data.avg.toFixed(4)}
                          </span>
                        </div>
                      ))}
                  </div>
                ))}
              </div>
            ) : Object.keys(fcResult.groups).length > 0 ? (
              <div className="space-y-1 pt-2 border-t border-zinc-800">
                <h3 className="text-xs text-zinc-400 uppercase font-semibold mb-2">
                  Landmark Shifts (normalized)
                </h3>
                {Object.entries(fcResult.groups)
                  .sort(([, a], [, b]) => b.avg - a.avg)
                  .map(([name, data]) => (
                    <div key={name} className="flex items-center gap-2 text-xs">
                      <span className="text-zinc-400 w-28">{name.replace(/_/g, " ")}</span>
                      <div className="flex-1 bg-zinc-800 rounded-full h-2 overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            data.avg < 0.03
                              ? "bg-green-500"
                              : data.avg < 0.08
                              ? "bg-yellow-500"
                              : "bg-red-500"
                          }`}
                          style={{ width: `${Math.min(100, data.avg * 500)}%` }}
                        />
                      </div>
                      <span
                        className={`font-mono w-14 text-right ${
                          data.avg < 0.03
                            ? "text-green-400"
                            : data.avg < 0.08
                            ? "text-yellow-400"
                            : "text-red-400"
                        }`}
                      >
                        {data.avg.toFixed(4)}
                      </span>
                    </div>
                  ))}
              </div>
            ) : null}
          </div>
        )}

        {/* Fix Faces button — appears after face check when faces exist */}
        {fcResult && fcOriginal && fcEdited && !fcResult.noFaceOriginal && !fcResult.noFaceEdited && (
          <button
            disabled={warpRunning}
            onClick={async () => {
              if (!fcOriginal || !fcEdited) return;
              setWarpRunning(true);
              setWarpResult(null);
              try {
                const { warpFacesBack } = await import("@/lib/face-warp");
                const result = await warpFacesBack(fcOriginal, fcEdited);
                setWarpResult(result);
              } catch (err: any) {
                alert("Face warp failed: " + (err.message || "Unknown error"));
              }
              setWarpRunning(false);
            }}
            className={`w-full py-4 rounded-lg font-semibold text-sm transition-colors ${
              warpRunning
                ? "bg-purple-600 cursor-wait animate-pulse"
                : "bg-purple-600 hover:bg-purple-700"
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {warpRunning ? "Warping faces back..." : "Fix Faces — Warp Back to Original"}
          </button>
        )}

        {/* Warp Result Preview */}
        {warpResult && (
          <div className="bg-zinc-900 rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">
                Face Correction Result
                <span className="text-zinc-400 font-normal ml-2 text-xs">
                  ({warpResult.facesWarped} face{warpResult.facesWarped !== 1 ? "s" : ""} warped)
                </span>
              </h3>
              <a
                href={warpResult.correctedDataUrl}
                download="corrected.png"
                className="text-xs px-3 py-1.5 bg-green-600 hover:bg-green-700 rounded font-medium"
              >
                Download
              </a>
            </div>

            {/* Toggle buttons */}
            <div className="flex gap-1 bg-zinc-800 rounded-lg p-1">
              {(["facecrops", "sidebyside", "corrected", "diff"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => setWarpPreviewMode(mode)}
                  className={`flex-1 py-1.5 rounded text-xs font-medium transition-colors ${
                    warpPreviewMode === mode
                      ? "bg-zinc-600 text-white"
                      : "text-zinc-400 hover:text-zinc-200"
                  }`}
                >
                  {mode === "facecrops" ? "Face Crops" : mode === "sidebyside" ? "Full Side by Side" : mode === "corrected" ? "Corrected" : "Full Diff"}
                </button>
              ))}
            </div>

            {/* Preview images */}
            {warpPreviewMode === "facecrops" ? (
              <div className="space-y-4">
                {warpResult.faceCrops.map((crop) => (
                  <div key={crop.label} className="space-y-2">
                    <h4 className="text-xs text-zinc-400 font-semibold uppercase">{crop.label}</h4>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="space-y-1">
                        <span className="text-[10px] text-zinc-500 uppercase font-semibold">Original</span>
                        <img src={crop.originalCropUrl} alt="Original face" className="w-full rounded border border-zinc-700" />
                      </div>
                      <div className="space-y-1">
                        <span className="text-[10px] text-zinc-500 uppercase font-semibold">Edited</span>
                        <img src={crop.editedCropUrl} alt="Edited face" className="w-full rounded border border-zinc-700" />
                      </div>
                      <div className="space-y-1">
                        <span className="text-[10px] text-zinc-500 uppercase font-semibold">Diff</span>
                        <img src={crop.diffCropUrl} alt="Diff" className="w-full rounded border border-red-700/30" />
                      </div>
                    </div>
                  </div>
                ))}
                <p className="text-[10px] text-zinc-500">
                  Diff heat map: dark = identical, green = minor change, yellow/red = major pixel shift (4x amplified)
                </p>
              </div>
            ) : warpPreviewMode === "sidebyside" ? (
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <span className="text-[10px] text-zinc-500 uppercase font-semibold">Edited (before fix)</span>
                  <img src={fcEdited!} alt="Edited" className="w-full rounded border border-zinc-700" />
                </div>
                <div className="space-y-1">
                  <span className="text-[10px] text-zinc-500 uppercase font-semibold">Corrected (after fix)</span>
                  <img src={warpResult.correctedDataUrl} alt="Corrected" className="w-full rounded border border-purple-700/50" />
                </div>
              </div>
            ) : warpPreviewMode === "corrected" ? (
              <img src={warpResult.correctedDataUrl} alt="Corrected" className="w-full rounded border border-purple-700/50" />
            ) : (
              <div className="space-y-1">
                <img src={warpResult.diffDataUrl} alt="Diff" className="w-full rounded border border-zinc-700" />
                <p className="text-[10px] text-zinc-500">
                  Heat map: darker = no change, green = minor shift, yellow/red = major pixel displacement (5x amplified)
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
