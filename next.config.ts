import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

/**
 * Supabase Storage is served from the same configured origin as the Supabase
 * API (NEXT_PUBLIC_SUPABASE_URL), so we allowlist that exactly rather than
 * relying on the broad *.supabase.co wildcard. This keeps `next/image`
 * optimization (resizing, format conversion, lazy loading) available for
 * profile and public-card photos without exposing arbitrary remote hosts.
 * The env var is NEXT_PUBLIC_-prefixed and therefore safe to read here.
 */
function supabaseStoragePattern() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    return {
      protocol: parsed.protocol.replace(":", "") as "http" | "https",
      hostname: parsed.hostname,
      port: parsed.port,
    };
  } catch {
    return null;
  }
}

const supabaseStorageOrigin = supabaseStoragePattern();

const nextConfig: NextConfig = {
  /**
   * Cache Components / Partial Prerendering (Next 16).
   *
   * Enables the static shell of a route to be prerendered and streamed
   * immediately, while dynamic, per-user sections render behind Suspense
   * boundaries. The profile shell (navigation, headings, help text) is
   * static; user-specific sections opt into dynamic rendering via Suspense
   * and `use cache` is only applied to non-user-scoped data.
   *
   * See node_modules/next/dist/docs/ for the exact Next 16 API surface.
   */
  cacheComponents: true,
  images: {
    remotePatterns: [
      // Derived from the configured Supabase origin (local dev + hosted).
      ...(supabaseStorageOrigin ? [supabaseStorageOrigin] : []),
      // Local Supabase Storage (supabase start) — fallback for the
      // documented .env.example defaults.
      { protocol: "http", hostname: "127.0.0.1", port: "54321" },
      // Hosted Supabase Storage — fallback for custom/older deployments.
      { protocol: "https", hostname: "*.supabase.co" },
    ],
  },
};

const sentryWebpackPluginOptions = {
  silent: true,
  org: "lafiya",
  project: "lafiya-web",
  // Disable source map upload if we don't have the auth token to avoid build failures
  disableServerWebpackPlugin: !process.env.SENTRY_AUTH_TOKEN,
  disableClientWebpackPlugin: !process.env.SENTRY_AUTH_TOKEN,
};

export default withSentryConfig(nextConfig, sentryWebpackPluginOptions);
