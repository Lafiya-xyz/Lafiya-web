import * as Sentry from "@sentry/nextjs";
import {
  sanitizeBreadcrumbForSentry,
  sanitizeEvent,
} from "./lib/observability/sentry-sanitize";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN || process.env.SENTRY_DSN,

  // Adjust this value in production, or use tracesSampler for finer control.
  // Sampling is intentionally configured per-runtime; the sanitizer below is
  // the single source of truth for what leaves the browser.
  tracesSampleRate: 1.0,
  sendDefaultPii: false,

  // Setting this option to true will print useful information to the console when Sentry is initialized
  debug: false,

  // Hard Rule: Never send patient health-data fields or authentication credentials to Sentry.
  // Allowlist-based sanitizer: only known-safe keys survive.
  beforeSend(event) {
    return sanitizeEvent(event) as Sentry.ErrorEvent;
  },
  beforeBreadcrumb(breadcrumb) {
    return sanitizeBreadcrumbForSentry(breadcrumb) as Sentry.Breadcrumb;
  },
});
