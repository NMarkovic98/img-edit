export interface Env {
  PROXY_SECRET?: string;
}

const REDDIT_HOSTS = new Set([
  "www.reddit.com",
  "old.reddit.com",
  "oauth.reddit.com",
]);

const JSON_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  Accept: "application/json,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

const RSS_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  Accept: "application/atom+xml,application/xml,text/xml,*/*",
  "Accept-Language": "en-US,en;q=0.9",
};

const HTML_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  Cookie: "over18=1; _options=%7B%22pref_quarantine_optin%22%3A%20true%7D",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

function decodeEntities(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#032;|&#32;/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'");
}

function stripHtml(rawContent: string) {
  let html = decodeEntities(rawContent)
    .replace(/<!--\s*SC_OFF\s*-->/gi, "")
    .replace(/<!--\s*SC_ON\s*-->/gi, "");
  const submittedIdx = html.search(/submitted\s+by/i);
  if (submittedIdx > 0) html = html.slice(0, submittedIdx);
  html = html.replace(/<\/p>/gi, "\n").replace(/<br\s*\/?>/gi, "\n");
  html = html.replace(/<[^>]+>/g, "");
  return decodeEntities(html).replace(/\n{3,}/g, "\n\n").trim();
}

function tag(block: string, name: string) {
  const match = new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, "i").exec(
    block,
  );
  return decodeEntities(match?.[1]?.trim() || "");
}

function attr(block: string, tagName: string, attrName: string) {
  const match = new RegExp(
    `<${tagName}[^>]*${attrName}="([^"]+)"[^>]*>`,
    "i",
  ).exec(block);
  return decodeEntities(match?.[1] || "");
}

function parseSubredditRss(xml: string, fallbackSubreddit: string) {
  const children: any[] = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let match: RegExpExecArray | null;

  while ((match = entryRe.exec(xml)) !== null) {
    const block = match[1];
    const id = tag(block, "id").replace(/^t3_/, "");
    const title = tag(block, "title");
    const authorBlock = /<author[^>]*>([\s\S]*?)<\/author>/i.exec(block)?.[1] || "";
    const author = tag(authorBlock, "name").replace(/^\/?u\//i, "") || "unknown";
    const subreddit = attr(block, "category", "term") || fallbackSubreddit;
    const permalink = attr(block, "link", "href");
    const rawContent = tag(block, "content");
    const contentHtml = decodeEntities(rawContent);
    const published = tag(block, "published") || tag(block, "updated");
    const thumbnail = attr(block, "media:thumbnail", "url");
    const hrefs = Array.from(contentHtml.matchAll(/href="([^"]+)"/gi)).map((x) =>
      decodeEntities(x[1]),
    );
    const imageHrefs = hrefs.filter((href) =>
      /(?:i|preview)\.redd\.it|i\.imgur\.com/i.test(href),
    );
    // Normalize preview.redd.it → i.redd.it (originals, not recompressed)
    const normalized = imageHrefs.map((href) => {
      const m = href.match(
        /preview\.redd\.it\/([a-zA-Z0-9]+)\.(jpg|jpeg|png|gif|webp)/,
      );
      return m ? `https://i.redd.it/${m[1]}.${m[2]}` : href;
    });
    const dedupedImages = Array.from(new Set(normalized));
    const url = dedupedImages[0] || thumbnail || "";

    if (!id || !title || !permalink) continue;

    const data: any = {
      id,
      title,
      selftext: stripHtml(rawContent) || title,
      url,
      author,
      created_utc: published
        ? Math.floor(new Date(published).getTime() / 1000)
        : Math.floor(Date.now() / 1000),
      permalink: new URL(permalink).pathname,
      score: 0,
      num_comments: 0,
      subreddit,
      thumbnail,
      upvote_ratio: null,
      link_flair_text: null,
    };

    if (url) {
      data.preview = {
        images: [
          {
            source: {
              url,
            },
          },
        ],
      };
    }

    // Build media_metadata when RSS reveals multiple images so the slider triggers
    if (dedupedImages.length > 1) {
      const media_metadata: Record<string, any> = {};
      const items: any[] = [];
      for (const imgUrl of dedupedImages) {
        const m = imgUrl.match(
          /(?:i|preview)\.redd\.it\/([a-zA-Z0-9]+)\.(jpg|jpeg|png|gif|webp)/i,
        );
        if (!m) continue;
        const mediaId = m[1];
        const ext = m[2].toLowerCase();
        const mime = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : "image/jpg";
        media_metadata[mediaId] = {
          status: "valid",
          e: "Image",
          m: mime,
          s: { u: `https://i.redd.it/${mediaId}.${ext}`, x: 0, y: 0 },
        };
        items.push({ media_id: mediaId, id: items.length + 1 });
      }
      if (Object.keys(media_metadata).length > 1) {
        data.media_metadata = media_metadata;
        data.gallery_data = { items };
        data.is_gallery = true;
      }
    }

    children.push({ kind: "t3", data });
  }

  return children;
}

function parseSubredditsFromJsonUrl(target: URL) {
  const match = /^\/r\/([^/]+)\/new(?:\.json)?\/?$/.exec(target.pathname);
  if (!match) return [];
  return match[1].split("+").filter(Boolean);
}

function parseSubredditFromAboutUrl(target: URL) {
  const match = /^\/r\/([^/+]+)\/about(?:\.json)?\/?$/.exec(target.pathname);
  return match ? match[1] : null;
}

async function fetchSubredditAbout(sub: string) {
  try {
    const res = await fetch(`https://old.reddit.com/r/${sub}/`, {
      headers: HTML_HEADERS,
    });
    if (!res.ok) return null;
    const html = await res.text();

    const iconMatch =
      /id=['"]header-img['"][^>]+src=["']([^"']+)["']/i.exec(html);
    let icon = iconMatch ? decodeEntities(iconMatch[1]) : null;
    if (icon && icon.startsWith("//")) icon = `https:${icon}`;
    if (icon && /reddit\.com\.header\.png/i.test(icon)) icon = null;

    const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(html);
    const title = titleMatch ? decodeEntities(titleMatch[1].trim()) : sub;

    const descMatch =
      /<meta\s+name="description"\s+content="([^"]*)"/i.exec(html);
    const description = descMatch ? decodeEntities(descMatch[1]) : "";

    return {
      kind: "t5",
      data: {
        display_name: sub,
        title,
        public_description: description,
        community_icon: icon || "",
        icon_img: icon || "",
        header_img: null,
        url: `/r/${sub}/`,
      },
    };
  } catch {
    return null;
  }
}

interface GalleryItem {
  media_id: string;
  ext: string; // "jpg" | "png" | "gif" | ...
  width: number | null;
  height: number | null;
}

interface HtmlPostEnrichment {
  score: number;
  num_comments: number;
  link_flair_text: string | null;
  is_gallery: boolean;
  over_18: boolean;
  url: string | null;
  thumbnail: string | null;
  author: string | null;
  gallery: GalleryItem[] | null;
}

function parseThingAttr(block: string, name: string): string | null {
  const m = new RegExp(`\\sdata-${name}="([^"]*)"`, "i").exec(block);
  return m ? m[1] : null;
}

function parseGalleryFromCachedHtml(block: string): GalleryItem[] | null {
  // data-cachedhtml="..." contains HTML-escaped gallery markup
  const cachedMatch = /data-cachedhtml="((?:[^"\\]|\\.)*)"/i.exec(block);
  if (!cachedMatch) return null;
  const escaped = cachedMatch[1];
  if (!/gallery-tiles/i.test(escaped)) return null;

  const unescaped = escaped
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");

  const idsMatch = /data-media-ids="([^"]+)"/i.exec(unescaped);
  if (!idsMatch) return null;
  const mediaIds = idsMatch[1].split(",").map((s) => s.trim()).filter(Boolean);

  const items: GalleryItem[] = [];
  for (const mediaId of mediaIds) {
    // Full-res link: <a ... gallery-item-thumbnail-link ... href="https://preview.redd.it/{id}.{ext}?width=W&...">
    const linkRe = new RegExp(
      `gallery-item-thumbnail-link[^>]+href="https?:\\/\\/[^"]*?\\/${mediaId}\\.([a-z]+)\\?([^"]+)"`,
      "i",
    );
    const linkMatch = linkRe.exec(unescaped);

    let ext = "jpg";
    let width: number | null = null;
    let height: number | null = null;

    if (linkMatch) {
      ext = linkMatch[1].toLowerCase();
      const params = linkMatch[2];
      const wm = /width=(\d+)/.exec(params);
      if (wm) width = parseInt(wm[1], 10);
    }

    // Displayed preview <img> shows aspect ratio: width="W2" height="H2"
    const imgRe = new RegExp(
      `<img[^>]+src="https?:\\/\\/[^"]*?\\/${mediaId}\\.[a-z]+[^"]*"[^>]+width="(\\d+)"[^>]+height="(\\d+)"`,
      "i",
    );
    const imgMatch = imgRe.exec(unescaped);
    if (imgMatch && width !== null) {
      const w2 = parseInt(imgMatch[1], 10);
      const h2 = parseInt(imgMatch[2], 10);
      if (w2 > 0) height = Math.round((h2 * width) / w2);
    }

    items.push({ media_id: mediaId, ext, width, height });
  }

  return items.length > 0 ? items : null;
}

function parseSubredditHtml(html: string): Map<string, HtmlPostEnrichment> {
  const enrichments = new Map<string, HtmlPostEnrichment>();
  // Each post is rendered as <div ... id="thing_t3_xxx" ...>...</div>
  // We capture the opening div + a chunk after it for flair detection.
  const thingRe = /<div[^>]+id="thing_t3_([a-z0-9]+)"[^>]*>([\s\S]{0,20000}?)(?=<div[^>]+id="thing_t3_|<!-- END LISTING -->|<\/div>\s*<div[^>]+class="footer)/gi;
  let match: RegExpExecArray | null;

  while ((match = thingRe.exec(html)) !== null) {
    const id = match[1];
    const opening = match[0].slice(0, 1500);
    const body = match[2];

    const score = parseInt(parseThingAttr(opening, "score") || "0", 10);
    const num_comments = parseInt(
      parseThingAttr(opening, "comments-count") || "0",
      10,
    );
    const author = parseThingAttr(opening, "author");
    const url = parseThingAttr(opening, "url");
    const is_gallery = parseThingAttr(opening, "is-gallery") === "true";
    const over_18 = parseThingAttr(opening, "nsfw") === "true";

    // Flair: <span class="linkflairlabel ..." title="X">
    const flairMatch =
      /<span[^>]+class="[^"]*linkflairlabel[^"]*"[^>]*title="([^"]*)"/i.exec(
        body,
      );
    const link_flair_text = flairMatch
      ? decodeEntities(flairMatch[1])
      : null;

    // Thumbnail: <a class="thumbnail ..."><img src="//...">
    const thumbMatch =
      /<a[^>]+class="[^"]*thumbnail[^"]*"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"/i.exec(
        body,
      );
    let thumbnail = thumbMatch ? thumbMatch[1] : null;
    if (thumbnail && thumbnail.startsWith("//"))
      thumbnail = `https:${thumbnail}`;

    const gallery = is_gallery ? parseGalleryFromCachedHtml(body) : null;

    enrichments.set(id, {
      score,
      num_comments,
      link_flair_text,
      is_gallery,
      over_18,
      url: url || null,
      thumbnail,
      author,
      gallery,
    });
  }

  return enrichments;
}

async function fetchSubredditHtml(
  sub: string,
  limit: string,
): Promise<Map<string, HtmlPostEnrichment>> {
  try {
    const htmlUrl = `https://old.reddit.com/r/${sub}/new/?limit=${encodeURIComponent(limit)}`;
    const res = await fetch(htmlUrl, { headers: HTML_HEADERS });
    if (!res.ok) return new Map();
    return parseSubredditHtml(await res.text());
  } catch {
    return new Map();
  }
}

async function fetchRssAsListing(target: URL) {
  const subs = parseSubredditsFromJsonUrl(target);
  if (subs.length === 0) return null;

  const limit = target.searchParams.get("limit") || "50";
  const results = await Promise.all(
    subs.map(async (sub) => {
      const rssUrl = `https://old.reddit.com/r/${sub}/new/.rss?limit=${encodeURIComponent(
        limit,
      )}`;
      // Fetch RSS (for images/selftext) and HTML (for score/comments/flair) in parallel
      const [rssText, htmlEnrichments] = await Promise.all([
        fetch(rssUrl, { headers: RSS_HEADERS }).then(async (res) => {
          if (res.ok) return res.text();
          const fb = await fetch(
            `https://www.reddit.com/r/${sub}/new/.rss?limit=${encodeURIComponent(limit)}`,
            { headers: RSS_HEADERS },
          );
          return fb.ok ? fb.text() : "";
        }),
        fetchSubredditHtml(sub, limit),
      ]);

      if (!rssText) return [];
      const children = parseSubredditRss(rssText, sub);

      // Merge HTML data into RSS children by post ID
      for (const child of children) {
        const e = htmlEnrichments.get(child.data.id);
        if (!e) continue;
        child.data.score = e.score;
        child.data.num_comments = e.num_comments;
        child.data.link_flair_text = e.link_flair_text;
        if (e.over_18) child.data.over_18 = true;
        if (e.is_gallery) child.data.is_gallery = true;
        if (e.thumbnail) child.data.thumbnail = e.thumbnail;
        if (e.author && child.data.author === "unknown")
          child.data.author = e.author;

        if (e.is_gallery && e.gallery && e.gallery.length > 0) {
          const media_metadata: Record<string, any> = {};
          for (const item of e.gallery) {
            const ext =
              item.ext === "png" ? "png" : item.ext === "gif" ? "gif" : "jpg";
            const mime = ext === "png"
              ? "image/png"
              : ext === "gif"
                ? "image/gif"
                : "image/jpg";
            media_metadata[item.media_id] = {
              status: "valid",
              e: "Image",
              m: mime,
              s: {
                u: `https://i.redd.it/${item.media_id}.${ext}`,
                x: item.width || 0,
                y: item.height || 0,
              },
            };
          }
          child.data.media_metadata = media_metadata;
          child.data.gallery_data = {
            items: e.gallery.map((item, idx) => ({
              media_id: item.media_id,
              id: idx + 1,
            })),
          };

          const first = e.gallery[0];
          const firstExt =
            first.ext === "png" ? "png" : first.ext === "gif" ? "gif" : "jpg";
          const firstUrl = `https://i.redd.it/${first.media_id}.${firstExt}`;
          child.data.url = firstUrl;
          child.data.preview = {
            images: [
              {
                source: {
                  url: firstUrl,
                  width: first.width || 0,
                  height: first.height || 0,
                },
              },
            ],
          };
        }
      }
      return children;
    }),
  );

  return {
    kind: "Listing",
    data: {
      after: null,
      before: null,
      children: results
        .flat()
        .sort((a, b) => b.data.created_utc - a.data.created_utc),
    },
  };
}

async function proxyReddit(target: URL) {
  const upstream = await fetch(target.toString(), {
    headers: JSON_HEADERS,
    redirect: "follow",
  });

  const contentType = upstream.headers.get("content-type") || "";
  if (upstream.ok && contentType.includes("application/json")) {
    // Reddit sometimes returns 200 + a valid-looking Listing with empty children
    // when silently blocking the IP. Peek at the body and fall back to RSS in
    // that case, instead of passing the empty Listing through.
    if (target.pathname.includes("/new.json")) {
      const body = await upstream.text();
      try {
        const parsed = JSON.parse(body);
        const children = parsed?.data?.children;
        if (Array.isArray(children) && children.length > 0) {
          return new Response(body, {
            status: upstream.status,
            headers: {
              "Content-Type": "application/json",
              "Access-Control-Allow-Origin": "*",
            },
          });
        }
        // empty — fall through to RSS
      } catch {
        // not JSON — fall through to RSS
      }
    } else {
      return new Response(upstream.body, {
        status: upstream.status,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }
  }

  if (target.pathname.includes("/new.json")) {
    const fallback = await fetchRssAsListing(target);
    if (fallback) return json(fallback);
  }

  const aboutSub = parseSubredditFromAboutUrl(target);
  if (aboutSub) {
    const about = await fetchSubredditAbout(aboutSub);
    if (about) return json(about);
  }

  const body = await upstream.text();
  return new Response(body, {
    status: upstream.status,
    headers: {
      "Content-Type": contentType || "text/plain",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "X-Proxy-Secret, Content-Type",
        },
      });
    }

    const url = new URL(request.url);
    const targetRaw = url.searchParams.get("url");
    if (!targetRaw) return json({ error: "Missing url parameter" }, 400);

    if (env.PROXY_SECRET) {
      const provided = request.headers.get("X-Proxy-Secret") || "";
      if (provided !== env.PROXY_SECRET) {
        return json({ error: "Unauthorized" }, 401);
      }
    }

    let target: URL;
    try {
      target = new URL(targetRaw);
    } catch {
      return json({ error: "Invalid url parameter" }, 400);
    }

    if (!REDDIT_HOSTS.has(target.hostname)) {
      return json({ error: `Host not allowed: ${target.hostname}` }, 403);
    }

    return proxyReddit(target);
  },
};
