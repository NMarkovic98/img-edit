"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { authedFetch } from "@/lib/api";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
// Progress component will be created inline
import {
  Wand2,
  Image as ImageIcon,
  Clock,
  User,
  ExternalLink,
  Loader2,
  CheckCircle,
  XCircle,
  DollarSign,
  MessageCircle,
  AlertCircle,
  Link,
  ShieldCheck,
  ShieldAlert,
  ChevronLeft,
  ChevronRight,
  Sparkles,
} from "lucide-react";
import Image from "next/image";
import { useImageViewer } from "./image-viewer";

interface RedditPost {
  id: string;
  title: string;
  description: string;
  imageUrl: string;
  allImages: string[];
  isGallery: boolean;
  imageCount: number;
  postUrl: string;
  created_utc: number;
  created_date: string;
  author: string;
  score: number;
  num_comments: number;
  subreddit: string;
  flair?: string | null;
  isPaid?: boolean;
  aiPolicy?: "ai_ok" | "no_ai" | "unknown";
}

interface AnalysisResult {
  ok: boolean;
  postId: string;
  originalPost: RedditPost;
  analysis: string;
  editCategory?: string;
  hasFaceEdit?: boolean;
  facePreservation?: "strict" | "light" | "none";
  timestamp: string;
}

interface EditRequest {
  id: string;
  post: RedditPost;
  status: "pending" | "processing" | "completed" | "failed";
  analysis?: string;
  editForm?: any;
  editedImageUrl?: string;
  timestamp?: number;
}

const AVAILABLE_SUBREDDITS = [
  { id: "PhotoshopRequest", label: "r/PhotoshopRequest" },
  { id: "PhotoshopRequests", label: "r/PhotoshopRequests" },
  { id: "picrequests", label: "r/picrequests" },
  { id: "estoration", label: "r/estoration" },
  { id: "editmyphoto", label: "r/editmyphoto" },
];

// Fallback colors per subreddit if icon can't be loaded
const SUBREDDIT_FALLBACK: Record<string, { bg: string; emoji: string }> = {
  photoshoprequest:  { bg: "#0078D4", emoji: "🖌️" },
  photoshoprequests: { bg: "#0078D4", emoji: "🖌️" },
  editmyphoto:       { bg: "#16A34A", emoji: "📷" },
  estoration:        { bg: "#B45309", emoji: "🕰️" },
  picrequests:       { bg: "#7C3AED", emoji: "🖼️" },
};

function SubredditIcon({
  subreddit,
  iconUrl,
}: {
  subreddit: string;
  iconUrl?: string | null;
}) {
  const [failed, setFailed] = useState(false);
  const fb = SUBREDDIT_FALLBACK[subreddit.toLowerCase()] ?? { bg: "#6B7280", emoji: "📣" };

  if (iconUrl && !failed) {
    return (
      <img
        src={iconUrl}
        alt={`r/${subreddit}`}
        title={`r/${subreddit}`}
        width={32}
        height={32}
        className="w-8 h-8 rounded-full shadow-md object-cover select-none border border-white/10"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <div
      className="flex items-center justify-center w-8 h-8 rounded-full text-base shadow-md select-none border border-white/10"
      style={{ background: fb.bg }}
      title={`r/${subreddit}`}
    >
      {fb.emoji}
    </div>
  );
}

// Format time ago in minutes
function timeAgo(utc: number): string {
  const now = Date.now() / 1000;
  const diff = Math.floor(now - utc);
  if (diff < 60) return `${diff}s ago`;
  const mins = Math.floor(diff / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m ago`;
}

// ---------------------------------------------------------------------------
// Model pricing & selection system (resolution-aware)
// ---------------------------------------------------------------------------
interface ModelOption {
  id: string;
  name: string;
  price: string;
  tier: string;
}

function getModelOptions(w: number, h: number, isPaid = false): ModelOption[] {
  const max = Math.max(w, h);
  const megapixels = Math.ceil((w * h) / 1_000_000);

  const models: ModelOption[] = [];

  if (max > 4096) {
    // >4096 on any side → FLUX 2 Max + Seedream 4.5
    const flux2MaxPrice = (0.03 + Math.max(0, megapixels - 1) * 0.015).toFixed(
      2,
    );
    models.push(
      {
        id: "flux-2-max",
        name: "FLUX 2 Max",
        price: `~$${flux2MaxPrice}`,
        tier: ">4K",
      },
      {
        id: "seedream-4.5",
        name: "Seedream 4.5",
        price: "$0.04",
        tier: ">4K",
      },
    );
  } else if (max > 2048) {
    // 2049–4096 → NB Pro 4K + NB 2 (4K)
    models.push(
      {
        id: "nano-banana-pro",
        name: "NB Pro 4K",
        price: "$0.30",
        tier: "4K",
      },
      {
        id: "nano-banana-2",
        name: "NB2 4K",
        price: "$0.16",
        tier: "4K",
      },
    );
  } else {
    // ≤2048 → NB Pro 2K
    models.push({
      id: "nano-banana-pro",
      name: "NB Pro 2K",
      price: "$0.15",
      tier: "2K",
    });
  }

  // Background removal — always available
  models.push({
    id: "bria-bg-remove",
    name: "BG Remove",
    price: "$0.018",
    tier: "Util",
  });

  // Unblur / super-resolution — always available
  models.push({
    id: "aura-sr",
    name: "Aura SR (Unblur)",
    price: "~$0.01/MP",
    tier: "Util",
  });

  return models;
}

// Category label & model lookup for display
const CATEGORY_DISPLAY: Record<string, { label: string; model: string }> = {
  remove_object: {
    label: "🗑️ Remove Object/Person",
    model: "Nano Banana Pro",
  },
  remove_background: { label: "🖼️ Remove Background", model: "Bria RMBG 2.0" },
  enhance_beautify: {
    label: "✨ Enhance / Beautify",
    model: "Nano Banana Pro",
  },
  restore_old_photo: {
    label: "🔧 Restore Old Photo",
    model: "Nano Banana Pro",
  },
  face_swap: { label: "🔄 Face Swap", model: "Nano Banana Pro" },
  add_object: { label: "➕ Add Object", model: "Nano Banana Pro" },
  color_correction: { label: "🎨 Color Correction", model: "Nano Banana Pro" },
  scene_change: { label: "🌅 Scene Change", model: "Nano Banana Pro" },
  creative_fun: { label: "🎭 Creative / Fun", model: "Nano Banana Pro" },
  text_edit: { label: "✏️ Text Edit", model: "Nano Banana Pro" },
  composite_multi: { label: "🧩 Combine Photos", model: "Nano Banana Pro" },
  body_modification: {
    label: "🦴 Body Modification",
    model: "Nano Banana Pro",
  },
  professional_headshot: {
    label: "📸 Professional Headshot",
    model: "Nano Banana Pro",
  },
};

function getCategoryLabel(category: string): string {
  return CATEGORY_DISPLAY[category]?.label || category;
}

function getCategoryModel(category: string): string {
  return CATEGORY_DISPLAY[category]?.model || "Auto";
}

// Resolution badge — loads image natively to read naturalWidth × naturalHeight
function ResolutionBadge({
  src,
  onDims,
}: {
  src: string;
  onDims?: (w: number, h: number) => void;
}) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  useEffect(() => {
    const img = new window.Image();
    img.onload = () => {
      setDims({ w: img.naturalWidth, h: img.naturalHeight });
      onDims?.(img.naturalWidth, img.naturalHeight);
    };
    img.src = src;
  }, [src]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!dims) return null;

  const max = Math.max(dims.w, dims.h);
  let label: string;
  let color: string;
  if (max >= 3840) {
    label = "4K";
    color = "bg-green-600";
  } else if (max >= 2560) {
    label = "2K";
    color = "bg-green-600";
  } else if (max >= 1920) {
    label = "FHD";
    color = "bg-blue-600";
  } else if (max >= 1280) {
    label = "HD";
    color = "bg-yellow-600";
  } else {
    label = "SD";
    color = "bg-red-600";
  }

  return (
    <div
      className={`absolute bottom-1.5 left-1.5 ${color} text-white text-[9px] font-bold px-1.5 py-0.5 rounded leading-none z-10`}
    >
      {dims.w}×{dims.h} {label}
    </div>
  );
}

// Image slider component for multi-image gallery posts
function ImageSlider({
  images,
  postUrl,
  showImage,
  onDims,
}: {
  images: string[];
  postUrl: string;
  showImage: (
    src: string,
    title: string,
    downloadUrl: string,
    postUrl: string,
  ) => void;
  onDims?: (w: number, h: number) => void;
}) {
  const [currentIndex, setCurrentIndex] = useState(0);

  const goTo = (idx: number) => {
    if (idx < 0) setCurrentIndex(images.length - 1);
    else if (idx >= images.length) setCurrentIndex(0);
    else setCurrentIndex(idx);
  };

  return (
    <div className="relative">
      <div
        className="relative aspect-[3/2] sm:aspect-[4/3] overflow-hidden rounded-lg border cursor-pointer"
        onClick={() =>
          showImage(
            images[currentIndex],
            `Image ${currentIndex + 1} of ${images.length}`,
            images[currentIndex],
            postUrl,
          )
        }
      >
        <Image
          src={images[currentIndex]}
          alt={`Image ${currentIndex + 1} of ${images.length}`}
          fill
          className="object-contain bg-black/5"
        />
        <ResolutionBadge
          src={images[currentIndex]}
          onDims={currentIndex === 0 ? onDims : undefined}
        />
      </div>
      {/* Navigation arrows */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          goTo(currentIndex - 1);
        }}
        className="absolute left-1 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-black/50 text-white flex items-center justify-center hover:bg-black/70 transition-colors"
      >
        <ChevronLeft className="h-4 w-4" />
      </button>
      <button
        onClick={(e) => {
          e.stopPropagation();
          goTo(currentIndex + 1);
        }}
        className="absolute right-1 top-1/2 -translate-y-1/2 w-7 h-7 rounded-full bg-black/50 text-white flex items-center justify-center hover:bg-black/70 transition-colors"
      >
        <ChevronRight className="h-4 w-4" />
      </button>
      {/* Dots indicator */}
      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex gap-1">
        {images.map((_, idx) => (
          <button
            key={idx}
            onClick={(e) => {
              e.stopPropagation();
              setCurrentIndex(idx);
            }}
            className={`w-1.5 h-1.5 rounded-full transition-colors ${idx === currentIndex ? "bg-white" : "bg-white/50"}`}
          />
        ))}
      </div>
      {/* Counter badge */}
      <div className="absolute top-2 left-2 bg-black/60 text-white text-[10px] font-medium px-1.5 py-0.5 rounded-md">
        {currentIndex + 1}/{images.length}
      </div>
    </div>
  );
}

export function QueueView() {
  const [posts, setPosts] = useState<RedditPost[]>([]);
  const [editRequests, setEditRequests] = useState<EditRequest[]>([]);
  const [loading, setLoading] = useState(false);
  const [analyzingPostId, setAnalyzingPostId] = useState<string | null>(null);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(
    null,
  );
  const [selectedSubreddits, setSelectedSubreddits] = useState<string[]>(
    AVAILABLE_SUBREDDITS.map((s) => s.id), // All selected by default
  );
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [newPostIds, setNewPostIds] = useState<Set<string>>(new Set());
  const [newPostCount, setNewPostCount] = useState(0);
  const [filterPaid, setFilterPaid] = useState<"all" | "paid" | "free">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [rateLimited, setRateLimited] = useState(false);
  const [commentedPostIds, setCommentedPostIds] = useState<Set<string>>(
    new Set(),
  );
  // Per-post image dimensions and selected model
  const [postDims, setPostDims] = useState<
    Record<string, { w: number; h: number }>
  >({});
  const [postModel, setPostModel] = useState<Record<string, string>>({});
  const [subredditIcons, setSubredditIcons] = useState<Record<string, string | null>>({});
  const { showImage } = useImageViewer();
  const [, setTick] = useState(0);
  const [highlightPostId, setHighlightPostId] = useState<string | null>(null);

  // Check URL for ?post= param (from notification click) and listen for SW messages
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const postParam = params.get("post");
    if (postParam) {
      setHighlightPostId(postParam);
      // Clean up URL
      window.history.replaceState({}, "", window.location.pathname);
    }

    const handleSWMessage = (event: MessageEvent) => {
      if (event.data?.type === "NAVIGATE_TO_POST" && event.data.postId) {
        setHighlightPostId(event.data.postId);
        // Scroll to it after a short delay for render
        setTimeout(() => {
          const el = document.getElementById(`post-${event.data.postId}`);
          if (el) el.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 300);
      }
    };

    navigator.serviceWorker?.addEventListener("message", handleSWMessage);
    return () => {
      navigator.serviceWorker?.removeEventListener("message", handleSWMessage);
    };
  }, []);

  // Re-render every 10s to update "time ago" labels
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 10000);
    return () => clearInterval(timer);
  }, []);

  // Auto-clear NEW badges after 10 seconds so already-seen posts don't stay highlighted
  useEffect(() => {
    if (newPostIds.size === 0) return;
    const timer = setTimeout(() => {
      setNewPostIds(new Set());
      setNewPostCount(0);
    }, 10000);
    return () => clearTimeout(timer);
  }, [newPostIds]);

  // Scroll to highlighted post when posts load
  useEffect(() => {
    if (!highlightPostId || posts.length === 0) return;
    const el = document.getElementById(`post-${highlightPostId}`);
    if (el) {
      setTimeout(
        () => el.scrollIntoView({ behavior: "smooth", block: "center" }),
        200,
      );
      // Clear highlight after 5 seconds
      setTimeout(() => setHighlightPostId(null), 5000);
    }
  }, [highlightPostId, posts]);

  // Fetch subreddit icons (real Reddit logos) once per subreddit selection
  useEffect(() => {
    const missing = selectedSubreddits.filter(
      (s) => !(s.toLowerCase() in subredditIcons),
    );
    if (missing.length === 0) return;

    authedFetch(`/api/reddit/subreddit-icons?subreddits=${missing.join(",")}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) {
          // Normalize keys to lowercase for consistent lookup
          const normalized: Record<string, string | null> = {};
          for (const [k, v] of Object.entries(data.icons as Record<string, string | null>)) {
            normalized[k.toLowerCase()] = v;
          }
          setSubredditIcons((prev) => ({ ...prev, ...normalized }));
        }
      })
      .catch(() => {});
  }, [selectedSubreddits]); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for global notification events from NotificationProvider
  useEffect(() => {
    const onNewPosts = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const ids: string[] = detail?.postIds || [];
      if (ids.length > 0) {
        setNewPostIds((prev) => {
          const updated = new Set(prev);
          ids.forEach((id) => updated.add(id));
          return updated;
        });
        setNewPostCount((prev) => prev + ids.length);
        // Also refresh the post list
        fetchPosts(true);
      }
    };
    const onCommentedPosts = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.postIds) {
        setCommentedPostIds(new Set(detail.postIds));
      }
    };
    window.addEventListener("fixtral:newPosts", onNewPosts);
    window.addEventListener("fixtral:commentedPosts", onCommentedPosts);
    return () => {
      window.removeEventListener("fixtral:newPosts", onNewPosts);
      window.removeEventListener("fixtral:commentedPosts", onCommentedPosts);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleSubreddit = (id: string) => {
    setSelectedSubreddits((prev) => {
      if (prev.includes(id)) {
        if (prev.length === 1) return prev; // Keep at least one
        return prev.filter((s) => s !== id);
      }
      return [...prev, id];
    });
  };

  // Fetch Reddit posts (notifications are handled globally by NotificationProvider)
  const fetchPosts = useCallback(
    async (silent = false, noCache = false) => {
      if (!silent) setLoading(true);
      try {
        const subredditsParam = selectedSubreddits.join(",");
        const cacheBust = noCache ? "&noCache=1" : "";
        const response = await authedFetch(
          `/api/reddit/posts?subreddits=${subredditsParam}${cacheBust}`,
        );
        const data = await response.json();

        if (!data.ok && data.isRateLimited) {
          setError("Reddit is rate-limiting requests. Returning cached data.");
          setRateLimited(true);
        } else if (data.rateLimited) {
          setRateLimited(true);
          setError(null);
        } else if (!data.ok) {
          setError(data.error || "Failed to fetch posts");
          setRateLimited(false);
        } else {
          setError(null);
          setRateLimited(false);
        }

        if (data.ok) {
          const rawPosts: RedditPost[] = data.posts || [];

          // Deduplicate posts by ID and filter out solved
          const seen = new Set<string>();
          const fetchedPosts = rawPosts.filter((p) => {
            if (seen.has(p.id)) return false;
            seen.add(p.id);
            // Filter out solved requests
            if (p.flair && p.flair.toLowerCase().includes("solved"))
              return false;
            return true;
          });

          // Sort: newest first (strictly by time)
          fetchedPosts.sort((a, b) => b.created_utc - a.created_utc);

          // Merge with existing state instead of replacing. Partial fetches
          // (one subreddit 429s while others succeed) would otherwise shrink
          // the list every 10s. Posts age out naturally via the 2h cutoff.
          const twoHoursAgo = Date.now() / 1000 - 2 * 60 * 60;
          if (!silent) {
            // User-initiated load: trust server fully
            setPosts(fetchedPosts);
          } else {
            setPosts((prev) => {
              const byId = new Map<string, RedditPost>();
              for (const p of prev) byId.set(p.id, p);
              // Overlay fresh data (updates scores, flair, etc.)
              for (const p of fetchedPosts) byId.set(p.id, p);
              return Array.from(byId.values())
                .filter((p) => p.created_utc > twoHoursAgo)
                .filter(
                  (p) =>
                    !(p.flair && p.flair.toLowerCase().includes("solved")),
                )
                .sort((a, b) => b.created_utc - a.created_utc);
            });
          }
        }
      } catch (error) {
        console.error("Error fetching posts:", error);
      }
      if (!silent) setLoading(false);
    },
    [selectedSubreddits],
  );

  // Analyze post with Google Gemini 2.5 Flash
  const analyzePost = async (postId: string) => {
    setAnalyzingPostId(postId);
    try {
      // Use the post already loaded in state instead of re-fetching
      const post = posts.find((p) => p.id === postId);

      if (!post) {
        throw new Error("Post not found");
      }

      // Now analyze with Google Gemini 2.5 Flash
      const analysisResponse = await authedFetch("/api/reddit/posts", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          title: post.title,
          description: post.description,
          imageUrl: post.imageUrl,
          allImages: post.allImages || [post.imageUrl],
          isGallery: post.isGallery || false,
          imageCount: post.imageCount || 1,
          aiPolicy: post.aiPolicy || "unknown",
        }),
      });

      const result = await analysisResponse.json();
      if (result.ok) {
        setAnalysisResult({
          ok: true,
          postId: postId,
          originalPost: post,
          analysis: result.changeSummary,
          editCategory: result.editCategory,
          hasFaceEdit: result.hasFaceEdit,
          facePreservation: result.facePreservation || "strict",
          timestamp: result.timestamp,
        });
      } else {
        console.error("Analysis failed:", result.error);
      }
    } catch (error) {
      console.error("Error analyzing post:", error);
    }
    setAnalyzingPostId(null);
  };

  // Send analyzed post to editor (for the new workflow)
  const sendToEditor = (
    post: RedditPost,
    analysis: string,
    editCategory?: string,
    hasFaceEdit?: boolean,
    facePreservation?: "strict" | "light" | "none",
  ) => {
    console.log("Sending to editor:", {
      post,
      analysis,
      editCategory,
      hasFaceEdit,
    });

    const requestId = `req_${Date.now()}_${post.id}`;

    const newRequest: EditRequest = {
      id: requestId,
      post,
      status: "completed",
      analysis: analysis,
      timestamp: Date.now(),
    };

    setEditRequests((prev) => [...prev, newRequest]);

    // Store in localStorage for the editor to pick up
    const editorData = {
      id: requestId,
      post: post,
      allImages: post.allImages || [post.imageUrl],
      analysis: analysis,
      modelOverride: postModel[post.id] || null,
      editCategory: editCategory || null,
      hasFaceEdit: hasFaceEdit ?? false,
      facePreservation: facePreservation || "strict",
      aiPolicy: post.aiPolicy || "unknown",
      timestamp: new Date().toISOString(),
    };

    console.log("Storing editor data:", editorData);
    localStorage.setItem("pendingEditorItem", JSON.stringify(editorData));

    // Clear analysis result
    setAnalysisResult(null);

    // Force a storage event to trigger tab switch (for same-window navigation)
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "pendingEditorItem",
        newValue: JSON.stringify(editorData),
        oldValue: null,
        storageArea: localStorage,
      }),
    );
  };

  // Fetch on mount and when subreddits change
  useEffect(() => {
    fetchPosts();
  }, [fetchPosts]);

  // Auto-refresh every 10 seconds
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      fetchPosts(true); // silent refresh
    }, 10000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchPosts]);

  return (
    <div className="max-w-7xl mx-auto space-y-4 sm:space-y-6">
      {/* Analysis Result Modal */}
      {analysisResult && (
        <Card className="border-primary/20 bg-gradient-to-r from-primary/5 via-primary/10 to-primary/5 shadow-xl mobile-card">
          <CardHeader className="pb-4">
            <div className="flex flex-col sm:flex-row items-start sm:items-center space-y-3 sm:space-y-0 sm:space-x-3">
              <div className="p-2 bg-green-500 rounded-full touch-target">
                <CheckCircle className="h-5 w-5 sm:h-6 sm:w-6 text-white" />
              </div>
              <div className="flex-1">
                <CardTitle className="text-lg sm:text-xl font-bold mobile-responsive-heading">
                  Analysis Complete!
                </CardTitle>
                <CardDescription className="text-muted-foreground text-sm sm:text-base">
                  Google Gemini 2.5 Flash has analyzed the post and generated an
                  edit prompt
                </CardDescription>
              </div>
              <Badge
                variant="secondary"
                className="bg-primary/10 text-primary border-primary/20 font-semibold text-xs sm:text-sm"
              >
                Step 1: AI Analysis Complete
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="space-y-4 sm:space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
              {/* Original Post */}
              <div className="space-y-3 sm:space-y-4">
                <h3 className="font-semibold text-foreground flex items-center space-x-2 text-sm sm:text-base">
                  <ImageIcon className="h-4 w-4 text-primary" />
                  <span>Original Reddit Post</span>
                </h3>
                <div className="space-y-3">
                  <div className="bg-card p-4 sm:p-6 rounded-xl border shadow-sm">
                    <h4 className="font-semibold mb-3 text-card-foreground text-sm sm:text-base line-clamp-2">
                      {analysisResult.originalPost.title}
                    </h4>
                    <p className="text-sm text-muted-foreground mb-4 leading-relaxed line-clamp-3">
                      {analysisResult.originalPost.description}
                    </p>
                    <div className="flex flex-wrap items-center gap-3 sm:gap-6 text-xs text-muted-foreground">
                      <span className="flex items-center">
                        <User className="h-3 w-3 mr-1 sm:mr-2" />
                        {analysisResult.originalPost.author}
                      </span>
                      <span className="flex items-center">
                        <Clock className="h-3 w-3 mr-1 sm:mr-2" />
                        {new Date(
                          analysisResult.originalPost.created_utc * 1000,
                        ).toLocaleDateString()}
                      </span>
                    </div>
                  </div>

                  <div
                    className="relative aspect-video overflow-hidden rounded-xl border bg-card shadow-md cursor-pointer hover:shadow-lg transition-all duration-300 group touch-target"
                    onClick={() =>
                      showImage(
                        analysisResult.originalPost.imageUrl,
                        `Reddit Image${analysisResult.originalPost.isGallery ? ` (1 of ${analysisResult.originalPost.imageCount})` : ""}`,
                        analysisResult.originalPost.imageUrl,
                        analysisResult.originalPost.postUrl,
                      )
                    }
                  >
                    <Image
                      src={analysisResult.originalPost.imageUrl}
                      alt="Original Reddit image"
                      fill
                      className="object-cover group-hover:scale-105 transition-transform duration-300"
                    />
                    <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors duration-300 rounded-xl"></div>
                  </div>

                  {/* Image URL & Quality Indicator */}
                  <div className="bg-card p-3 sm:p-4 rounded-xl border shadow-sm space-y-2">
                    <h4 className="font-semibold text-xs sm:text-sm text-muted-foreground flex items-center space-x-1.5">
                      <Link className="h-3.5 w-3.5" />
                      <span>Image URL → Edit API</span>
                    </h4>
                    <div className="bg-muted/50 rounded-lg p-2 overflow-x-auto">
                      <code className="text-[10px] sm:text-xs break-all text-foreground/80 font-mono">
                        {analysisResult.originalPost.imageUrl}
                      </code>
                    </div>
                    {(() => {
                      const url = analysisResult.originalPost.imageUrl;
                      const isOriginal = url.includes("i.redd.it");
                      const isPreview = url.includes("preview.redd.it");
                      const isImgur = url.includes("i.imgur.com");
                      return (
                        <div
                          className={`flex items-center space-x-2 text-xs sm:text-sm font-medium px-2 py-1.5 rounded-lg ${
                            isOriginal || isImgur
                              ? "text-green-700 dark:text-green-400 bg-green-500/10 border border-green-500/20"
                              : isPreview
                                ? "text-red-700 dark:text-red-400 bg-red-500/10 border border-red-500/20"
                                : "text-yellow-700 dark:text-yellow-400 bg-yellow-500/10 border border-yellow-500/20"
                          }`}
                        >
                          {isOriginal || isImgur ? (
                            <>
                              <ShieldCheck className="h-4 w-4 flex-shrink-0" />
                              <span>
                                Original resolution (i.redd.it) — no quality
                                loss
                              </span>
                            </>
                          ) : isPreview ? (
                            <>
                              <ShieldAlert className="h-4 w-4 flex-shrink-0" />
                              <span>
                                Preview image (preview.redd.it) — recompressed,
                                quality may be reduced
                              </span>
                            </>
                          ) : (
                            <>
                              <AlertCircle className="h-4 w-4 flex-shrink-0" />
                              <span>External URL — quality unknown</span>
                            </>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                </div>
              </div>

              {/* Analysis & Actions */}
              <div className="space-y-3 sm:space-y-4">
                <h3 className="font-semibold text-foreground flex items-center space-x-2 text-sm sm:text-base">
                  <Wand2 className="h-4 w-4 text-primary" />
                  <span>AI-Generated Edit Prompt</span>
                </h3>

                {/* Category badge */}
                {analysisResult.editCategory && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge
                      variant="default"
                      className="text-xs px-2.5 py-1 bg-primary/90"
                    >
                      {getCategoryLabel(analysisResult.editCategory)}
                    </Badge>
                    {analysisResult.hasFaceEdit && (
                      <Badge
                        variant="outline"
                        className="text-xs px-2 py-1 border-amber-500 text-amber-600 dark:text-amber-400"
                      >
                        👤 Face Edit — Face-Safe Models Only
                      </Badge>
                    )}
                    <span className="text-[10px] text-muted-foreground font-mono">
                      → {getCategoryModel(analysisResult.editCategory)}
                    </span>
                  </div>
                )}

                <div className="bg-card p-4 sm:p-6 rounded-xl border shadow-sm">
                  <div className="flex items-start space-x-3">
                    <div className="p-2 bg-primary/10 rounded-lg">
                      <Wand2 className="h-4 w-4 text-primary" />
                    </div>
                    <div className="flex-1">
                      <p className="text-sm leading-relaxed text-card-foreground">
                        {analysisResult.analysis}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="flex flex-col sm:flex-row gap-3">
                  <Button
                    onClick={() =>
                      sendToEditor(
                        analysisResult.originalPost,
                        analysisResult.analysis,
                        analysisResult.editCategory,
                        analysisResult.hasFaceEdit,
                        analysisResult.facePreservation,
                      )
                    }
                    className="flex-1 bg-gradient-to-r from-orange-500 to-red-500 hover:from-orange-600 hover:to-red-600 text-white font-semibold shadow-lg hover:shadow-xl transition-all duration-200 mobile-button"
                  >
                    <Wand2 className="mr-2 h-4 w-4" />
                    Send to Editor
                  </Button>

                  <Button
                    onClick={() => setAnalysisResult(null)}
                    variant="outline"
                    className="flex-1 border-muted-foreground/20 hover:bg-muted/50 font-semibold transition-all duration-200 mobile-button"
                  >
                    Cancel
                  </Button>
                </div>

                <div className="bg-gradient-to-r from-primary/5 to-primary/10 border border-primary/20 p-3 sm:p-4 rounded-xl">
                  <div className="flex items-start space-x-3">
                    <div className="p-1 bg-primary/20 rounded-lg">
                      <ExternalLink className="h-3 w-3 text-primary" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-primary mb-1">
                        Next Step:
                      </p>
                      <p className="text-sm text-muted-foreground">
                        Switch to the Editor tab to modify the prompt and
                        generate the edited image.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Posts Grid */}
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Button
              onClick={() => setAutoRefresh(!autoRefresh)}
              variant={autoRefresh ? "default" : "outline"}
              size="sm"
              className={`h-8 px-2.5 text-xs ${autoRefresh ? "bg-green-600 hover:bg-green-700" : ""}`}
            >
              <Clock className="mr-1 h-3 w-3" />
              {autoRefresh ? "Auto" : "Auto"}
            </Button>
            <Button
              onClick={() => fetchPosts(false, true)}
              disabled={loading}
              size="sm"
              className="h-8 px-2.5 text-xs"
            >
              {loading ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <>
                  <Loader2 className="mr-1 h-3 w-3" />
                  Refresh
                </>
              )}
            </Button>
            {newPostCount > 0 && (
              <Badge
                variant="destructive"
                className="animate-pulse cursor-pointer text-[10px] px-1.5 py-0"
                onClick={() => {
                  setNewPostCount(0);
                  setNewPostIds(new Set());
                }}
              >
                {newPostCount} new
              </Badge>
            )}
          </div>
          <span className="text-xs text-muted-foreground">
            {posts.length} posts
          </span>
        </div>

        {rateLimited && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-red-500/30 bg-red-50/10 text-xs text-red-400 animate-pulse">
            <AlertCircle className="h-3.5 w-3.5 flex-shrink-0" />
            <span>Rate limited by Reddit — showing cached data</span>
          </div>
        )}

        {error && (
          <div className="flex items-start gap-3 p-4 rounded-xl border border-yellow-500/30 bg-yellow-50/10 text-sm">
            <XCircle className="h-5 w-5 text-yellow-500 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold text-yellow-600">
                Unable to fetch posts
              </p>
              <p className="text-muted-foreground mt-1">{error}</p>
            </div>
          </div>
        )}

        {/* Search and filter controls */}
        <div className="flex flex-col sm:flex-row gap-2 mb-4">
          <input
            type="text"
            placeholder="Search posts..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="flex-1 px-3 py-1.5 text-sm rounded-md border border-input bg-background"
          />
          <div className="flex gap-1">
            {(["all", "paid", "free"] as const).map((f) => (
              <button
                key={f}
                onClick={() => setFilterPaid(f)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  filterPaid === f
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-muted/80"
                }`}
              >
                {f === "all" ? "All" : f === "paid" ? "Paid" : "Free"}
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-3 sm:gap-6 md:grid-cols-2 lg:grid-cols-3">
          {posts
            .filter((post) => {
              if (filterPaid === "paid") return post.isPaid;
              if (filterPaid === "free") return !post.isPaid;
              return true;
            })
            .filter((post) => {
              if (!searchQuery.trim()) return true;
              const q = searchQuery.toLowerCase();
              return (
                post.title.toLowerCase().includes(q) ||
                (post.description || "").toLowerCase().includes(q) ||
                post.author.toLowerCase().includes(q) ||
                post.subreddit.toLowerCase().includes(q)
              );
            })
            .map((post) => {
              const isNew = newPostIds.has(post.id);
              return (
                <Card
                  key={post.id}
                  id={`post-${post.id}`}
                  className={`overflow-hidden hover:shadow-lg transition-shadow relative ${isNew ? "ring-2 ring-blue-500 ring-offset-2 ring-offset-background" : ""} ${commentedPostIds.has(post.id) ? "border-purple-500/50 border-2" : ""} ${highlightPostId === post.id ? "ring-2 ring-orange-500 ring-offset-2 ring-offset-background animate-pulse" : ""}`}
                >
                  {/* Top-left subreddit icon */}
                  <div className="absolute top-2 left-2 z-10">
                    <SubredditIcon
                      subreddit={post.subreddit}
                      iconUrl={subredditIcons[post.subreddit.toLowerCase()]}
                    />
                  </div>

                  {/* Top-right badges */}
                  <div className="absolute top-2 right-2 z-10 flex gap-1.5">
                    {commentedPostIds.has(post.id) && (
                      <Badge className="bg-purple-600 text-white font-bold shadow-lg">
                        <MessageCircle className="h-3 w-3 mr-1" />
                        Commented
                      </Badge>
                    )}
                    {isNew && (
                      <Badge className="bg-blue-500 text-white font-bold animate-pulse shadow-lg">
                        NEW
                      </Badge>
                    )}
                  </div>
                  <CardHeader className="pb-2 sm:pb-3 px-3 sm:px-6 pt-3 sm:pt-6">
                    <div className="flex items-start justify-between">
                      <div className="space-y-1.5 sm:space-y-2 flex-1 pl-10 pr-12">
                        <CardTitle className="text-sm sm:text-lg leading-tight line-clamp-2">
                          {post.title}
                        </CardTitle>
                        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 text-[10px] sm:text-xs">
                          <Badge
                            variant="outline"
                            className="text-[10px] px-1.5 py-0"
                          >
                            r/{post.subreddit}
                          </Badge>
                          {post.isPaid ? (
                            <Badge className="bg-green-600 hover:bg-green-700 text-white text-[10px] px-1.5 py-0">
                              <DollarSign className="h-2.5 w-2.5 mr-0.5" />
                              Paid
                            </Badge>
                          ) : (
                            <Badge
                              variant="secondary"
                              className="text-[10px] px-1.5 py-0 text-muted-foreground"
                            >
                              Free
                            </Badge>
                          )}
                          {post.flair &&
                            !post.flair.toLowerCase().includes("paid") && (
                              <Badge
                                variant="outline"
                                className="text-[10px] px-1.5 py-0 border-orange-300 text-orange-600"
                              >
                                {post.flair}
                              </Badge>
                            )}
                          {post.aiPolicy === "no_ai" && (
                            <Badge
                              variant="destructive"
                              className="text-[10px] px-1.5 py-0"
                            >
                              NO AI
                            </Badge>
                          )}
                          {post.aiPolicy === "ai_ok" && (
                            <Badge
                              variant="outline"
                              className="text-[10px] px-1.5 py-0 border-green-400 text-green-600"
                            >
                              AI OK
                            </Badge>
                          )}
                          <span className="flex items-center text-muted-foreground">
                            <User className="h-3 w-3 mr-1" />
                            {post.author}
                          </span>
                          <span className="flex items-center text-muted-foreground font-medium">
                            <Clock className="h-3 w-3 mr-1" />
                            {timeAgo(post.created_utc)}
                          </span>
                          <a
                            href={post.postUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="flex items-center text-blue-600 hover:underline"
                          >
                            <ExternalLink className="h-3 w-3 mr-1" />
                            Reddit
                          </a>
                        </div>
                      </div>
                    </div>
                  </CardHeader>

                  <CardContent className="space-y-2 sm:space-y-4 px-3 sm:px-6 pb-3 sm:pb-6">
                    {post.allImages && post.allImages.length > 1 ? (
                      <ImageSlider
                        images={post.allImages}
                        postUrl={post.postUrl}
                        showImage={showImage}
                        onDims={(w, h) =>
                          setPostDims((prev) => ({
                            ...prev,
                            [post.id]: { w, h },
                          }))
                        }
                      />
                    ) : post.imageUrl ? (
                      <div
                        className="relative aspect-[3/2] sm:aspect-[4/3] overflow-hidden rounded-lg border cursor-pointer hover:opacity-90 transition-opacity"
                        onClick={() =>
                          showImage(
                            post.imageUrl,
                            "Reddit Image",
                            post.imageUrl,
                            post.postUrl,
                          )
                        }
                      >
                        <Image
                          src={post.imageUrl}
                          alt="Post image"
                          fill
                          className="object-contain bg-black/5"
                        />
                        <ResolutionBadge
                          src={post.imageUrl}
                          onDims={(w, h) =>
                            setPostDims((prev) => ({
                              ...prev,
                              [post.id]: { w, h },
                            }))
                          }
                        />
                      </div>
                    ) : null}

                    {post.description && (
                      <p className="text-xs sm:text-sm text-muted-foreground line-clamp-2 sm:line-clamp-3">
                        {post.description}
                      </p>
                    )}

                    {/* Model selector + price + action */}
                    {(() => {
                      const dims = postDims[post.id];
                      const models = dims
                        ? getModelOptions(dims.w, dims.h, post.isPaid)
                        : [];
                      const selectedModelId = postModel[post.id] || null; // null = Auto (smart routing)
                      const selectedModel = selectedModelId
                        ? models.find((m) => m.id === selectedModelId)
                        : null;
                      return (
                        <div className="space-y-2">
                          {dims && models.length > 0 && (
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <button
                                onClick={() =>
                                  setPostModel((prev) => {
                                    const updated = { ...prev };
                                    delete updated[post.id];
                                    return updated;
                                  })
                                }
                                className={`text-[10px] px-2 py-1 rounded-md border transition-colors ${
                                  !selectedModelId
                                    ? "bg-primary text-primary-foreground border-primary"
                                    : "bg-muted/50 text-muted-foreground border-border hover:bg-muted"
                                }`}
                              >
                                Auto
                              </button>
                              {models.map((m) => (
                                <button
                                  key={m.id}
                                  onClick={() =>
                                    setPostModel((prev) => ({
                                      ...prev,
                                      [post.id]: m.id,
                                    }))
                                  }
                                  className={`text-[10px] px-2 py-1 rounded-md border transition-colors ${
                                    selectedModelId === m.id
                                      ? "bg-primary text-primary-foreground border-primary"
                                      : "bg-muted/50 text-muted-foreground border-border hover:bg-muted"
                                  }`}
                                >
                                  {m.name}{" "}
                                  <span className="font-bold">{m.price}</span>
                                </button>
                              ))}
                            </div>
                          )}
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2 text-xs text-muted-foreground">
                              <span>👍 {post.score}</span>
                              <span>💬 {post.num_comments}</span>
                              {selectedModel ? (
                                <Badge
                                  variant="outline"
                                  className="text-[9px] px-1 py-0 font-mono"
                                >
                                  {selectedModel.price}
                                </Badge>
                              ) : (
                                <Badge
                                  variant="outline"
                                  className="text-[9px] px-1 py-0 font-mono text-blue-500 border-blue-300"
                                >
                                  Auto
                                </Badge>
                              )}
                            </div>
                            <div className="flex items-center gap-1.5">
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-8 w-8 p-0"
                                title="No AI Edit (Sharp only)"
                                onClick={() => {
                                  window.dispatchEvent(
                                    new CustomEvent("noAiEdit", {
                                      detail: { imageUrl: post.imageUrl },
                                    }),
                                  );
                                }}
                              >
                                <Sparkles className="h-3.5 w-3.5 text-amber-500" />
                              </Button>
                              <Button
                                onClick={() => analyzePost(post.id)}
                                disabled={analyzingPostId === post.id}
                                size="sm"
                                className="bg-blue-500 hover:bg-blue-600"
                              >
                                {analyzingPostId === post.id ? (
                                  <>
                                    <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                                    Analyzing...
                                  </>
                                ) : (
                                  <>
                                    <Wand2 className="mr-2 h-3 w-3" />
                                    Analyze & Edit
                                  </>
                                )}
                              </Button>
                            </div>
                          </div>
                        </div>
                      );
                    })()}
                  </CardContent>
                </Card>
              );
            })}
        </div>

        {posts.length === 0 && !loading && (
          <div className="text-center py-16">
            <ImageIcon className="mx-auto h-16 w-16 text-muted-foreground" />
            <h3 className="mt-4 text-xl font-semibold">No posts found</h3>
            <p className="text-muted-foreground mt-2">
              Check back later for new Photoshop requests from Reddit
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
