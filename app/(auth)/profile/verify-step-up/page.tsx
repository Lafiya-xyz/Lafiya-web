import type { Metadata } from "next";

import { VerifyStepUpClient } from "./verify-step-up-client";

export const metadata: Metadata = {
  title: "Verify it's you · Lafiya",
};

const DEFAULT_NEXT = "/profile";

/**
 * Only ever reached via a same-origin redirect from a route we control
 * (see app/(auth)/profile/export/route.ts), but `next` is still untrusted
 * user input from the query string -- restrict it to an in-app relative
 * path so this can never be turned into an open redirect.
 */
export function sanitizeNext(rawNext: string | undefined): string {
  if (!rawNext) return DEFAULT_NEXT;
  if (!rawNext.startsWith("/") || rawNext.startsWith("//")) {
    return DEFAULT_NEXT;
  }
  return rawNext;
}

export default async function VerifyStepUpPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return <VerifyStepUpClient next={sanitizeNext(next)} />;
}
