export function ExpiredCapabilityState() {
  return (
    <div className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-6 py-16">
      <div className="rounded-lg border border-zinc-300 bg-zinc-50 p-6 text-center dark:border-zinc-700 dark:bg-zinc-900/40">
        <p className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          This link has expired or been revoked.
        </p>
        <p className="mt-2 text-sm text-zinc-700 dark:text-zinc-300">
          Please ask the patient to share a new link with you.
        </p>
      </div>
    </div>
  );
}
