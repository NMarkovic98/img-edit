# Reddit Proxy Reference

This Worker exists because Reddit can block unauthenticated public JSON requests
from server/proxy infrastructure with `403` HTML responses. The Next.js app
still expects Reddit's listing JSON shape, so this proxy keeps the app working
when `https://www.reddit.com/r/{sub}/new.json` stops returning JSON.

## Current Worker

- Name: `reddit-proxy`
- URL: `https://reddit-proxy.pomocnih.workers.dev`
- Config: `cloudflare/reddit-proxy/wrangler.toml`
- Source: `cloudflare/reddit-proxy/src/index.ts`
- Secret header: `X-Proxy-Secret`
- Secret binding name: `PROXY_SECRET`

The deployed Worker was recreated in this repo because the old Worker source was
not present locally. The current version keeps the same external contract used
by the app: pass a Reddit URL in the `url` query parameter and get a proxied
response back.

## What Broke

The app used to fetch subreddit posts through the proxy using public Reddit JSON
URLs like:

```text
https://www.reddit.com/r/PhotoshopRequest/new.json?limit=50&raw_json=1
```

Reddit started returning `403` with an HTML page instead of JSON. In local logs
this looked like:

```text
Reddit public API error for r/PhotoshopRequest: 403 <body class=theme-beta>...
```

That is not a normal app parsing bug. The response body was not JSON at all, so
the queue ended up empty or the app fell back to weaker paths.

## What Was Changed

The Worker now does this:

1. Receives `?url=...` from the Next.js API route.
2. Verifies the optional `X-Proxy-Secret` header against `PROXY_SECRET`.
3. Allows only Reddit hosts:
   - `www.reddit.com`
   - `old.reddit.com`
   - `oauth.reddit.com`
4. Tries to fetch the original target URL with browser-like headers.
5. If Reddit returns real JSON, passes that JSON through unchanged.
6. If Reddit blocks `/r/{sub}/new.json` or returns HTML, fetches RSS instead:

```text
https://www.reddit.com/r/{sub}/new/.rss?limit=50
```

7. Parses the RSS feed and converts it back into a Reddit listing-like JSON
   response:

```json
{
  "kind": "Listing",
  "data": {
    "after": null,
    "before": null,
    "children": [
      {
        "kind": "t3",
        "data": {
          "id": "post_id",
          "title": "Post title",
          "selftext": "Post text",
          "url": "image_url",
          "author": "username",
          "created_utc": 1779990000,
          "permalink": "/r/PhotoshopRequest/comments/...",
          "score": 0,
          "num_comments": 0,
          "subreddit": "PhotoshopRequest",
          "thumbnail": "thumbnail_url",
          "upvote_ratio": null,
          "link_flair_text": null,
          "preview": {
            "images": [
              {
                "source": {
                  "url": "image_url"
                }
              }
            ]
          }
        }
      }
    ]
  }
}
```

This lets the existing app keep reading `data.children[*].data` without a large
rewrite.

## Important Limitations

The RSS fallback does not include the same engagement data as Reddit JSON.

When fallback is active, these fields are placeholders:

- `score: 0`
- `num_comments: 0`
- `upvote_ratio: null`
- `link_flair_text: null`

That means the queue can load posts and images, but ranking/comment counts/flair
may be missing unless a different enrichment path works.

The current fallback only handles subreddit new-listing URLs:

```text
/r/{sub}/new.json
/r/{sub1+sub2}/new.json
```

It does not currently implement fallback parsing for comment detail endpoints
like:

```text
/comments/{postId}.json
```

If My Comments loses score/reply enrichment again, extend this Worker or move
that endpoint to an authenticated Reddit API flow.

## Deploy

From repo root:

```bash
cd cloudflare/reddit-proxy
wrangler deploy
```

If `wrangler` asks for auth, log in with the Cloudflare account that owns the
Worker.

## Test

Use the existing secret value from `.env.local` or Cloudflare dashboard.

```bash
curl -sS \
  -H 'X-Proxy-Secret: l1unu70x' \
  'https://reddit-proxy.pomocnih.workers.dev?url=https%3A%2F%2Fwww.reddit.com%2Fr%2FPhotoshopRequest%2Fnew.json%3Flimit%3D3%26raw_json%3D1'
```

Expected result:

- Response starts with `{"kind":"Listing"...`
- `data.children` is not empty.
- If Reddit JSON is blocked, the response still stays JSON because it came from
  RSS fallback.

Also test the app endpoint:

```bash
curl -sS 'http://localhost:3000/api/reddit/posts'
```

Expected result:

- `ok: true`
- `posts` is not empty.

If testing production, replace localhost with the Vercel URL.

## Next Time This Breaks

Use this checklist:

1. Test direct Reddit JSON:

```bash
curl -i 'https://www.reddit.com/r/PhotoshopRequest/new.json?limit=3&raw_json=1'
```

If it returns `403` or HTML, Reddit is blocking the public JSON path.

2. Test the Worker:

```bash
curl -sS \
  -H 'X-Proxy-Secret: l1unu70x' \
  'https://reddit-proxy.pomocnih.workers.dev?url=https%3A%2F%2Fwww.reddit.com%2Fr%2FPhotoshopRequest%2Fnew.json%3Flimit%3D3%26raw_json%3D1'
```

If this returns a valid listing with posts, the Worker is fine and the problem is
probably the Next.js deployment, environment variables, cache, or local server.

3. Check Next.js env:

```text
CLOUDFLARE_PROXY_URL=https://reddit-proxy.pomocnih.workers.dev
CLOUDFLARE_PROXY_SECRET=<same value as Worker PROXY_SECRET>
```

4. If the Worker returns empty JSON, inspect `src/index.ts` RSS parsing. Reddit
   may have changed the feed structure, image links, or tags.

5. Patch the Worker and redeploy:

```bash
cd cloudflare/reddit-proxy
wrangler deploy
```

6. If RSS is also blocked or removed, the durable fix is OAuth with a Reddit app.
   That would require `client_id`, `client_secret`, and a refresh token. Avoid
   doing that unless the proxy/RSS path no longer works.

## Why Redeploying Can Help

If Reddit only blocks the JSON endpoint, this Worker should now recover
automatically by using RSS. In that case, no code change is needed.

If Reddit changes the RSS shape, image URLs, or blocks the Worker differently,
then the fix is:

1. Edit `cloudflare/reddit-proxy/src/index.ts`.
2. Deploy `reddit-proxy` with `wrangler deploy`.
3. Confirm the proxy returns listing JSON.
4. Restart/redeploy the Next.js app only if its env or server process changed.

