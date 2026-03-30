// Simple app-level password protection
// All API routes call verifyAppToken() to check the Authorization header

const APP_PASSWORD = process.env.APP_PASSWORD;

export function verifyAppToken(request: Request): boolean {
  if (!APP_PASSWORD) return true; // no password set = open access (dev mode)

  const header = request.headers.get("Authorization");
  if (!header?.startsWith("Bearer ")) return false;

  const token = header.slice(7);
  return token === APP_PASSWORD;
}

export function unauthorizedResponse() {
  return new Response(JSON.stringify({ ok: false, error: "Unauthorized" }), {
    status: 401,
    headers: { "Content-Type": "application/json" },
  });
}
