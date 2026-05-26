"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  RefreshCw,
  MessageCircle,
  Flame,
  Loader2,
  ChevronUp,
  ChevronDown,
} from "lucide-react";
import { authedFetch } from "@/lib/api";

interface MyComment {
  id: string;
  body: string;
  score: number;
  createdUtc: number;
  subreddit: string;
  postAuthor?: string;
  postId: string;
  postTitle: string;
  postText?: string;
  postImageUrl?: string;
  postThumbnailUrl?: string;
  postCommentCount?: number;
  replyCount: number;
  solvedReplyCount?: number;
  topReplyAuthor?: string;
  topReplyBody?: string;
  commentTree?: CommentNode[];
}

interface CommentNode {
  id: string;
  author: string;
  body: string;
  score: number;
  createdUtc: number;
  depth: number;
  isMine: boolean;
  children: CommentNode[];
}

type SortMode = "newest" | "engaged";
const REDDIT_USERNAME = "deandean91";
const COMMENTS_CACHE_KEY = `fixtral:my-comments:${REDDIT_USERNAME}`;

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
  if (typeof window === "undefined") return REDDIT_USERNAME;
  const stored = localStorage.getItem("reddit_username");
  if (stored !== REDDIT_USERNAME) {
    localStorage.setItem("reddit_username", REDDIT_USERNAME);
  }
  return REDDIT_USERNAME;
}

function proxiedImageUrl(url?: string): string {
  if (!url) return "";
  try {
    const host = new URL(url).hostname;
    if (
      ["i.redd.it", "preview.redd.it", "external-preview.redd.it", "i.imgur.com"].includes(
        host,
      )
    ) {
      return `/api/image-proxy?url=${encodeURIComponent(url)}`;
    }
  } catch {}
  return url;
}

function countTreeComments(nodes?: CommentNode[]): number {
  if (!nodes?.length) return 0;
  let total = 0;
  for (const node of nodes) {
    total += 1 + countTreeComments(node.children);
  }
  return total;
}

function CommentThread({
  nodes,
  compact = false,
}: {
  nodes: CommentNode[];
  compact?: boolean;
}) {
  return (
    <div className={compact ? "space-y-2" : "space-y-2.5"}>
      {nodes.map((node) => (
        <div key={node.id} className="relative">
          <div
            className={`rounded-md border px-2.5 py-2 ${
              node.isMine
                ? "border-orange-500/70 bg-orange-500/10"
                : "border-border bg-background"
            }`}
          >
            <div className="mb-1 flex flex-wrap items-center gap-x-1.5 text-[11px] text-muted-foreground">
              <span
                className={`font-semibold ${
                  node.isMine ? "text-orange-600 dark:text-orange-400" : "text-foreground"
                }`}
              >
                u/{node.author}
              </span>
              {node.isMine && (
                <span className="rounded-full bg-orange-500/15 px-1.5 py-0.5 text-[10px] font-bold uppercase text-orange-600 dark:text-orange-400">
                  you
                </span>
              )}
              <span>{timeAgo(node.createdUtc)}</span>
              <span>{node.score} points</span>
            </div>
            <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/90">
              {node.body || "[removed]"}
            </p>
          </div>

          {node.children.length > 0 && (
            <div className="ml-3 mt-2 border-l pl-2 sm:ml-5 sm:pl-3">
              <CommentThread nodes={node.children} compact />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function MyCommentsView() {
  const [username, setUsername] = useState<string>("");
  const [comments, setComments] = useState<MyComment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rateLimited, setRateLimited] = useState(false);
  const [rssBlocked, setRssBlocked] = useState(false);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const [enriched, setEnriched] = useState(true);
  const [expandedThreads, setExpandedThreads] = useState<Set<string>>(
    () => new Set(),
  );

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
      setRssBlocked(false);
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

        if (data.rssBlocked) {
          setRssBlocked(true);
          const cachedRaw = localStorage.getItem(COMMENTS_CACHE_KEY);
          if (cachedRaw) {
            try {
              const cached = JSON.parse(cachedRaw);
              setComments(Array.isArray(cached.comments) ? cached.comments : []);
              setEnriched(!!cached.enriched);
              setLastFetched(
                cached.fetchedAt ? new Date(cached.fetchedAt) : new Date(),
              );
              setError("Reddit RSS is temporarily blocked. Showing cached comments.");
            } catch {
              setComments([]);
              setError("Reddit RSS is temporarily blocked. No cached comments are available.");
            }
          } else {
            setComments([]);
            setError("Reddit RSS is temporarily blocked. Try refresh again in a moment.");
          }
          return;
        }

        const nextComments = data.comments || [];
        setComments(nextComments);
        setExpandedThreads(new Set());
        setEnriched(!!data.enriched);
        const fetchedAt = new Date();
        setLastFetched(fetchedAt);
        if (nextComments.length > 0) {
          localStorage.setItem(
            COMMENTS_CACHE_KEY,
            JSON.stringify({
              comments: nextComments,
              enriched: !!data.enriched,
              fetchedAt: fetchedAt.toISOString(),
            }),
          );
        }
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
    let solved = 0;
    let totalScore = 0;
    for (const c of comments) {
      if (c.score > 1) upvoted += 1;
      if (c.replyCount > 0) withReplies += 1;
      solved += c.solvedReplyCount || 0;
      totalScore += c.score;
    }
    return { upvoted, withReplies, solved, totalScore };
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
              u/{username} · r/PhotoshopRequest · {comments.length} comments
              {lastFetched && (
                <>
                  {" "}
                  · refreshed {lastFetched.toLocaleTimeString()}
                  {rssBlocked && " · cached"}
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
        <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
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
          <div className="rounded-md border border-green-500/40 bg-green-500/10 p-2">
            <div className="text-green-700 dark:text-green-300">Solved</div>
            <div className="text-base font-semibold text-green-700 dark:text-green-300">
              {stats.solved}
            </div>
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

      {!loading && hasUsername && comments.length === 0 && !error && !rssBlocked && (
        <div className="rounded-md border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
          No comments found for u/{username}.
        </div>
      )}

      {!loading && hasUsername && comments.length === 0 && rssBlocked && (
        <div className="rounded-md border bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
          Reddit RSS is temporarily blocked. Refresh again in a moment.
        </div>
      )}

      <div className="space-y-2">
        {sorted.map((c) => {
          const hasEngagement = c.score > 1 || c.replyCount > 0;
          const imageUrl = c.postImageUrl || c.postThumbnailUrl;
          const threadCount = countTreeComments(c.commentTree);
          const isThreadExpanded = expandedThreads.has(c.id);
          return (
            <article
              key={c.id}
              className={`overflow-hidden rounded-md border transition-colors ${
                hasEngagement
                  ? "border-orange-400/70 bg-card"
                  : "bg-card hover:border-foreground/30"
              }`}
            >
              <div className="flex">
                <div className="flex w-10 shrink-0 flex-col items-center gap-0.5 bg-muted/60 py-2 text-muted-foreground">
                  <ChevronUp className="h-5 w-5" />
                  <span
                    className={`text-xs font-bold ${
                      c.score > 1 ? "text-orange-600 dark:text-orange-400" : ""
                    }`}
                  >
                    {c.score}
                  </span>
                  <ChevronDown className="h-5 w-5" />
                </div>

                <div className="min-w-0 flex-1 px-3 py-2">
                  <div className="mb-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] text-muted-foreground">
                    <span className="font-semibold text-foreground">
                      r/{c.subreddit || "reddit"}
                    </span>
                    <span>Posted by</span>
                    <span>u/{c.postAuthor || "unknown"}</span>
                    <span>{timeAgo(c.createdUtc)}</span>
                    {hasEngagement && (
                      <span className="ml-1 inline-flex items-center gap-0.5 rounded-full bg-orange-500/15 px-1.5 py-0.5 text-[11px] font-semibold text-orange-600 dark:text-orange-400">
                        <Flame className="h-3 w-3" />
                        hot
                      </span>
                    )}
                  </div>

                  <div className="text-base font-semibold leading-snug text-foreground">
                    {c.postTitle || "Reddit post"}
                  </div>

                  {c.postText && (
                    <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-sm leading-relaxed text-foreground/80">
                      {c.postText}
                    </p>
                  )}

                  {imageUrl && (
                    <div className="mt-2 overflow-hidden rounded-md border bg-black/5">
                      <img
                        src={proxiedImageUrl(imageUrl)}
                        alt={c.postTitle || "Reddit post image"}
                        className="max-h-[520px] w-full object-contain"
                        loading="lazy"
                      />
                    </div>
                  )}

                  <div className="mt-3 rounded-md border bg-muted/35 px-3 py-2">
                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      Your comment
                    </div>
                    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground/90">
                      {c.body}
                    </p>
                  </div>

                  {c.topReplyAuthor && c.topReplyBody && (
                    <div className="mt-2 rounded-md border-l-2 border-blue-500/60 bg-blue-500/5 px-2 py-1.5">
                      <div className="mb-0.5 text-[11px] font-medium text-blue-600 dark:text-blue-400">
                        u/{c.topReplyAuthor} replied
                      </div>
                      <div className="whitespace-pre-wrap break-words text-xs text-foreground/80">
                        {c.topReplyBody}
                      </div>
                    </div>
                  )}

                  <div className="mt-2 flex flex-wrap items-center gap-4 text-xs font-semibold text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <MessageCircle className="h-3.5 w-3.5" />
                      {c.postCommentCount ?? c.replyCount} comments
                    </span>
                    {threadCount > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          setExpandedThreads((prev) => {
                            const next = new Set(prev);
                            if (next.has(c.id)) next.delete(c.id);
                            else next.add(c.id);
                            return next;
                          });
                        }}
                        className="inline-flex min-h-[32px] items-center gap-1 rounded-md px-2 text-foreground hover:bg-muted"
                      >
                        <MessageCircle className="h-3.5 w-3.5" />
                        {isThreadExpanded
                          ? "Hide comments"
                          : `Show ${threadCount} comments`}
                      </button>
                    )}
                    {c.replyCount > 0 && (
                      <span className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400">
                        <MessageCircle className="h-3.5 w-3.5" />
                        {c.replyCount} replies to you
                      </span>
                    )}
                    {!!c.solvedReplyCount && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-green-500/15 px-2 py-1 text-green-700 dark:text-green-300">
                        SOLVED x{c.solvedReplyCount}
                      </span>
                    )}
                  </div>

                  {isThreadExpanded && c.commentTree && (
                    <div className="mt-3 rounded-md border bg-muted/20 p-2 sm:p-3">
                      <div className="mb-2 text-xs font-semibold text-muted-foreground">
                        All fetched comments
                      </div>
                      <CommentThread nodes={c.commentTree} />
                    </div>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}
