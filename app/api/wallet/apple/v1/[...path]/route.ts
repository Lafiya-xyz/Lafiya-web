import { NextResponse } from "next/server";

import { logError } from "@/lib/logging/logger";
import { WalletPassesNotConfiguredError } from "@/lib/wallet-passes";
import { handlePassKitRequest } from "@/lib/wallet-passes/updates";
import { passKitDeps } from "@/lib/wallet-passes/updates-runtime";

/**
 * ROUTE: /api/wallet/apple/v1/* — Apple PassKit web service (issue #771).
 * `webServiceURL` in pass.json is `…/api/wallet/apple`; Apple appends `/v1/…`.
 * Protocol logic lives in lib/wallet-passes/updates.ts.
 */
async function handle(
  request: Request,
  ctx: { params: Promise<{ path: string[] }> },
) {
  try {
    const { path } = await ctx.params;
    let body: unknown = null;
    if (request.method === "POST") {
      try {
        body = await request.json();
      } catch {
        body = null;
      }
    }
    const res = await handlePassKitRequest(
      {
        method: request.method,
        path,
        authorization: request.headers.get("authorization"),
        ifModifiedSince: request.headers.get("if-modified-since"),
        query: new URL(request.url).searchParams,
        body,
      },
      passKitDeps(),
    );
    const headers: Record<string, string> = { "Cache-Control": "no-store" };
    if (res.lastModified) headers["Last-Modified"] = res.lastModified;
    if (res.pkpass) {
      headers["Content-Type"] = "application/vnd.apple.pkpass";
      return new NextResponse(new Uint8Array(res.pkpass), {
        status: res.status,
        headers,
      });
    }
    if (res.json !== undefined)
      return NextResponse.json(res.json, { status: res.status, headers });
    return new NextResponse(null, { status: res.status, headers });
  } catch (error) {
    if (error instanceof WalletPassesNotConfiguredError) {
      return new NextResponse(null, { status: 501 });
    }
    logError("PassKit web service failed", error, {
      route: "/api/wallet/apple/v1",
    });
    return new NextResponse(null, { status: 500 });
  }
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;
