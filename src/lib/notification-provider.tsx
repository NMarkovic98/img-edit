"use client";

import {
  useEffect,
  useRef,
  useCallback,
  useState,
  createContext,
  useContext,
} from "react";
import { authedFetch } from "@/lib/api";

const SUBREDDITS = [
  "PhotoshopRequest",
  "PhotoshopRequests",
  "estoration",
  "editmyphoto",
];
const FETCH_INTERVAL = 10000; // 10 seconds
const REPLY_CHECK_INTERVAL = 60000; // 60 seconds

function getRedditUsername(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("reddit_username") || "";
}

// ─── Push Notification Context ──────────────────────────────────────
interface PushState {
  isSubscribed: boolean;
  isSupported: boolean;
  isMuted: boolean;
  isMonitoring: boolean;
  subscribe: () => Promise<void>;
  unsubscribe: () => Promise<void>;
  toggleMute: () => void;
  toggleMonitoring: () => Promise<void>;
}

const PushContext = createContext<PushState>({
  isSubscribed: false,
  isSupported: false,
  isMuted: false,
  isMonitoring: false,
  subscribe: async () => {},
  unsubscribe: async () => {},
  toggleMute: () => {},
  toggleMonitoring: async () => {},
});

export const usePushNotifications = () => useContext(PushContext);

// ─── Audio: Generate a WAV chime as base64 data URL ──────────────────

function generateChimeWav(freq = 880, durationSec = 0.5, volume = 0.7): string {
  const sampleRate = 44100;
  const numSamples = Math.floor(sampleRate * durationSec);
  const buffer = new ArrayBuffer(44 + numSamples * 2);
  const view = new DataView(buffer);

  // WAV header
  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++)
      view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + numSamples * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, numSamples * 2, true);

  // Generate sine wave with fade out
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const envelope = Math.max(0, 1 - t / durationSec); // linear fade
    const sample = Math.sin(2 * Math.PI * freq * t) * volume * envelope;
    view.setInt16(
      44 + i * 2,
      Math.max(-32768, Math.min(32767, sample * 32767)),
      true,
    );
  }

  // Convert to base64
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  return "data:audio/wav;base64," + btoa(binary);
}

// Pre-generate chime sounds - PAID is urgent/distinct, FREE is subtle
const CHIME_PAID = generateChimeWav(1200, 0.8, 1.0); // High pitch, loud, longer
const CHIME_FREE = generateChimeWav(600, 0.3, 0.5); // Low pitch, quiet, short
const CHIME_REPLY = generateChimeWav(900, 0.5, 0.7);

function playChime(type: "paid" | "free" | "reply" = "free") {
  try {
    const src =
      type === "paid"
        ? CHIME_PAID
        : type === "reply"
          ? CHIME_REPLY
          : CHIME_FREE;
    const audio = new Audio(src);
    audio.volume = type === "paid" ? 1.0 : 0.6;
    audio.play().catch((e) => console.error("Audio play error:", e));

    // For paid: play a second chime after a short delay to make it really stand out
    if (type === "paid") {
      setTimeout(() => {
        const audio2 = new Audio(CHIME_PAID);
        audio2.volume = 0.8;
        audio2.play().catch(() => {});
      }, 300);
    }
  } catch (e) {
    console.error("Chime error:", e);
  }
}

function speak(message: string) {
  if (!("speechSynthesis" in window)) return;
  speechSynthesis.cancel();

  setTimeout(() => {
    const utterance = new SpeechSynthesisUtterance(message);
    utterance.rate = 1.0;
    utterance.volume = 1.0;
    utterance.pitch = 1.0;

    // Try to find a good English voice
    const voices = speechSynthesis.getVoices();
    const preferred =
      voices.find((v) => v.lang === "en-US" && v.localService) ||
      voices.find((v) => v.lang.startsWith("en") && v.localService) ||
      voices.find((v) => v.lang.startsWith("en"));
    if (preferred) utterance.voice = preferred;

    utterance.onerror = (e) => console.error("Speech error:", e);
    speechSynthesis.speak(utterance);
  }, 600);
}

// Combined: play chime then speak
function notify(message: string, type: "paid" | "free" | "reply" = "free") {
  playChime(type);
  speak(type === "paid" ? `PAID REQUEST! ${message}` : message);
}

// Expose globally so user can test from browser console
if (typeof window !== "undefined") {
  (window as any).testFixtralPaid = () => {
    notify("1 paid request in PhotoshopRequest.", "paid");
  };
  (window as any).testFixtralFree = () => {
    notify("2 free requests in estoration.", "free");
  };
}

// ─── Persistence helpers ─────────────────────────────────────────────

function getSeenPostIds(): Set<string> {
  try {
    const s = localStorage.getItem("seenPostIds");
    if (s) return new Set(JSON.parse(s));
  } catch {}
  return new Set();
}

function saveSeenPostIds(ids: Set<string>) {
  localStorage.setItem("seenPostIds", JSON.stringify([...ids].slice(-500)));
}

function getSeenReplyIds(): Set<string> {
  try {
    const s = localStorage.getItem("seenReplyIds");
    if (s) return new Set(JSON.parse(s));
  } catch {}
  return new Set();
}

function saveSeenReplyIds(ids: Set<string>) {
  localStorage.setItem("seenReplyIds", JSON.stringify([...ids].slice(-200)));
}

// ─── Provider Component ──────────────────────────────────────────────

export function NotificationProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const seenPostIds = useRef<Set<string>>(new Set());
  const seenReplyIds = useRef<Set<string>>(new Set());
  const isFirstLoad = useRef(true);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isSupported, setIsSupported] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [isMonitoring, setIsMonitoring] = useState(false);
  const isMutedRef = useRef(false);
  const isMonitoringRef = useRef(false);
  const swRegistration = useRef<ServiceWorkerRegistration | null>(null);

  // Load persisted IDs and mute state on mount
  useEffect(() => {
    seenPostIds.current = getSeenPostIds();
    seenReplyIds.current = getSeenReplyIds();
    const muted = localStorage.getItem("notificationsMuted") === "true";
    setIsMuted(muted);
    isMutedRef.current = muted;

    // Check background monitor status
    authedFetch("/api/monitor")
      .then((r) => r.json())
      .then((d) => { if (d.ok) { setIsMonitoring(d.enabled); isMonitoringRef.current = d.enabled; } })
      .catch(() => {});
  }, []);

  const toggleMute = useCallback(() => {
    setIsMuted((prev) => {
      const next = !prev;
      isMutedRef.current = next;
      localStorage.setItem("notificationsMuted", String(next));
      return next;
    });
  }, []);

  const toggleMonitoring = useCallback(async () => {
    const newState = !isMonitoring;
    try {
      const res = await authedFetch("/api/monitor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: newState }),
      });
      const data = await res.json();
      if (data.ok) {
        setIsMonitoring(data.enabled);
        isMonitoringRef.current = data.enabled;
      }
    } catch (err) {
      console.error("Toggle monitoring error:", err);
    }
  }, [isMonitoring]);

  // ─── Service Worker & Push Registration ─────────────────────────
  useEffect(() => {
    const supported = "serviceWorker" in navigator && "PushManager" in window;
    setIsSupported(supported);

    if (!supported) return;

    const registerSW = async () => {
      try {
        const reg = await navigator.serviceWorker.register("/sw.js");
        swRegistration.current = reg;
        console.log("Service Worker registered");

        // Check if already subscribed
        const sub = await reg.pushManager.getSubscription();
        setIsSubscribed(!!sub);
      } catch (error) {
        console.error("SW registration failed:", error);
      }
    };

    registerSW();
  }, []);

  const subscribeToPush = useCallback(async () => {
    if (!swRegistration.current) return;

    try {
      const vapidKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
      if (!vapidKey) {
        console.error("VAPID public key not found");
        return;
      }

      // Request notification permission
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        console.log("Notification permission denied");
        return;
      }

      // Subscribe to push
      const sub = await swRegistration.current.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidKey)
          .buffer as ArrayBuffer,
      });

      // Send subscription to server (in-tab push)
      await authedFetch("/api/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      });

      // Also register with Cloudflare Worker for background push
      await authedFetch("/api/monitor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      }).catch(() => {}); // non-critical

      setIsSubscribed(true);
      console.log("Push subscription active");
    } catch (error) {
      console.error("Push subscription error:", error);
    }
  }, []);

  const unsubscribeFromPush = useCallback(async () => {
    if (!swRegistration.current) return;

    try {
      const sub = await swRegistration.current.pushManager.getSubscription();
      if (sub) {
        await authedFetch("/api/push", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            subscription: sub.toJSON(),
            action: "unsubscribe",
          }),
        });

        // Also remove from Cloudflare Worker
        await authedFetch("/api/monitor", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ unsubscribeEndpoint: sub.endpoint }),
        }).catch(() => {});

        await sub.unsubscribe();
      }
      setIsSubscribed(false);
      console.log("Push unsubscribed");
    } catch (error) {
      console.error("Push unsubscribe error:", error);
    }
  }, []);

  // Unlock audio: play a silent Audio on first click so browser allows future playback
  useEffect(() => {
    const unlock = () => {
      const silence = new Audio(
        "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=",
      );
      silence.volume = 0.01;
      silence.play().catch(() => {});
      // Preload speech voices
      if ("speechSynthesis" in window) speechSynthesis.getVoices();
      document.removeEventListener("click", unlock);
      document.removeEventListener("keydown", unlock);
    };
    document.addEventListener("click", unlock);
    document.addEventListener("keydown", unlock);
    if ("speechSynthesis" in window) speechSynthesis.getVoices();
    return () => {
      document.removeEventListener("click", unlock);
      document.removeEventListener("keydown", unlock);
    };
  }, []);

  // ─── Poll for new posts ──────────────────────────────────────────

  const checkNewPosts = useCallback(async () => {
    try {
      const subredditsParam = SUBREDDITS.join(",");
      const res = await authedFetch(
        `/api/reddit/posts?subreddits=${subredditsParam}`,
      );
      const data = await res.json();
      if (!data.ok) return;

      const posts: any[] = data.posts || [];

      if (isFirstLoad.current) {
        // First load: just mark everything as seen, no notification
        posts.forEach((p) => seenPostIds.current.add(p.id));
        saveSeenPostIds(seenPostIds.current);
        isFirstLoad.current = false;
        return;
      }

      // Find genuinely new posts
      const freshPosts = posts.filter((p) => !seenPostIds.current.has(p.id));

      if (freshPosts.length > 0) {
        // Separate paid and free
        const paidPosts = freshPosts.filter((p: any) => p.isPaid);
        const freePosts = freshPosts.filter((p: any) => !p.isPaid);

        // Build grouped messages
        const buildMessage = (posts: any[]) => {
          const grouped: Record<string, number> = {};
          for (const p of posts) {
            const sub = p.subreddit || "unknown";
            grouped[sub] = (grouped[sub] || 0) + 1;
          }
          return Object.entries(grouped)
            .map(([sub, count]) => `${count} in r/${sub}`)
            .join(", ");
        };

        // PAID gets urgent notification
        if (paidPosts.length > 0) {
          const msg = buildMessage(paidPosts);
          if (!isMutedRef.current) {
            notify(
              `${paidPosts.length} PAID request${paidPosts.length > 1 ? "s" : ""}: ${msg}`,
              "paid",
            );
          }

          // Only send push from frontend if background monitor is off
          if (!isMonitoringRef.current) {
            sendPushNotification(
              `PAID: ${paidPosts.length} new request${paidPosts.length > 1 ? "s" : ""}`,
              msg,
            );
          }

          // Dispatch special event for paid posts UI highlight
          window.dispatchEvent(
            new CustomEvent("fixtral:paidPosts", {
              detail: { postIds: paidPosts.map((p: any) => p.id) },
            }),
          );
        }

        // FREE gets subtle notification (only if no paid, otherwise skip voice)
        if (freePosts.length > 0) {
          const msg = buildMessage(freePosts);
          if (paidPosts.length === 0 && !isMutedRef.current) {
            notify(
              `${freePosts.length} free request${freePosts.length > 1 ? "s" : ""}: ${msg}`,
              "free",
            );
          }

          // Only send push from frontend if background monitor is off
          if (paidPosts.length === 0 && !isMonitoringRef.current) {
            sendPushNotification(
              `${freePosts.length} new free request${freePosts.length > 1 ? "s" : ""}`,
              msg,
            );
          }
        }

        // Mark as seen
        freshPosts.forEach((p) => seenPostIds.current.add(p.id));
        saveSeenPostIds(seenPostIds.current);

        // Also notify the queue-view via a custom event so it can update its UI
        window.dispatchEvent(
          new CustomEvent("fixtral:newPosts", {
            detail: { postIds: freshPosts.map((p: any) => p.id) },
          }),
        );
      }
    } catch (e) {
      console.error("Post check error:", e);
    }
  }, []);

  // ─── Poll for new replies ────────────────────────────────────────

  const checkReplies = useCallback(async () => {
    try {
      const username = getRedditUsername();
      if (!username) return;

      const res = await authedFetch(`/api/reddit/replies?username=${username}`);
      const data = await res.json();
      if (!data.ok) return;

      // Broadcast commented post IDs so queue-view can show badges
      if (data.commentedPostIds?.length > 0) {
        window.dispatchEvent(
          new CustomEvent("fixtral:commentedPosts", {
            detail: { postIds: data.commentedPostIds },
          }),
        );
      }

      const newReplies = (data.replies || []).filter(
        (r: any) => !seenReplyIds.current.has(r.replyId),
      );

      if (newReplies.length > 0) {
        const grouped: Record<string, string[]> = {};
        for (const r of newReplies) {
          if (!grouped[r.subreddit]) grouped[r.subreddit] = [];
          grouped[r.subreddit].push(r.replyAuthor);
        }

        const parts: string[] = [];
        for (const [sub, authors] of Object.entries(grouped)) {
          const unique = [...new Set(authors)];
          parts.push(
            `${unique.join(" and ")} replied to your comment in ${sub}`,
          );
        }

        if (parts.length > 0 && !isMutedRef.current) {
          notify(parts.join(". "), "reply");
        }

        newReplies.forEach((r: any) => seenReplyIds.current.add(r.replyId));
        saveSeenReplyIds(seenReplyIds.current);
      }
    } catch (e) {
      console.error("Reply check error:", e);
    }
  }, []);

  // ─── Start polling on mount ──────────────────────────────────────

  useEffect(() => {
    // Initial checks
    checkNewPosts();
    checkReplies();

    // Set up intervals
    const postInterval = setInterval(checkNewPosts, FETCH_INTERVAL);
    const replyInterval = setInterval(checkReplies, REPLY_CHECK_INTERVAL);

    return () => {
      clearInterval(postInterval);
      clearInterval(replyInterval);
    };
  }, [checkNewPosts, checkReplies]);

  return (
    <PushContext.Provider
      value={{
        isSubscribed,
        isSupported,
        isMuted,
        isMonitoring,
        subscribe: subscribeToPush,
        unsubscribe: unsubscribeFromPush,
        toggleMute,
        toggleMonitoring,
      }}
    >
      {children}
    </PushContext.Provider>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

async function sendPushNotification(title: string, body: string) {
  try {
    await authedFetch("/api/push/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, body, url: "/app" }),
    });
  } catch (error) {
    // Push send failed silently - not critical
  }
}
