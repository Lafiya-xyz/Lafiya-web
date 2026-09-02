function SkeletonBlock({ className }: { className: string }) {
  return (
    <div
      className={`animate-pulse rounded-md bg-zinc-200 dark:bg-zinc-800 ${className}`}
    />
  );
}

export default function CardLoading() {
  return (
    <main
      aria-busy="true"
      aria-live="polite"
      className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6 sm:py-16"
    >
      <span className="sr-only">Loading emergency card…</span>

      <section className="flex flex-col gap-3">
        <SkeletonBlock className="h-7 w-56" />
        <div className="flex flex-col gap-2 rounded-lg border border-zinc-300 p-3 dark:border-zinc-700">
          <div className="flex justify-between gap-4">
            <SkeletonBlock className="h-4 w-32" />
            <SkeletonBlock className="h-4 w-24" />
          </div>
          <div className="flex justify-between gap-4">
            <SkeletonBlock className="h-4 w-40" />
            <SkeletonBlock className="h-4 w-24" />
          </div>
          <div className="flex justify-between gap-4">
            <SkeletonBlock className="h-4 w-36" />
            <SkeletonBlock className="h-4 w-24" />
          </div>
        </div>
      </section>

      <section className="flex items-center gap-4">
        <SkeletonBlock className="h-20 w-20 shrink-0 rounded-full" />
        <div className="flex flex-col gap-2">
          <SkeletonBlock className="h-7 w-40" />
          <SkeletonBlock className="h-4 w-24" />
        </div>
      </section>

      <section>
        <SkeletonBlock className="mb-3 h-6 w-64" />
        <div className="grid gap-4 rounded-lg border border-zinc-300 p-4 sm:grid-cols-2 dark:border-zinc-700">
          <div className="flex flex-col gap-2">
            <SkeletonBlock className="h-3 w-20" />
            <SkeletonBlock className="h-6 w-16" />
          </div>
          <div className="flex flex-col gap-2">
            <SkeletonBlock className="h-3 w-20" />
            <SkeletonBlock className="h-6 w-16" />
          </div>
        </div>
      </section>

      <section className="flex flex-col gap-5">
        <div>
          <SkeletonBlock className="mb-2 h-4 w-24" />
          <SkeletonBlock className="h-5 w-full" />
        </div>
        <div>
          <SkeletonBlock className="mb-2 h-4 w-36" />
          <SkeletonBlock className="h-5 w-full" />
        </div>
        <div>
          <SkeletonBlock className="mb-2 h-4 w-48" />
          <SkeletonBlock className="h-5 w-full" />
        </div>
      </section>

      <section>
        <SkeletonBlock className="mb-2 h-4 w-36" />
        <div className="flex flex-col gap-3">
          <SkeletonBlock className="h-20 w-full rounded-md" />
        </div>
      </section>
    </main>
  );
}
