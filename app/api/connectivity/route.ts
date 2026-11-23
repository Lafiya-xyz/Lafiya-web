import { signConnectivityNonce } from "@/lib/offline/connectivity";

/**
 * Issue #872: connectivity probe. Returns the HMAC of the caller's nonce so
 * clients can tell a real Lafiya response from a captive-portal page.
 */
export async function GET(request: Request) {
  const nonce = new URL(request.url).searchParams.get("nonce") ?? "";
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) {
    return Response.json({ error: "invalid nonce" }, { status: 400 });
  }
  return Response.json(
    { nonce, mac: await signConnectivityNonce(nonce) },
    { headers: { "Cache-Control": "no-store" } },
  );
}
