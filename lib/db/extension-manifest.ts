import manifest from "@/supabase/extensions.manifest.json";

/**
 * Issue #811: compares the database's reported server and extension versions
 * against `supabase/extensions.manifest.json`. A Postgres major upgrade or an
 * extension change that was not rehearsed (and the manifest bumped) shows up
 * as `mismatch` at readiness instead of as a behaviour change in production.
 */
export type ExtensionRow = {
  name: string;
  version: string | null;
  server_version_num: number;
};

export type ExtensionManifestStatus = "ok" | "mismatch" | "unknown";

type Manifest = {
  postgres: { majorVersion: number };
  extensions: Record<string, { minVersion: string; required: boolean }>;
};

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** Returns the list of manifest violations; empty means compliant. */
export function diffExtensionManifest(
  rows: ExtensionRow[],
  expected: Manifest = manifest,
): string[] {
  const problems: string[] = [];
  const serverMajor = rows[0]
    ? Math.floor(rows[0].server_version_num / 10_000)
    : undefined;
  if (serverMajor !== expected.postgres.majorVersion) {
    problems.push(
      `postgres major ${serverMajor ?? "?"} != ${expected.postgres.majorVersion}`,
    );
  }
  const installed = new Map(rows.map((r) => [r.name, r.version]));
  for (const [name, spec] of Object.entries(expected.extensions)) {
    const version = installed.get(name);
    if (!version) {
      if (spec.required) problems.push(`${name} missing`);
    } else if (compareVersions(version, spec.minVersion) < 0) {
      problems.push(`${name} ${version} < ${spec.minVersion}`);
    }
  }
  return problems;
}

export function extensionManifestStatus(
  rows: ExtensionRow[] | null | undefined,
): ExtensionManifestStatus {
  if (!rows?.length) return "unknown";
  return diffExtensionManifest(rows).length === 0 ? "ok" : "mismatch";
}
