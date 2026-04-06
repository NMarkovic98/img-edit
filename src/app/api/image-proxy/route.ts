import { NextRequest, NextResponse } from "next/server";

/**
 * Proxies external images to avoid CORS issues (e.g. i.redd.it).
 * GET /api/image-proxy?url=https://i.redd.it/...
 */
export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "Missing url param" }, { status: 400 });
  }

  // Only allow image hosts we trust
  const allowed = ["i.redd.it", "i.imgur.com", "preview.redd.it", "external-preview.redd.it"];
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return NextResponse.json({ error: "Invalid url" }, { status: 400 });
  }

  if (!allowed.includes(hostname)) {
    return NextResponse.json({ error: "Host not allowed" }, { status: 403 });
  }

  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0" },
  });

  if (!res.ok) {
    return NextResponse.json({ error: `Upstream ${res.status}` }, { status: 502 });
  }

  const contentType = res.headers.get("content-type") || "image/jpeg";
  const body = await res.arrayBuffer();

  return new NextResponse(body, {
    headers: {
      "Content-Type": contentType,
      "Cache-Control": "public, max-age=3600",
    },
  });
}
