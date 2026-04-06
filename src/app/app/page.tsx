"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { QueueView } from "@/components/queue-view";
import { EditorView } from "@/components/editor-view";
import { ImageViewerProvider } from "@/components/image-viewer";
import { ThemeToggle } from "@/components/theme-toggle";
import {
  Wand2,
  Image,
  Bell,
  BellOff,
  LogOut,
  History,
  Sparkles,
  Loader2,
  Download,
  CheckCircle,
  X,
  Cloud,
  FlaskConical,
} from "lucide-react";
import { ImageCompare } from "@/components/image-compare";
import { useRouter } from "next/navigation";
import { usePushNotifications } from "@/lib/notification-provider";
import { authedFetch } from "@/lib/api";
import { useRef } from "react";
import { ShieldCheck } from "lucide-react";

interface FaceCheckResult {
  distance: number;
  verdict: "pass" | "warning" | "fail";
  verdictLabel: string;
  groups: Record<string, { avg: number; max: number }>;
  noFaceOriginal: boolean;
  noFaceEdited: boolean;
}

function LabsInline() {
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [redditUrl, setRedditUrl] = useState(
    "https://www.reddit.com/r/test12331/comments/1sbijra/test/"
  );
  const [botUrl, setBotUrl] = useState("");
  const [status, setStatus] = useState("");
  const [progress, setProgress] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  // Face Check
  const [fcOriginal, setFcOriginal] = useState<string | null>(null);
  const [fcEdited, setFcEdited] = useState<string | null>(null);
  const [fcResult, setFcResult] = useState<FaceCheckResult | null>(null);
  const [fcRunning, setFcRunning] = useState(false);
  const fcOrigRef = useRef<HTMLInputElement>(null);
  const fcEditRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const saved = localStorage.getItem("bot_url");
    setBotUrl(
      process.env.NEXT_PUBLIC_BOT_URL || saved || "http://localhost:3099"
    );
  }, []);

  function log(msg: string) {
    const ts = new Date().toLocaleTimeString();
    setLogs((prev) => [`[${ts}] ${msg}`, ...prev]);
  }

  async function sendToBot() {
    if (!imageFile || !redditUrl.trim()) return;
    setStatus("sending");
    setProgress("Uploading image to bot...");
    log(`Sending to ${botUrl}/reply`);
    try {
      const formData = new FormData();
      formData.append("image", imageFile, imageFile.name);
      formData.append("redditUrl", redditUrl);
      const paypal = localStorage.getItem("paypal_link") || "";
      if (paypal) formData.append("paypalLink", paypal);
      const secret = localStorage.getItem("bot_secret") || process.env.NEXT_PUBLIC_BOT_SECRET || "";
      if (secret) formData.append("secret", secret);

      const startTime = Date.now();
      const iv = setInterval(() => {
        const s = Math.floor((Date.now() - startTime) / 1000);
        if (s < 5) setProgress("Opening Reddit post...");
        else if (s < 10) setProgress("Clicking comment box...");
        else if (s < 15) setProgress("Uploading image...");
        else if (s < 22) setProgress("Waiting for upload...");
        else if (s < 28) setProgress("Typing comment...");
        else if (s < 35) setProgress("Submitting...");
        else setProgress("Almost done...");
      }, 1000);

      const res = await fetch(`${botUrl}/reply`, {
        method: "POST",
        body: formData,
      });
      clearInterval(iv);
      const data = await res.json();
      if (data.success) {
        setStatus("success");
        setProgress("Comment posted!");
        log("SUCCESS");
      } else {
        setStatus("error");
        setProgress("Failed");
        log(`FAILED: ${data.error}`);
      }
    } catch (err: any) {
      setStatus("error");
      setProgress("Connection failed");
      log(`ERROR: ${err.message}`);
    }
  }

  return (
    <div className="space-y-3">
      {progress && (
        <div
          className={`rounded-lg p-3 text-sm font-medium flex items-center gap-3 ${
            status === "success"
              ? "bg-green-500/10 text-green-500 border border-green-500/30"
              : status === "error"
              ? "bg-red-500/10 text-red-500 border border-red-500/30"
              : "bg-yellow-500/10 text-yellow-500 border border-yellow-500/30"
          }`}
        >
          {status === "sending" && (
            <Loader2 className="h-4 w-4 animate-spin shrink-0" />
          )}
          {status === "success" && (
            <CheckCircle className="h-4 w-4 shrink-0" />
          )}
          {status === "error" && <X className="h-4 w-4 shrink-0" />}
          <span>{progress}</span>
        </div>
      )}

      <div className="space-y-2">
        <label className="text-xs text-muted-foreground font-medium">
          Bot Server
        </label>
        <input
          type="text"
          value={botUrl}
          onChange={(e) => {
            setBotUrl(e.target.value);
            localStorage.setItem("bot_url", e.target.value);
          }}
          className="w-full bg-muted rounded px-3 py-2 text-sm border"
        />
      </div>

      <div className="space-y-2">
        <label className="text-xs text-muted-foreground font-medium">
          Reddit Post URL
        </label>
        <input
          type="text"
          value={redditUrl}
          onChange={(e) => setRedditUrl(e.target.value)}
          className="w-full bg-muted rounded px-3 py-2 text-sm border"
        />
      </div>

      <div className="space-y-2">
        <label className="text-xs text-muted-foreground font-medium">
          Image
        </label>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (!f) return;
            setImageFile(f);
            setImagePreview(URL.createObjectURL(f));
            log(`Selected: ${f.name} (${(f.size / 1024).toFixed(0)} KB)`);
          }}
          className="hidden"
        />
        <button
          onClick={() => fileRef.current?.click()}
          className="w-full px-4 py-3 bg-muted hover:bg-muted/80 rounded text-sm border border-dashed"
        >
          {imageFile ? imageFile.name : "Tap to choose image"}
        </button>
        {imagePreview && (
          <img
            src={imagePreview}
            alt="Preview"
            className="max-h-48 rounded border mx-auto"
          />
        )}
      </div>

      <button
        onClick={sendToBot}
        disabled={!imageFile || !redditUrl || status === "sending"}
        className={`w-full py-3 rounded-lg font-semibold text-sm text-white ${
          status === "sending"
            ? "bg-yellow-600 animate-pulse"
            : status === "success"
            ? "bg-green-600"
            : "bg-orange-600 hover:bg-orange-700"
        } disabled:opacity-50`}
      >
        {status === "sending"
          ? "Posting..."
          : status === "success"
          ? "Sent! Again?"
          : "Send to Reddit Bot"}
      </button>

      <div className="bg-muted rounded p-3 max-h-36 overflow-y-auto font-mono text-xs space-y-1">
        {logs.length === 0 ? (
          <span className="text-muted-foreground">No logs...</span>
        ) : (
          logs.map((l, i) => (
            <div
              key={i}
              className={
                l.includes("ERROR") || l.includes("FAILED")
                  ? "text-red-500"
                  : l.includes("SUCCESS")
                  ? "text-green-500"
                  : "text-muted-foreground"
              }
            >
              {l}
            </div>
          ))
        )}
      </div>

      {/* ── Face Check ── */}
      <div className="border-t pt-4 mt-4 space-y-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-blue-500" />
          <h2 className="font-semibold text-sm">Face Check</h2>
          <span className="text-xs text-muted-foreground">— biometric, runs locally, $0</span>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground font-medium">Original</label>
            <input ref={fcOrigRef} type="file" accept="image/*" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) { setFcOriginal(URL.createObjectURL(f)); setFcResult(null); } }} />
            <button onClick={() => fcOrigRef.current?.click()}
              className="w-full px-3 py-2 bg-muted hover:bg-muted/80 rounded text-sm border border-dashed">
              {fcOriginal ? "Change" : "Upload original"}
            </button>
            {fcOriginal && <img src={fcOriginal} alt="Original" className="max-h-36 rounded border mx-auto" />}
          </div>
          <div className="space-y-2">
            <label className="text-xs text-muted-foreground font-medium">Edited</label>
            <input ref={fcEditRef} type="file" accept="image/*" className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) { setFcEdited(URL.createObjectURL(f)); setFcResult(null); } }} />
            <button onClick={() => fcEditRef.current?.click()}
              className="w-full px-3 py-2 bg-muted hover:bg-muted/80 rounded text-sm border border-dashed">
              {fcEdited ? "Change" : "Upload edited"}
            </button>
            {fcEdited && <img src={fcEdited} alt="Edited" className="max-h-36 rounded border mx-auto" />}
          </div>
        </div>

        {/* URL inputs */}
        <div className="space-y-2">
          <label className="text-xs text-muted-foreground font-medium">Or paste image URLs</label>
          <input type="text" placeholder="Original image URL"
            className="w-full bg-muted rounded px-3 py-2 text-sm border"
            onBlur={(e) => { if (e.target.value.trim()) { setFcOriginal(e.target.value.trim()); setFcResult(null); } }} />
          <input type="text" placeholder="Edited image URL"
            className="w-full bg-muted rounded px-3 py-2 text-sm border"
            onBlur={(e) => { if (e.target.value.trim()) { setFcEdited(e.target.value.trim()); setFcResult(null); } }} />
        </div>

        <button
          disabled={!fcOriginal || !fcEdited || fcRunning}
          onClick={async () => {
            if (!fcOriginal || !fcEdited) return;
            setFcRunning(true); setFcResult(null);
            try {
              const { runFaceCheck } = await import("@/lib/face-check");
              const result = await runFaceCheck(fcOriginal, fcEdited);
              setFcResult(result);
            } catch (err: any) { alert("Face check failed: " + (err.message || "Unknown error")); }
            setFcRunning(false);
          }}
          className={`w-full py-3 rounded-lg font-semibold text-sm text-white ${
            fcRunning ? "bg-blue-600 animate-pulse" : "bg-blue-600 hover:bg-blue-700"
          } disabled:opacity-50`}
        >
          {fcRunning ? "Analyzing faces..." : "Run Face Check"}
        </button>

        {fcResult && (
          <div className="bg-muted rounded-lg p-3 space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Verdict</span>
              <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${
                fcResult.verdict === "pass" ? "bg-green-500/20 text-green-400 border border-green-500/30"
                : fcResult.verdict === "warning" ? "bg-yellow-500/20 text-yellow-400 border border-yellow-500/30"
                : "bg-red-500/20 text-red-400 border border-red-500/30"
              }`}>{fcResult.verdictLabel}</span>
            </div>
            {fcResult.distance >= 0 && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Distance</span>
                <span className="font-mono">
                  <span className={fcResult.distance < 0.4 ? "text-green-400" : fcResult.distance < 0.6 ? "text-yellow-400" : "text-red-400"}>
                    {fcResult.distance.toFixed(4)}
                  </span>
                  <span className="text-muted-foreground text-xs ml-1">(&lt;0.4 same)</span>
                </span>
              </div>
            )}
            {(fcResult as any).faces && (fcResult as any).faces.length > 1 ? (
              <div className="space-y-2 pt-2 border-t">
                <span className="text-xs text-muted-foreground font-medium">
                  {(fcResult as any).facesDetectedOriginal} faces detected
                </span>
                {(fcResult as any).faces.map((face: any) => (
                  <div key={face.label} className="space-y-1 pl-2 border-l-2 border-muted-foreground/20">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium">{face.label}</span>
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                        face.verdict === "pass" ? "bg-green-500/20 text-green-400"
                          : face.verdict === "warning" ? "bg-yellow-500/20 text-yellow-400"
                          : "bg-red-500/20 text-red-400"
                      }`}>{face.distance.toFixed(4)}</span>
                    </div>
                    {Object.entries(face.groups as Record<string, { avg: number; max: number }>)
                      .sort(([, a], [, b]) => b.avg - a.avg)
                      .slice(0, 3)
                      .map(([name, data]) => (
                        <div key={name} className="flex items-center gap-2 text-xs">
                          <span className="text-muted-foreground w-24">{name.replace(/_/g, " ")}</span>
                          <div className="flex-1 bg-background rounded-full h-1.5 overflow-hidden">
                            <div className={`h-full rounded-full ${data.avg < 0.03 ? "bg-green-500" : data.avg < 0.08 ? "bg-yellow-500" : "bg-red-500"}`}
                              style={{ width: `${Math.min(100, data.avg * 500)}%` }} />
                          </div>
                          <span className={`font-mono w-12 text-right ${data.avg < 0.03 ? "text-green-400" : data.avg < 0.08 ? "text-yellow-400" : "text-red-400"}`}>
                            {data.avg.toFixed(4)}
                          </span>
                        </div>
                      ))}
                  </div>
                ))}
              </div>
            ) : Object.keys(fcResult.groups).length > 0 ? (
              <div className="space-y-1 pt-2 border-t">
                <span className="text-xs text-muted-foreground font-medium">Landmark Shifts</span>
                {Object.entries(fcResult.groups)
                  .sort(([, a], [, b]) => b.avg - a.avg)
                  .map(([name, data]) => (
                    <div key={name} className="flex items-center gap-2 text-xs">
                      <span className="text-muted-foreground w-24">{name.replace(/_/g, " ")}</span>
                      <div className="flex-1 bg-background rounded-full h-1.5 overflow-hidden">
                        <div className={`h-full rounded-full ${data.avg < 0.03 ? "bg-green-500" : data.avg < 0.08 ? "bg-yellow-500" : "bg-red-500"}`}
                          style={{ width: `${Math.min(100, data.avg * 500)}%` }} />
                      </div>
                      <span className={`font-mono w-12 text-right ${data.avg < 0.03 ? "text-green-400" : data.avg < 0.08 ? "text-yellow-400" : "text-red-400"}`}>
                        {data.avg.toFixed(4)}
                      </span>
                    </div>
                  ))}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [activeTab, setActiveTab] = useState("queue");
  const [pendingEditorItems, setPendingEditorItems] = useState(0);
  const [redditUser, setRedditUser] = useState("");
  const [showHistoryPanel, setShowHistoryPanel] = useState(false);
  const [historyItems, setHistoryItems] = useState<any[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  // No AI Edit mini-editor
  const [showNoAiPanel, setShowNoAiPanel] = useState(false);
  const [noAiUrl, setNoAiUrl] = useState("");
  const [noAiLoading, setNoAiLoading] = useState(false);
  const [noAiResult, setNoAiResult] = useState<{
    correctedImageUrl?: string;
    analysis: {
      summary: string;
      hints: string[];
      metrics: Record<string, number>;
    };
    applied: string[];
    hasCorrections: boolean;
  } | null>(null);
  const [noAiUploading, setNoAiUploading] = useState(false);
  const [noAiCloudinaryUrl, setNoAiCloudinaryUrl] = useState<string | null>(
    null,
  );
  const {
    isSubscribed,
    isSupported,
    isMuted,
    isMonitoring,
    subscribe,
    unsubscribe,
    toggleMute,
    toggleMonitoring,
  } = usePushNotifications();
  const router = useRouter();

  // Master notifications toggle — enables/disables push + sound + monitoring together
  const allNotificationsOn = isSubscribed && !isMuted && isMonitoring;
  const toggleAllNotifications = async () => {
    if (allNotificationsOn) {
      // Turn everything off
      if (isSubscribed) await unsubscribe();
      if (!isMuted) toggleMute();
      if (isMonitoring) toggleMonitoring();
    } else {
      // Turn everything on
      if (!isSubscribed) await subscribe();
      if (isMuted) toggleMute();
      if (!isMonitoring) toggleMonitoring();
    }
  };

  // No AI Edit — sharp only
  const runNoAiEdit = async () => {
    if (!noAiUrl.trim()) return;
    setNoAiLoading(true);
    setNoAiResult(null);
    setNoAiCloudinaryUrl(null);
    try {
      const res = await authedFetch("/api/preview-corrections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageUrl: noAiUrl.trim() }),
      });
      const data = await res.json();
      if (data.ok) setNoAiResult(data);
    } catch (err) {
      console.error("No AI edit failed:", err);
    }
    setNoAiLoading(false);
  };

  const uploadNoAiToCloudinary = async () => {
    if (!noAiResult?.correctedImageUrl) return;
    setNoAiUploading(true);
    try {
      const res = await authedFetch("/api/upload-correction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          imageDataUrl: noAiResult.correctedImageUrl,
          author: redditUser || "unknown",
        }),
      });
      const data = await res.json();
      if (data.ok && data.url) {
        setNoAiCloudinaryUrl(data.url);
      }
    } catch (err) {
      console.error("Cloudinary upload failed:", err);
    }
    setNoAiUploading(false);
  };

  // Fetch history
  const fetchHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const res = await authedFetch("/api/history?limit=20");
      const data = await res.json();
      if (data.ok) setHistoryItems(data.items || []);
    } catch (err) {
      console.error("Failed to fetch history:", err);
    }
    setHistoryLoading(false);
  }, []);

  useEffect(() => {
    const handleNoAiEdit = (e: Event) => {
      const url = (e as CustomEvent).detail?.imageUrl;
      if (url) {
        setNoAiUrl(url);
        setNoAiResult(null);
        setNoAiCloudinaryUrl(null);
        setShowNoAiPanel(true);
        setShowHistoryPanel(false);
      }
    };
    window.addEventListener("noAiEdit", handleNoAiEdit);
    return () => window.removeEventListener("noAiEdit", handleNoAiEdit);
  }, []);

  useEffect(() => {
    const user = localStorage.getItem("reddit_username");
    const token = localStorage.getItem("app_token");
    if (!user || !token) {
      router.replace("/");
      return;
    }
    setRedditUser(user);

    const params = new URLSearchParams(window.location.search);
    if (params.get("post")) {
      setActiveTab("queue");
    }
  }, [router]);

  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === "pendingEditorItem" && e.newValue) {
        setActiveTab("editor");
        updatePendingCount();
      }
    };

    const updatePendingCount = () => {
      const pendingItem = localStorage.getItem("pendingEditorItem");
      setPendingEditorItems(pendingItem ? 1 : 0);
    };

    updatePendingCount();
    window.addEventListener("storage", handleStorageChange);

    const pendingItem = localStorage.getItem("pendingEditorItem");
    if (pendingItem) {
      setActiveTab("editor");
    }

    return () => window.removeEventListener("storage", handleStorageChange);
  }, []);

  const handleTabChange = (tab: string) => {
    setActiveTab(tab);
  };

  const handleLogout = () => {
    localStorage.removeItem("reddit_username");
    localStorage.removeItem("app_token");
    router.replace("/");
  };

  return (
    <ImageViewerProvider>
      <div className="min-h-screen bg-background">
        {/* Header */}
        <header className="sticky top-0 z-40 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <div className="container mx-auto px-3 sm:px-4 py-2 sm:py-3">
            <div className="flex items-center justify-between">
              {/* Left: username */}
              <span className="text-sm font-medium text-foreground truncate max-w-[140px] sm:max-w-none">
                u/{redditUser || "..."}
              </span>

              {/* Right: actions */}
              <div className="flex items-center gap-1">
                {/* Notifications master toggle */}
                {isSupported && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={toggleAllNotifications}
                    className="relative h-9 w-9 p-0"
                    title={
                      allNotificationsOn
                        ? "Notifications ON (push, sound, monitor) — tap to disable all"
                        : "Notifications OFF — tap to enable all"
                    }
                  >
                    {allNotificationsOn ? (
                      <Bell className="h-4 w-4 text-green-500" />
                    ) : (
                      <BellOff className="h-4 w-4 text-muted-foreground" />
                    )}
                    {allNotificationsOn && (
                      <div className="absolute top-1 right-1 w-2 h-2 bg-green-500 rounded-full" />
                    )}
                  </Button>
                )}

                {/* No AI Edit */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowNoAiPanel(!showNoAiPanel);
                    if (showNoAiPanel) {
                      setNoAiResult(null);
                      setNoAiUrl("");
                      setNoAiCloudinaryUrl(null);
                    }
                  }}
                  className={`relative h-9 w-9 p-0 ${showNoAiPanel ? "bg-amber-500/10" : ""}`}
                  title="No AI Edit — sharp corrections only"
                >
                  <Sparkles
                    className={`h-4 w-4 ${showNoAiPanel ? "text-amber-500" : "text-muted-foreground"}`}
                  />
                </Button>

                {/* History quick-access */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setShowHistoryPanel(!showHistoryPanel);
                    if (!showHistoryPanel && historyItems.length === 0)
                      fetchHistory();
                  }}
                  className="relative h-9 w-9 p-0"
                  title="Edit history"
                >
                  <History className="h-4 w-4 text-muted-foreground" />
                </Button>

                <ThemeToggle />

                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleLogout}
                  className="h-9 w-9 p-0"
                  title="Log out"
                >
                  <LogOut className="h-4 w-4 text-muted-foreground" />
                </Button>
              </div>
            </div>
          </div>
        </header>

        {/* No AI Edit panel */}
        {showNoAiPanel && (
          <div className="sticky top-[49px] z-30 border-b bg-background/95 backdrop-blur">
            <div className="container mx-auto px-3 sm:px-4 py-3">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-amber-500" />
                  No AI Edit — Sharp Only
                </h3>
                <button
                  onClick={() => {
                    setShowNoAiPanel(false);
                    setNoAiResult(null);
                    setNoAiUrl("");
                    setNoAiCloudinaryUrl(null);
                  }}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="flex gap-2 mb-3">
                <input
                  type="text"
                  value={noAiUrl}
                  onChange={(e) => setNoAiUrl(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && runNoAiEdit()}
                  placeholder="Paste image URL..."
                  className="flex-1 px-3 py-2 text-sm border border-input rounded-lg bg-background focus:ring-2 focus:ring-amber-500/50 focus:border-amber-500"
                />
                <Button
                  size="sm"
                  onClick={runNoAiEdit}
                  disabled={noAiLoading || !noAiUrl.trim()}
                  className="bg-amber-500 hover:bg-amber-600 text-white px-4"
                >
                  {noAiLoading ? (
                    <>
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                      Processing...
                    </>
                  ) : (
                    "Apply"
                  )}
                </Button>
              </div>

              {noAiResult && (
                <div className="space-y-3">
                  {!noAiResult.hasCorrections ? (
                    <div className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400 py-4 justify-center">
                      <CheckCircle className="h-4 w-4" />
                      Image quality OK — no corrections needed.
                    </div>
                  ) : (
                    <>
                      {/* Applied corrections */}
                      <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                        <p className="text-xs font-semibold text-amber-600 dark:text-amber-400 mb-1.5">
                          {noAiResult.applied.length} correction
                          {noAiResult.applied.length !== 1 ? "s" : ""} applied:
                        </p>
                        <ul className="text-xs text-muted-foreground space-y-0.5">
                          {noAiResult.applied.map((c, i) => (
                            <li key={i}>• {c}</li>
                          ))}
                        </ul>
                      </div>

                      {/* Before/After slider */}
                      {noAiResult.correctedImageUrl && (
                        <div className="space-y-2">
                          <ImageCompare
                            originalSrc={noAiUrl}
                            editedSrc={noAiResult.correctedImageUrl}
                            className="w-full max-h-[40vh]"
                          />
                          <div className="flex gap-2 items-center">
                            <a
                              href={noAiResult.correctedImageUrl}
                              download={`sharp-edit-${Date.now()}.png`}
                              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-amber-500 hover:bg-amber-600 text-white transition-colors"
                            >
                              <Download className="h-3.5 w-3.5" />
                              Download
                            </a>
                            {!noAiCloudinaryUrl ? (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={uploadNoAiToCloudinary}
                                disabled={noAiUploading}
                                className="text-xs h-7"
                              >
                                {noAiUploading ? (
                                  <>
                                    <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
                                    Uploading...
                                  </>
                                ) : (
                                  <>
                                    <Cloud className="mr-1.5 h-3 w-3" />
                                    Upload to Cloudinary
                                  </>
                                )}
                              </Button>
                            ) : (
                              <a
                                href={noAiCloudinaryUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-colors"
                              >
                                <Cloud className="h-3.5 w-3.5" />
                                View on Cloudinary
                              </a>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Metrics */}
                      <div className="flex flex-wrap gap-1.5 text-[10px] text-muted-foreground">
                        {Object.entries(noAiResult.analysis.metrics).map(
                          ([k, v]) => (
                            <span
                              key={k}
                              className="px-1.5 py-0.5 rounded bg-muted/50 font-mono"
                            >
                              {k}:{" "}
                              {typeof v === "number"
                                ? Math.round(v * 100) / 100
                                : v}
                            </span>
                          ),
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* History dropdown panel */}
        {showHistoryPanel && (
          <div className="sticky top-[49px] z-30 border-b bg-background/95 backdrop-blur">
            <div className="container mx-auto px-3 sm:px-4 py-3 max-h-[50vh] overflow-y-auto">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold">Recent Edits</h3>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={fetchHistory}
                    disabled={historyLoading}
                    className="text-xs h-7"
                  >
                    {historyLoading ? "Loading..." : "Refresh"}
                  </Button>
                  <button
                    onClick={() => setShowHistoryPanel(false)}
                    className="text-muted-foreground hover:text-foreground text-xs"
                  >
                    Close
                  </button>
                </div>
              </div>
              {historyItems.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-4">
                  {historyLoading ? "Loading..." : "No edit history yet."}
                </p>
              ) : (
                <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-2">
                  {historyItems.map((item) => (
                    <a
                      key={item.publicId}
                      href={item.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="group rounded-lg border overflow-hidden bg-card hover:border-primary/40 transition-all"
                    >
                      <div className="aspect-square relative">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={item.url}
                          alt={`Edit for ${item.author}`}
                          className="w-full h-full object-cover"
                          loading="lazy"
                        />
                      </div>
                      <div className="p-1.5">
                        <p className="text-[10px] font-medium truncate">
                          u/{item.author}
                        </p>
                        <p className="text-[9px] text-muted-foreground">
                          {new Date(item.createdAt).toLocaleDateString()}
                        </p>
                      </div>
                    </a>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Main Content */}
        <main className="container mx-auto px-3 sm:px-4 py-3 sm:py-6">
          <Tabs
            value={activeTab}
            onValueChange={handleTabChange}
            className="w-full"
          >
            <TabsList className="grid w-full max-w-full grid-cols-3 h-10 sm:h-11 p-1 bg-muted/50 border overflow-hidden">
              <TabsTrigger
                value="queue"
                className="flex items-center justify-center gap-1.5 h-8 sm:h-9 rounded-md font-medium text-xs sm:text-sm data-[state=active]:bg-background data-[state=active]:shadow-sm min-w-0"
              >
                <Image className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="truncate">Queue</span>
              </TabsTrigger>
              <TabsTrigger
                value="editor"
                className="flex items-center justify-center gap-1.5 h-8 sm:h-9 rounded-md font-medium text-xs sm:text-sm data-[state=active]:bg-background data-[state=active]:shadow-sm relative min-w-0"
              >
                <Wand2 className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="truncate">Editor</span>
                {pendingEditorItems > 0 && (
                  <div className="absolute -top-1 -right-1 bg-red-500 text-white text-[10px] rounded-full w-4 h-4 flex items-center justify-center font-bold animate-pulse">
                    {pendingEditorItems}
                  </div>
                )}
              </TabsTrigger>
              <TabsTrigger
                value="labs"
                className="flex items-center justify-center gap-1.5 h-8 sm:h-9 rounded-md font-medium text-xs sm:text-sm data-[state=active]:bg-background data-[state=active]:shadow-sm min-w-0"
              >
                <FlaskConical className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="truncate">Labs</span>
              </TabsTrigger>
            </TabsList>

            <div
              className={`mt-3 sm:mt-4 ${activeTab === "queue" ? "" : "hidden"}`}
            >
              <QueueView />
            </div>

            <div
              className={`mt-3 sm:mt-4 ${activeTab === "editor" ? "" : "hidden"}`}
            >
              <EditorView />
            </div>

            <div
              className={`mt-3 sm:mt-4 ${activeTab === "labs" ? "" : "hidden"}`}
            >
              <LabsInline />
            </div>
          </Tabs>
        </main>
      </div>
    </ImageViewerProvider>
  );
}
