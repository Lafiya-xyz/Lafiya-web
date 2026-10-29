/**
 * Lease runner contract injected into long-running indexers (Issue #694).
 * Kept dependency-free so indexers don't pull in the Supabase admin client;
 * the production implementation is `leasedRunner` in `./lease`.
 */
export type LeaseRunner = <T>(
  jobName: string,
  work: () => Promise<T>,
) => Promise<T>;

/** No-op runner for tests and callers that coordinate externally. */
export const unleasedRunner: LeaseRunner = (_jobName, work) => work();
