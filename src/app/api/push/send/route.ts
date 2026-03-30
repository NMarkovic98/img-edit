import { NextRequest, NextResponse } from "next/server";
import webpush from "web-push";
import { verifyAppToken, unauthorizedResponse } from "@/lib/auth";
import {
  getSubscriptions,
  removeSubscription,
  getSubscriptionCount,
} from "@/lib/push-store";

// Configure web-push with VAPID keys
const vapidPublicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "";
const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY || "";

if (vapidPublicKey && vapidPrivateKey) {
  webpush.setVapidDetails(
    "mailto:nmarkovic98@gmail.com",
    vapidPublicKey,
    vapidPrivateKey,
  );
}

export async function POST(request: NextRequest) {
  if (!verifyAppToken(request)) return unauthorizedResponse();
  try {
    const { title, body, url, tag, postId } = await request.json();

    if (!vapidPublicKey || !vapidPrivateKey) {
      return NextResponse.json(
        { ok: false, error: "VAPID keys not configured" },
        { status: 500 },
      );
    }

    const payload = JSON.stringify({
      title: title || "Fixtral",
      body: body || "New activity",
      url: url || "/app",
      tag: tag || "fixtral-notification",
      postId,
    });

    const results = { success: 0, failed: 0, removed: 0 };
    const subscriptions = getSubscriptions();

    const sendPromises = Array.from(subscriptions.entries()).map(
      async ([endpoint, sub]) => {
        try {
          await webpush.sendNotification(sub as any, payload);
          results.success++;
        } catch (error: any) {
          results.failed++;
          if (error.statusCode === 410 || error.statusCode === 404) {
            removeSubscription(endpoint);
            results.removed++;
          }
          console.error(
            `Push to ${endpoint.slice(0, 50)}... failed:`,
            error.statusCode,
          );
        }
      },
    );

    await Promise.all(sendPromises);

    console.log(
      `Push sent: ${results.success} ok, ${results.failed} fail, ${results.removed} removed`,
    );

    return NextResponse.json({
      ok: true,
      ...results,
      totalSubscriptions: getSubscriptionCount(),
    });
  } catch (error: any) {
    console.error("Push send error:", error);
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  }
}
