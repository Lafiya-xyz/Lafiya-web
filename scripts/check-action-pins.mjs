import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SHA_RE = /^[0-9a-f]{40}$/i;
const DOCKER_DIGEST_RE = /^sha256:[0-9a-f]{64}$/i;

/**
 * Parses every `uses:` reference out of the given workflow file contents.
 * Exported (and tested — see check-action-pins.test.ts) separately from
 * the pin-format check below so the two can be verified independently:
 * a broken parse would otherwise silently look identical to "nothing to
 * flag" (Issue #406).
 */
export function findUsesReferences(contents) {
  const references = [];
  for (const match of contents.matchAll(
    /^\s*(?:-\s*)?uses:\s*([^\s#]+)@([^\s#]+).*$/gm,
  )) {
    references.push({ action: match[1], revision: match[2] });
  }
  return references;
}

/** True when `revision` is an immutable pin: a git commit SHA, or a
 * `sha256:` Docker image digest for `docker://` references. */
export function isImmutablePin(action, revision) {
  if (action.startsWith("docker://")) {
    return DOCKER_DIGEST_RE.test(revision);
  }
  return SHA_RE.test(revision);
}

/** Scans every `.yml`/`.yaml` file directly under `workflowsDirectory` and
 * returns the `uses:` references that are NOT pinned to an immutable
 * revision. Local actions (`./...`) are never flagged — they resolve to
 * this repo's own commit, not a third party's mutable tag. */
export function findMutableReferences(workflowsDirectory) {
  const mutable = [];
  for (const name of readdirSync(workflowsDirectory).filter((file) =>
    /\.ya?ml$/i.test(file),
  )) {
    const contents = readFileSync(join(workflowsDirectory, name), "utf8");
    for (const { action, revision } of findUsesReferences(contents)) {
      if (action.startsWith("./")) continue;
      if (!isImmutablePin(action, revision)) {
        mutable.push({ file: name, action, revision });
      }
    }
  }
  return mutable;
}

function main() {
  const workflowsDirectory = join(process.cwd(), ".github", "workflows");
  const mutable = findMutableReferences(workflowsDirectory);

  if (mutable.length > 0) {
    console.error("GitHub Actions must use immutable pins (a 40-character commit SHA, or a sha256: digest for docker:// references):");
    for (const { file, action, revision } of mutable) {
      console.error(`  ${file}: ${action}@${revision}`);
    }
    process.exit(1);
  }

  console.log("Verified all GitHub Action references are immutably pinned.");
}

// Only run as a CLI when executed directly — not when imported by the test.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
