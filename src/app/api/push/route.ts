import { NextRequest, NextResponse } from "next/server";
import {
  addSubscription,
  removeSubscription,
  getSubscriptionCount,
} from "@/lib/push-store";
import { verifyAppToken, unauthorizedResponse } from "@/lib/auth";

export async function POST(request: NextRequest) {
  if (!verifyAppToken(request)) return unauthorizedResponse();
  try {
    const { subscription, action } = await request.json();

    if (action === "unsubscribe") {
      const endpoint = subscription?.endpoint;
      if (endpoint) {
        removeSubscription(endpoint);
      }
      return NextResponse.json({ ok: true, message: "Unsubscribed" });
    }

    if (!subscription || !subscription.endpoint) {
      return NextResponse.json(
        { ok: false, error: "Invalid subscription" },
        { status: 400 },
      );
    }

    addSubscription(subscription.endpoint, subscription);

    console.log(
      `Push subscription registered. Total: ${getSubscriptionCount()}`,
    );

    return NextResponse.json({
      ok: true,
      message: "Subscribed successfully",
      totalSubscriptions: getSubscriptionCount(),
    });
  } catch (error: any) {
    console.error("Push subscription error:", error);
    return NextResponse.json(
      { ok: false, error: error.message },
      { status: 500 },
    );
  }
}

export async function GET(request: NextRequest) {
  if (!verifyAppToken(request)) return unauthorizedResponse();
  return NextResponse.json({
    ok: true,
    totalSubscriptions: getSubscriptionCount(),
    vapidPublicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || "",
  });
}
