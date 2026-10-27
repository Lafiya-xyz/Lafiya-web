/**
 * Issue #807: patient security posture derivation.
 *
 * Score = sum of weights of satisfied checks, out of 100. Weights reflect
 * how much each control reduces account-takeover risk for a patient whose
 * emergency card is public:
 *   - mfa (40): a stolen password alone can no longer change the record.
 *   - sessions (20): no more than MAX_HEALTHY_SESSIONS signed-in devices
 *     and none idle longer than STALE_SESSION_DAYS.
 *   - emailConfirmed (20): recovery and alert emails reach the patient.
 *   - noPendingEmailChange (20): no unconfirmed email change in flight.
 * Each check carries a plain-language reason and a link to the existing
 * flow that fixes it; no check is satisfied by anything weaker than the
 * flow it links to.
 */

export const MAX_HEALTHY_SESSIONS = 3;
export const STALE_SESSION_DAYS = 30;

export interface SecurityPostureInput {
  hasVerifiedMfa: boolean;
  sessionLastSeen: Date[];
  emailConfirmed: boolean;
  hasPendingEmailChange: boolean;
  now?: Date;
}

export type SecurityCheckId = "mfa" | "sessions" | "emailConfirmed" | "noPendingEmailChange";

export interface SecurityCheck {
  id: SecurityCheckId;
  weight: number;
  ok: boolean;
  title: string;
  why: string;
  fixLabel: string;
  fixHref: string;
}

export interface SecurityPosture {
  score: number;
  checks: SecurityCheck[];
}

export function deriveSecurityPosture(input: SecurityPostureInput): SecurityPosture {
  const now = input.now ?? new Date();
  const staleBefore = now.getTime() - STALE_SESSION_DAYS * 24 * 60 * 60 * 1000;
  const sessionsOk =
    input.sessionLastSeen.length <= MAX_HEALTHY_SESSIONS &&
    input.sessionLastSeen.every((seen) => seen.getTime() >= staleBefore);

  const checks: SecurityCheck[] = [
    {
      id: "mfa",
      weight: 40,
      ok: input.hasVerifiedMfa,
      title: "Second sign-in check",
      why: "Someone who learns your password still cannot change your card without the code on your phone.",
      fixLabel: "Turn on the second check",
      fixHref: "/profile#security-mfa",
    },
    {
      id: "sessions",
      weight: 20,
      ok: sessionsOk,
      title: "Signed-in devices",
      why: "Old or unknown devices that are still signed in could be used by someone else.",
      fixLabel: "Review signed-in devices",
      fixHref: "/profile#security-sessions",
    },
    {
      id: "emailConfirmed",
      weight: 20,
      ok: input.emailConfirmed,
      title: "Confirmed email",
      why: "We send warnings and account recovery links to this email.",
      fixLabel: "Check your email address",
      fixHref: "/profile#security-email",
    },
    {
      id: "noPendingEmailChange",
      weight: 20,
      ok: !input.hasPendingEmailChange,
      title: "No surprise email change",
      why: "An email change you did not ask for can mean someone else is in your account.",
      fixLabel: "Review the email change",
      fixHref: "/profile#security-email",
    },
  ];

  return {
    score: checks.reduce((sum, check) => sum + (check.ok ? check.weight : 0), 0),
    checks,
  };
}
