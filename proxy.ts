import { createServerClient } from "@supabase/ssr";
import {
  type NextFetchEvent,
  type NextRequest,
  NextResponse,
} from "next/server";

import { clientEnv } from "@/lib/env";
import {
  createSessionTouchThrottle,
  sessionIdFromAccessToken,
} from "@/lib/sessions/throttle";
import { coarseUserAgent } from "@/lib/sessions/user-agent";
import type { Database } from "@/lib/supabase/types";

const PROTECTED_PREFIXES = ["/profile"];
const AUTH_ONLY_PATHS = ["/signin", "/signup"];

// Roles are stored in app_metadata, which can only be written by the service
// role. Never trust user_metadata here — it is user-writable.
const ADMIN_ROLES = ["operator", "reviewer", "finance"] as const;

function getAdminRoles(user: { app_metadata?: Record<string, unknown> } | null) {
  const raw = user?.app_metadata?.roles;
  const roles = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return roles.filter((role): role is (typeof ADMIN_ROLES)[number] =>
    (ADMIN_ROLES as readonly string[]).includes(role),
  );
}

export async function proxy(request: NextRequest) {
  // Issue #520: this is a high-frequency, unauthenticated, browser-fired
  // endpoint -- it must never wait on (or be redirected by) the session
  // check below, so it is excluded from the whole auth pipeline, not just
  // the redirect logic.
  if (request.nextUrl.pathname === CSP_REPORT_PATH) {
    return NextResponse.next({ request });
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient<Database>(
    clientEnv.NEXT_PUBLIC_SUPABASE_URL,
    clientEnv.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // getUser() (not getSession()) revalidates the token against the auth
  // server on every request rather than trusting a potentially-stale JWT —
  // required reading before touching this: https://supabase.com/docs/guides/auth/server-side/nextjs
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (user) {
    // Last-seen for the sessions panel (#523). getUser() above has already
    // verified the token with the Auth server. The session id read here is
    // only a throttle key: touch_my_session() takes the real one from the
    // JWT Postgres verifies, and rewrites last_seen_at at most once per
    // five minutes.
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const sessionId = sessionIdFromAccessToken(session?.access_token);
    if (sessionId && sessionTouchThrottle.shouldTouch(sessionId)) {
      const { browser, os } = coarseUserAgent(
        request.headers.get("user-agent"),
      );
      const touch = Promise.resolve(
        supabase.rpc("touch_my_session", { p_browser: browser, p_os: os }),
      ).then(
        () => undefined,
        // Best effort: a failed last-seen write must never block navigation.
        () => undefined,
      );
      if (event) event.waitUntil(touch);
    }
  }

  const { pathname } = request.nextUrl;
  const isPublicCard = pathname === "/card" || pathname.startsWith("/card/");
  const isAnalytics = pathname === ANALYTICS_PATH;

  if (isAnalytics) {
    // The analytics beacon is cookieless and must not be cached, indexed, or
    // carry the card capability as a referrer to any downstream service.
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
  }

  if (isPublicCard) {
    // The URL is a bearer capability (legacy UUID or current capability). It
    // must never be sent as a referrer, placed in a shared CDN cache, indexed,
    // or allowed to trigger third-party network requests from the card page.
    response.headers.set("Referrer-Policy", "no-referrer");
    response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    // Issue #520: report-to (Reporting API v1, via Reporting-Endpoints)
    // covers current browsers; report-uri stays alongside it for Safari,
    // which has never implemented the Reporting API. Both point at the
    // same PHI-safe-sampling endpoint.
    const reportUri = new URL(CSP_REPORT_PATH, request.url).toString();
    response.headers.set(
      "Reporting-Endpoints",
      `${CSP_REPORT_ENDPOINT_NAME}="${reportUri}"`,
    );
    response.headers.set(
      "Content-Security-Policy",
      `default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; connect-src 'self'; img-src 'self' data: blob: https://*.supabase.co http://127.0.0.1:54321; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; report-to ${CSP_REPORT_ENDPOINT_NAME}; report-uri ${reportUri}`,
    );
  }
  const isProtected = PROTECTED_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
  const isAuthOnly = AUTH_ONLY_PATHS.includes(pathname);
  const isAdmin =
    pathname === "/admin" || pathname.startsWith("/admin/");

  if (!user && isProtected) {
    const signInUrl = new URL("/signin", request.url);
    signInUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(signInUrl);
  }

  if (user && isAuthOnly) {
    return NextResponse.redirect(new URL("/profile", request.url));
  }

  if (isAdmin) {
    // Admin routes are never cached and never indexed.
    response.headers.set("Cache-Control", "private, no-store, max-age=0");
    response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");

    if (!user) {
      const signInUrl = new URL("/signin", request.url);
      signInUrl.searchParams.set("next", pathname);
      return NextResponse.redirect(signInUrl);
    }

    // Roles come from app_metadata (service-role-set only). Non-admins are
    // treated as if the route does not exist.
    if (getAdminRoles(user).length === 0) {
      return new NextResponse(null, { status: 404 });
    }

    // Require AAL2 (MFA) for every admin route. The assurance level is read
    // from the verified token claims, not from user-controlled input.
    const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal?.currentLevel !== "aal2") {
      const mfaUrl = new URL("/signin", request.url);
      mfaUrl.searchParams.set("next", pathname);
      mfaUrl.searchParams.set("mfa", "required");
      return NextResponse.redirect(mfaUrl);
    }
  }

  return response;
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for static assets and image
     * optimization files, so the session cookie still gets refreshed on
     * every navigable page without doing this work for every asset.
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
