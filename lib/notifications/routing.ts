/**
 * Regulator-aware SMS routing for Nigeria (issue #805).
 *
 * NCC rules filter promotional traffic for numbers on the Do-Not-Disturb
 * registry. Every template must therefore map to an explicit route class and
 * a registered sender ID; security and emergency SMS always use the
 * transactional (DND-bypassing) route. See docs/operations/sms-sender-id-routing.md.
 */

import { TEMPLATE_IDS } from "./templates";

export type RouteClass = "transactional" | "promotional";

/** Termii channel names per route class. "dnd" bypasses the DND registry. */
export const TERMII_CHANNEL: Record<RouteClass, string> = {
  transactional: "dnd",
  promotional: "generic",
};

export interface TemplateRoute {
  routeClass: RouteClass;
  /** Env var holding the registered sender ID for this route. */
  senderIdEnv: string;
}

export const TEMPLATE_ROUTES: Record<string, TemplateRoute> = {
  "security.new_signin": { routeClass: "transactional", senderIdEnv: "TERMII_SENDER_ID" },
  "emergency.card_accessed": { routeClass: "transactional", senderIdEnv: "TERMII_SENDER_ID" },
  "chw.verification_complete": { routeClass: "transactional", senderIdEnv: "TERMII_SENDER_ID" },
  "chw.reattestation_requested": { routeClass: "transactional", senderIdEnv: "TERMII_SENDER_ID" },
};

/** Comma-separated list of sender IDs approved by the NCC / Termii. */
function approvedSenderIds(env: NodeJS.ProcessEnv): Set<string> {
  return new Set(
    (env.TERMII_APPROVED_SENDER_IDS ?? env.TERMII_SENDER_ID ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Startup validation: every template must have an approved route and, when
 * SMS is configured, a sender ID on the approved list. Throws listing all
 * problems so boot fails loudly instead of silently dropping SMS.
 */
export function validateSmsRouting(
  templates: readonly string[] = TEMPLATE_IDS,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const problems: string[] = [];
  const approved = approvedSenderIds(env);
  const smsConfigured = Boolean(env.TERMII_API_KEY);
  for (const id of templates) {
    const route = TEMPLATE_ROUTES[id];
    if (!route) {
      problems.push(`template "${id}" has no SMS route`);
      continue;
    }
    if (smsConfigured) {
      const sender = env[route.senderIdEnv];
      if (!sender) problems.push(`template "${id}": ${route.senderIdEnv} is not set`);
      else if (!approved.has(sender)) problems.push(`template "${id}": sender ID is not on the approved list`);
    }
  }
  if (problems.length) {
    throw new Error(`SMS routing validation failed:\n- ${problems.join("\n- ")}`);
  }
}

export function routeFor(template: string): TemplateRoute {
  const route = TEMPLATE_ROUTES[template];
  if (!route) throw new Error(`No SMS route for template "${template}"`);
  return route;
}
