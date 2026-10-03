/**
 * Minimal admin session check for the funder-reports download endpoint.
 *
 * Placeholder bearer-token check against ADMIN_API_TOKEN, mirroring the
 * cron-secret-gated pattern used by app/api/internal/payout-indexer. A
 * production deployment should replace this with the project's real admin
 * auth (Supabase session + role claim) before the funder-reports endpoint
 * is exposed -- left as a narrow, explicit seam rather than guessed at,
 * since the real admin-auth mechanism wasn't part of this change's scope.
 */

import type { NextRequest } from "next/server";

export interface AdminSession {
  adminId: string;
}

export async function requireAdminSession(request: NextRequest): Promise<AdminSession | null> {
  const expectedToken = process.env.ADMIN_API_TOKEN;
  if (!expectedToken) return null;

  const authHeader = request.headers.get("authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length) : null;
  if (!token || token !== expectedToken) return null;

  return { adminId: "admin-token-session" };
}
