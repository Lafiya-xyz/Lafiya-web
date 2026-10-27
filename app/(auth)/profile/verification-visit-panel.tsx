"use client";

import { useActionState, useTransition } from "react";

import { formatDateTime } from "@/lib/format/datetime";
import {
  VISIT_STATUS_LABELS,
  isClosedVisitStatus,
  type VisitRequest,
  type VisitRequestStatus,
} from "@/lib/chw-protocol/visit-requests";

import {
  cancelVerificationVisit,
  requestVerificationVisit,
  setVisitContactConsent,
} from "./verification-visit-actions";

const TIMELINE: VisitRequestStatus[] = [
  "requested",
  "matched",
  "scheduled",
  "verified",
];

/**
 * Issue #765: lets a patient request a CHW verification visit and follow its
 * progress. Contact details are only shared with a matched CHW after the
 * patient explicitly consents.
 */
export function VerificationVisitPanel({
  request,
}: {
  request: VisitRequest | null;
}) {
  const [state, formAction, isPending] = useActionState(
    requestVerificationVisit,
    undefined,
  );
  const [isUpdating, startTransition] = useTransition();
  const open = request !== null && !isClosedVisitStatus(request.status);

  return (
    <section
      aria-labelledby="verification-visit-heading"
      data-testid="verification-visit-panel"
      className="rounded-lg border border-zinc-300 p-5 dark:border-zinc-700"
    >
      <h2 id="verification-visit-heading" className="font-semibold">
        Verification visit
      </h2>

      {request ? (
        <ol
          className="mt-3 flex flex-col gap-1 text-sm"
          aria-label="Request progress"
        >
          {(isClosedVisitStatus(request.status) && request.status !== "verified"
            ? [request.status]
            : TIMELINE
          ).map((step) => {
            const reached =
              step === request.status ||
              TIMELINE.indexOf(step) < TIMELINE.indexOf(request.status);
            return (
              <li
                key={step}
                aria-current={step === request.status ? "step" : undefined}
                className={
                  reached ? "font-semibold" : "text-zinc-500 dark:text-zinc-400"
                }
              >
                {reached ? "✓ " : "○ "}
                {VISIT_STATUS_LABELS[step]}
              </li>
            );
          })}
          <li className="text-xs text-zinc-500 dark:text-zinc-400">
            Last updated {formatDateTime(request.updated_at)} · Area:{" "}
            {request.lga}
          </li>
        </ol>
      ) : null}

      {open ? (
        <div className="mt-3 flex flex-col gap-2 text-sm">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={request.contact_consent}
              disabled={isUpdating}
              onChange={(event) => {
                const consent = event.target.checked;
                startTransition(() =>
                  setVisitContactConsent(request.id, consent),
                );
              }}
            />
            Share my contact details with the matched health worker
          </label>
          <button
            type="button"
            disabled={isUpdating}
            onClick={() =>
              startTransition(() => cancelVerificationVisit(request.id))
            }
            className="self-start rounded-full border border-zinc-950 px-3 py-1 text-xs dark:border-zinc-50"
          >
            Cancel request
          </button>
        </div>
      ) : (
        <form action={formAction} className="mt-3 flex flex-col gap-2 text-sm">
          <label className="flex flex-col gap-1">
            Local government area (LGA)
            <input
              name="lga"
              required
              maxLength={100}
              className="rounded border px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1">
            Preferred language (optional)
            <input
              name="preferredLanguage"
              maxLength={20}
              className="rounded border px-2 py-1"
            />
          </label>
          <label className="flex flex-col gap-1">
            How should we contact you?
            <select
              name="contactPreference"
              defaultValue="sms"
              className="rounded border px-2 py-1"
            >
              <option value="sms">SMS</option>
              <option value="phone_call">Phone call</option>
              <option value="whatsapp">WhatsApp</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            Phone number (optional)
            <input
              name="contactPhone"
              type="tel"
              maxLength={32}
              className="rounded border px-2 py-1"
            />
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="consent" />
            Share my contact details with the matched health worker
          </label>
          {state?.error ? (
            <p role="alert" className="text-red-700 dark:text-red-400">
              {state.error}
            </p>
          ) : null}
          <button
            type="submit"
            disabled={isPending}
            className="self-start rounded-full border border-zinc-950 px-4 py-1 dark:border-zinc-50"
          >
            {isPending ? "Sending…" : "Request a verification visit"}
          </button>
        </form>
      )}
    </section>
  );
}
