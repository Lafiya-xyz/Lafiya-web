import * as Sentry from "@sentry/nextjs";
import { redactSensitiveData } from "./lib/logging/logger";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN || process.env.SENTRY_DSN,

  // Adjust this value in production, or use tracesSampler for finer control
  tracesSampleRate: 1.0,
  sendDefaultPii: false,

  // Setting this option to true will print useful information to the console when Sentry is initialized
  debug: false,

  // Hard Rule: Never send patient health-data fields or authentication credentials to Sentry
  beforeSend(event) {
    return redactSensitiveData(event) as Sentry.ErrorEvent;
  },
  beforeBreadcrumb(breadcrumb) {
    return redactSensitiveData(breadcrumb) as Sentry.Breadcrumb;
  },
});
