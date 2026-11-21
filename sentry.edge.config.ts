import * as Sentry from "@sentry/nextjs";
import { redactSensitiveData } from "./lib/logging/logger";
import { sanitizeEvent } from "./lib/observability/sentry-sanitize";

// Issue #942: edge functions get the same low-rate profiling as the Node
// runtime so route/release tags line up across runtimes.
const profilesSampleRate = Number(
  process.env.SENTRY_PROFILES_SAMPLE_RATE ?? "0.1",
);

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN || process.env.SENTRY_DSN,

  // Adjust this value in production, or use tracesSampler for finer control
  tracesSampleRate: 1.0,
  profilesSampleRate: Number.isFinite(profilesSampleRate)
    ? profilesSampleRate
    : 0.1,
  sendDefaultPii: false,
  release: process.env.LAFIYA_BUILD_REVISION || undefined,

  // Setting this option to true will print useful information to the console when Sentry is initialized
  debug: false,

  // Hard Rule: Never send patient health-data fields or authentication credentials to Sentry
  beforeSend(event) {
    return sanitizeEvent(redactSensitiveData(event)) as Sentry.ErrorEvent;
  },
  beforeBreadcrumb(breadcrumb) {
    return redactSensitiveData(breadcrumb) as Sentry.Breadcrumb;
  },
});
