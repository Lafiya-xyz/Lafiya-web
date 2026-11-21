import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Nightly differential fuzzer for record canonicalization (issue #958).
 *
 * Generates random synthetic records, canonicalizes each one with
 * `@lafiya/protocol` (reference) and with the verifier-side implementation in
 * `lib/records/canonicalization.ts`, and compares the outputs.
 *
 *   node scripts/differential-fuzz.mjs [--cases N] [--seed N] [--write]
 *
 * Without `--write` the script only reports. With `--write` every divergence
 * is appended to `contracts/record-canonicalization-differential-v1.json`
 * (deduplicated by name) so it becomes a committed test vector, and a
 * cross-repo issue body is written to `differential-divergences.md` for the
 * workflow to file. Exit code is 1 when any divergence is found.
 *
 * No PHI: all generated values are synthetic.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VECTORS_PATH = join(
  ROOT,
  "contracts",
  "record-canonicalization-differential-v1.json",
);
const REPORT_PATH = join(ROOT, "differential-divergences.md");

function parseArgs(argv) {
  const options = { cases: 500, seed: 958, write: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--write") options.write = true;
    else if (arg === "--cases") options.cases = Number(argv[++i]);
    else if (arg === "--seed") options.seed = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.cases) || options.cases < 1) {
    throw new Error("--cases must be a positive integer");
  }
  if (!Number.isInteger(options.seed)) {
    throw new Error("--seed must be an integer");
  }
  return options;
}

async function loadImplementations() {
  const protocol = await import("../packages/protocol/src/index.ts");
  const verifier = await import("../lib/records/canonicalization.ts");
  return {
    protocol,
    candidate: (input) =>
      verifier.canonicalizeEmergencyRecordVerifier(input),
  };
}

function persistVectors(divergences) {
  const existing = existsSync(VECTORS_PATH)
    ? JSON.parse(readFileSync(VECTORS_PATH, "utf8"))
    : {
        $schema: "./record-canonicalization-differential-v1.schema.json",
        contract: "lafiya.record-canonicalization-differential",
        version: 1,
        vectors: [],
      };
  const known = new Set(existing.vectors.map((vector) => vector.name));
  for (const divergence of divergences) {
    if (!known.has(divergence.name)) {
      existing.vectors.push(divergence);
      known.add(divergence.name);
    }
  }
  writeFileSync(VECTORS_PATH, `${JSON.stringify(existing, null, 2)}\n`);
  return existing.vectors.length;
}

function writeReport(report) {
  const lines = [
    "## Differential canonicalization divergences",
    "",
    `Seed \`${report.seed}\`, ${report.cases} generated records, ` +
      `${report.divergences.length} divergence(s).`,
    "",
    "`@lafiya/protocol` and the verifier-side implementation disagree on the",
    "canonical form below. Each case is persisted in",
    "`contracts/record-canonicalization-differential-v1.json`.",
    "",
  ];
  for (const divergence of report.divergences) {
    lines.push(
      `### \`${divergence.name}\``,
      "",
      "```json",
      JSON.stringify(divergence.input, null, 2),
      "```",
      "",
      `- expected (\`@lafiya/protocol\`): \`${divergence.expected}\``,
      `- actual (verifier): \`${divergence.actual}\``,
      "",
    );
  }
  writeFileSync(REPORT_PATH, lines.join("\n"));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { protocol, candidate } = await loadImplementations();
  const report = protocol.runDifferentialFuzz({
    seed: options.seed,
    cases: options.cases,
    candidate,
  });

  if (report.divergences.length === 0) {
    console.log(
      `✓ ${report.cases} records canonicalized identically (seed ${report.seed})`,
    );
    return;
  }

  writeReport(report);
  const total = options.write ? persistVectors(report.divergences) : null;
  console.error(
    `✗ ${report.divergences.length} divergence(s) in ${report.cases} records ` +
      `(seed ${report.seed}); see ${REPORT_PATH}`,
  );
  if (total !== null) {
    console.error(`  ${total} vector(s) in ${VECTORS_PATH}`);
  }
  process.exitCode = 1;
}

await main();
