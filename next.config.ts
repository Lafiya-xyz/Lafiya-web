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

/**
 * Fixed path from which the service worker may be served and registered
 * (issue #967). CSP `worker-src` is pinned to exactly this path so a
 * compromised page cannot register a worker from any other URL.
 */
const SERVICE_WORKER_PATH = "/sw.js";

/**
 * Emergency kill switch (issue #967). When the server sets
 * `LAFIYA_SW_KILL_SWITCH=1`, every response emits
 * `Clear-Site-Data: "storage"` (removing the worker, caches and other
 * origin storage) and `/sw.js` serves a no-op replacement worker so the
 * malicious/rogue worker is unregistered on the next navigation.
 */
const serviceWorkerKillSwitch = process.env.LAFIYA_SW_KILL_SWITCH === "1";

/**
 * Content-Security-Policy for the app. `worker-src` is restricted to the
 * single fixed worker path; `script-src` keeps Next's inline bootstrap
 * working via 'unsafe-inline' (nonce plumbing is tracked separately).
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  `worker-src 'self' ${SERVICE_WORKER_PATH}`,
  "manifest-src 'self'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Kill switch: purge worker, caches and other origin storage.
  ...(serviceWorkerKillSwitch
    ? [{ key: "Clear-Site-Data", value: '"storage"' }]
    : []),
];

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
  /**
   * Deterministic build ID (issue #781). The default is random per build,
   * which changes `_next/static/<buildId>/` paths and breaks hash equality
   * between two builds of one commit. Falls back to Next's default locally.
   */
  generateBuildId: async () =>
    process.env.LAFIYA_BUILD_ID ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.GITHUB_SHA ||
    null,
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
  async headers() {
    return [
      {
        // Security headers for every route.
        source: "/:path*",
        headers: securityHeaders,
      },
      {
        // The worker is served only from the fixed path with a strict
        // JavaScript content type and a minimally scoped
        // Service-Worker-Allowed (root scope is required for /card/*).
        source: SERVICE_WORKER_PATH,
        headers: [
          { key: "Content-Type", value: "text/javascript; charset=utf-8" },
          { key: "Service-Worker-Allowed", value: "/" },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
  async rewrites() {
    if (!serviceWorkerKillSwitch) {
      return [];
    }
    // Emergencies: replace the real worker with a no-op that unregisters
    // itself and clears caches, so devices recover on next navigation.
    return [
      {
        source: SERVICE_WORKER_PATH,
        destination: "/sw-kill-switch.js",
      },
    ];
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
