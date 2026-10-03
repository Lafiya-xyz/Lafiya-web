import { submitCardPin } from "./actions";

const MESSAGES: Record<string, string> = {
  invalid: "That PIN is not correct. Check the PIN printed on the card.",
  locked:
    "Too many incorrect PINs. The protected details are locked until the patient issues a new card.",
  unavailable: "The PIN could not be checked right now. Please try again.",
};

/**
 * Issue #631: PIN entry for sensitive fields. A plain POST form so it works
 * without JavaScript; critical fields are already shown above it.
 */
export function CardPinForm({
  token,
  status,
  canUnlock,
  locked,
}: {
  token: string;
  status?: string;
  canUnlock: boolean;
  locked: boolean;
}) {
  const message = locked ? MESSAGES.locked : status && MESSAGES[status];
  return (
    <section
      aria-labelledby="card-pin-heading"
      className="flex flex-col gap-3 rounded-lg border border-zinc-300 p-4 dark:border-zinc-700"
    >
      <h2 id="card-pin-heading" className="font-semibold">
        Some details are protected by a card PIN
      </h2>
      {message ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {message}
        </p>
      ) : null}
      {canUnlock ? (
        <form action={submitCardPin} className="flex flex-wrap gap-3">
          <input type="hidden" name="token" value={token} />
          <label className="flex flex-col gap-1 text-sm">
            6-digit PIN printed on the card
            <input
              name="pin"
              type="password"
              inputMode="numeric"
              autoComplete="off"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              className="min-h-11 w-40 rounded-md border border-zinc-300 px-3 tracking-widest dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          <button
            type="submit"
            className="min-h-11 self-end rounded-full bg-zinc-950 px-5 py-2 text-white dark:bg-zinc-50 dark:text-zinc-950"
          >
            Show protected details
          </button>
        </form>
      ) : locked ? null : (
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          This card link has no PIN. Ask the patient to issue a new card to view
          the protected details.
        </p>
      )}
    </section>
  );
}
