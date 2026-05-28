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
    const directImage = hrefs.find((href) =>
      /(?:i|preview)\.redd\.it|i\.imgur\.com/i.test(href),
    );
    const url = directImage || thumbnail;

    if (!id || !title || !permalink || !url) continue;

    children.push({
      kind: "t3",
      data: {
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
        preview: {
          images: [
            {
              source: {
                url,
              },
            },
          ],
        },
      },
    });
  }

  return children;
}

function parseSubredditsFromJsonUrl(target: URL) {
  const match = /^\/r\/([^/]+)\/new(?:\.json)?\/?$/.exec(target.pathname);
  if (!match) return [];
  return match[1].split("+").filter(Boolean);
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
      const res = await fetch(rssUrl, { headers: RSS_HEADERS });
      if (!res.ok) {
        const fallbackUrl = `https://www.reddit.com/r/${sub}/new/.rss?limit=${encodeURIComponent(limit)}`;
        const fallback = await fetch(fallbackUrl, { headers: RSS_HEADERS });
        if (!fallback.ok) return [];
        return parseSubredditRss(await fallback.text(), sub);
      }
      return parseSubredditRss(await res.text(), sub);
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
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  if (target.pathname.includes("/new.json")) {
    const fallback = await fetchRssAsListing(target);
    if (fallback) return json(fallback);
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
