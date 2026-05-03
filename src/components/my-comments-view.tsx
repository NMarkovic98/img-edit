"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  RefreshCw,
  ArrowUpCircle,
  MessageCircle,
  ExternalLink,
  Flame,
  Loader2,
} from "lucide-react";
import { authedFetch } from "@/lib/api";

interface MyComment {
  id: string;
  body: string;
  score: number;
  createdUtc: number;
  subreddit: string;
  postId: string;
  postTitle: string;
  postPermalink: string;
  permalink: string;
  replyCount: number;
  topReplyAuthor?: string;
  topReplyBody?: string;
}

type SortMode = "newest" | "engaged";

function timeAgo(utcSeconds: number): string {
  if (!utcSeconds) return "";
  const diff = Date.now() / 1000 - utcSeconds;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(utcSeconds * 1000).toLocaleDateString();
}

function getStoredUsername(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem("reddit_username") || "";
}

export function MyCommentsView() {
  const [username, setUsername] = useState<string>("");
  const [comments, setComments] = useState<MyComment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rateLimited, setRateLimited] = useState(false);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const [enriched, setEnriched] = useState(true);

  useEffect(() => {
    setUsername(getStoredUsername());
  }, []);

  const fetchComments = useCallback(
    async (uname: string, withEnrich: boolean) => {
      if (!uname) {
        setError("No Reddit username configured. Set it in Settings.");
        return;
      }
      setLoading(true);
      setError(null);
      setRateLimited(false);
      try {
        const params = new URLSearchParams({ username: uname });
        if (!withEnrich) params.set("enrich", "false");
        const res = await authedFetch(
          `/api/reddit/my-comments?${params.toString()}`,
        );
        const data = await res.json();
        if (!res.ok || !data.ok) {
          if (data?.rateLimited || res.status === 429) {
            setRateLimited(true);
          }
          throw new Error(data?.error || `HTTP ${res.status}`);
        }
        setComments(data.comments || []);
        setEnriched(!!data.enriched);
        setLastFetched(new Date());
      } catch (err: any) {
        setError(err?.message || "Failed to fetch comments");
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (username) fetchComments(username, true);
  }, [username, fetchComments]);

  const sorted = useMemo(() => {
    const list = [...comments];
    if (sortMode === "engaged") {
      list.sort((a, b) => {
        const aScore = a.replyCount * 10 + Math.max(0, a.score - 1);
        const bScore = b.replyCount * 10 + Math.max(0, b.score - 1);
        if (bScore !== aScore) return bScore - aScore;
        return b.createdUtc - a.createdUtc;
      });
    } else {
      list.sort((a, b) => b.createdUtc - a.createdUtc);
    }
    return list;
  }, [comments, sortMode]);

  const stats = useMemo(() => {
    let upvoted = 0;
    let withReplies = 0;
    let totalScore = 0;
    for (const c of comments) {
      if (c.score > 1) upvoted += 1;
      if (c.replyCount > 0) withReplies += 1;
      totalScore += c.score;
    }
    return { upvoted, withReplies, totalScore };
  }, [comments]);

  const hasUsername = !!username;

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-lg sm:text-xl font-semibold flex items-center gap-2">
            <MessageCircle className="h-5 w-5" /> My Comments
          </h2>
          {hasUsername ? (
            <p className="text-xs text-muted-foreground mt-0.5">
              u/{username} · {comments.length} comments
              {lastFetched && (
                <>
                  {" "}
                  · refreshed {lastFetched.toLocaleTimeString()}
                  {!enriched && " · engagement not loaded"}
                </>
              )}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground mt-0.5">
              Set Reddit username in Settings to view your comments.
            </p>
          )}
        </div>

        <div className="flex items-center gap-2">
          <div className="flex rounded-md border bg-background overflow-hidden text-xs">
            <button
              onClick={() => setSortMode("newest")}
              className={`px-3 py-1.5 transition-colors ${
                sortMode === "newest"
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-muted"
              }`}
            >
              Newest
            </button>
            <button
              onClick={() => setSortMode("engaged")}
              className={`px-3 py-1.5 transition-colors ${
                sortMode === "engaged"
                  ? "bg-primary text-primary-foreground"
                  : "hover:bg-muted"
              }`}
            >
              Most engaged
            </button>
          </div>

          <button
            onClick={() => fetchComments(username, true)}
            disabled={loading || !hasUsername}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border bg-background text-xs font-medium hover:bg-muted disabled:opacity-50"
            title="Refresh"
          >
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            Refresh
          </button>
        </div>
      </div>

      {hasUsername && comments.length > 0 && (
        <div className="grid grid-cols-3 gap-2 text-xs">
          <div className="rounded-md border bg-card p-2">
            <div className="text-muted-foreground">Total karma here</div>
            <div className="text-base font-semibold">{stats.totalScore}</div>
          </div>
          <div className="rounded-md border bg-card p-2">
            <div className="text-muted-foreground">Upvoted (&gt;1)</div>
            <div className="text-base font-semibold">{stats.upvoted}</div>
          </div>
          <div className="rounded-md border bg-card p-2">
            <div className="text-muted-foreground">With replies</div>
            <div className="text-base font-semibold">{stats.withReplies}</div>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-md border border-red-500/40 bg-red-500/10 text-red-600 dark:text-red-400 px-3 py-2 text-sm">
          {rateLimited
            ? "Reddit is rate-limiting requests. Try again in a minute."
            : error}
        </div>
      )}

      {loading && comments.length === 0 && (
        <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
          <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading comments…
        </div>
      )}

      {!loading && hasUsername && comments.length === 0 && !error && (
        <div className="rounded-md border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
          No comments found for u/{username}.
        </div>
      )}

      <div className="space-y-2">
        {sorted.map((c) => {
          const hasEngagement = c.score > 1 || c.replyCount > 0;
          return (
            <div
              key={c.id}
              className={`rounded-lg border p-3 transition-colors ${
                hasEngagement
                  ? "border-amber-400/60 bg-amber-50/40 dark:bg-amber-500/5"
                  : "bg-card"
              }`}
            >
              <div className="flex items-start justify-between gap-2 mb-1">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
                    <span className="font-medium text-foreground">
                      r/{c.subreddit}
                    </span>
                    <span>·</span>
                    <span>{timeAgo(c.createdUtc)}</span>
                    {hasEngagement && (
                      <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-500/20 text-amber-700 dark:text-amber-300 px-1.5 py-0.5 font-semibold">
                        <Flame className="h-3 w-3" />
                        engagement
                      </span>
                    )}
                  </div>
                  {c.postTitle && (
                    <a
                      href={c.postPermalink}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block text-sm font-medium hover:underline truncate"
                    >
                      {c.postTitle}
                    </a>
                  )}
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  <span
                    className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold ${
                      c.score > 1
                        ? "bg-orange-500/15 text-orange-600 dark:text-orange-400"
                        : "bg-muted text-muted-foreground"
                    }`}
                    title="Score"
                  >
                    <ArrowUpCircle className="h-3 w-3" />
                    {c.score}
                  </span>
                  {c.replyCount > 0 && (
                    <span
                      className="inline-flex items-center gap-1 rounded-md bg-blue-500/15 text-blue-600 dark:text-blue-400 px-2 py-0.5 text-xs font-semibold"
                      title="Replies to your comment"
                    >
                      <MessageCircle className="h-3 w-3" />
                      {c.replyCount}
                    </span>
                  )}
                </div>
              </div>

              <p className="text-sm whitespace-pre-wrap break-words text-foreground/90">
                {c.body}
              </p>

              {c.topReplyAuthor && c.topReplyBody && (
                <div className="mt-2 rounded-md border-l-2 border-blue-500/60 bg-blue-500/5 px-2 py-1.5">
                  <div className="text-[11px] text-blue-600 dark:text-blue-400 font-medium mb-0.5">
                    u/{c.topReplyAuthor} replied
                  </div>
                  <div className="text-xs text-foreground/80 whitespace-pre-wrap break-words">
                    {c.topReplyBody}
                  </div>
                </div>
              )}

              <div className="mt-2 flex items-center gap-3 text-xs">
                <a
                  href={c.permalink}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
                >
                  <ExternalLink className="h-3 w-3" />
                  View on Reddit
                </a>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
