"use client";

import { useState, useRef, useEffect } from "react";

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

  useEffect(() => {
    const saved = localStorage.getItem("bot_url");
    setBotUrl(saved || process.env.NEXT_PUBLIC_BOT_URL || "http://localhost:3099");
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
      formData.append("image", imageFile, imageFile.name);
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

      const res = await fetch(`${botUrl}/reply`, {
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
                localStorage.setItem("bot_url", e.target.value);
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
      </div>
    </div>
  );
}
