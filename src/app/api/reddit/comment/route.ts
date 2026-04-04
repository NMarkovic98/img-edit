export const runtime = "nodejs";
export const maxDuration = 60;

import { NextRequest, NextResponse } from "next/server";
import { verifyAppToken, unauthorizedResponse } from "@/lib/auth";

const BOT_URL = process.env.BOT_URL || "http://localhost:3099";
const BOT_SECRET = process.env.BOT_SECRET || "";

/**
 * Proxy endpoint: forwards image + redditUrl to the reddit-bot server.
 * This avoids mixed-content (HTTPS→HTTP) issues when calling from mobile.
 */
export async function POST(request: NextRequest) {
  if (!verifyAppToken(request)) return unauthorizedResponse();

  try {
    const incoming = await request.formData();
    const image = incoming.get("image") as File | null;
    const redditUrl = incoming.get("redditUrl") as string | null;
    const paypalLink = incoming.get("paypalLink") as string | null;

    if (!redditUrl) {
      return NextResponse.json({ success: false, error: "redditUrl is required" }, { status: 400 });
    }
    if (!image) {
      return NextResponse.json({ success: false, error: "image is required" }, { status: 400 });
    }

    // Build FormData to forward to bot
    const form = new FormData();
    form.append("image", image, (image as File).name || "image.jpg");
    form.append("redditUrl", redditUrl);
    if (paypalLink) form.append("paypalLink", paypalLink);
    if (BOT_SECRET) form.append("secret", BOT_SECRET);

    const botRes = await fetch(`${BOT_URL}/reply`, {
      method: "POST",
      body: form,
    });

    const result = await botRes.json();
    return NextResponse.json(result, { status: botRes.ok ? 200 : 502 });
  } catch (err: any) {
    console.error("Bot proxy error:", err);
    return NextResponse.json(
      { success: false, error: "Could not reach bot server: " + err.message },
      { status: 502 },
    );
  }
}
