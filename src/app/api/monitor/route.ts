import { NextRequest, NextResponse } from "next/server";
import { verifyAppToken, unauthorizedResponse } from "@/lib/auth";

const MONITOR_WORKER_URL = process.env.MONITOR_WORKER_URL || "";

async function workerFetch(path: string, method: string, body?: any) {
  if (!MONITOR_WORKER_URL) {
    throw new Error("MONITOR_WORKER_URL not configured");
  }
  const res = await fetch(`${MONITOR_WORKER_URL}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// GET /api/monitor — check monitoring status
export async function GET(request: NextRequest) {
  if (!verifyAppToken(request)) return unauthorizedResponse();
  try {
    const data = await workerFetch("/status", "GET");
    return NextResponse.json({ ok: true, ...data });
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err.message },
      { status: 500 },
    );
  }
}

// POST /api/monitor — toggle monitoring or sync push subscription
export async function POST(request: NextRequest) {
  if (!verifyAppToken(request)) return unauthorizedResponse();
  try {
    const body = await request.json();

    // Toggle monitoring on/off
    if ("enabled" in body) {
      const data = await workerFetch("/toggle", "POST", {
        enabled: body.enabled,
      });
      return NextResponse.json({ ok: true, ...data });
    }

    // Register push subscription with the worker
    if ("subscription" in body) {
      const data = await workerFetch("/subscribe", "POST", {
        subscription: body.subscription,
      });
      return NextResponse.json({ ok: true, ...data });
    }

    // Unsubscribe
    if ("unsubscribeEndpoint" in body) {
      const data = await workerFetch("/unsubscribe", "POST", {
        endpoint: body.unsubscribeEndpoint,
      });
      return NextResponse.json({ ok: true, ...data });
    }

    return NextResponse.json(
      { ok: false, error: "Invalid request" },
      { status: 400 },
    );
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err.message },
      { status: 500 },
    );
  }
}
