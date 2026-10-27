#!/usr/bin/env node
/**
 * scripts/run-doc-snippets.mjs
 *
 * Executes fenced code blocks in docs/ that are annotated with an HTML comment
 * on the line above the fence (blank lines in between are allowed):
 *
 *   <!-- doctest -->           run the block in its language's default mode
 *   <!-- doctest syntax -->    parse only (fragments that reference context)
 *   <!-- doctest exec -->      shell only: execute in a sandbox (see below)
 *
 * Languages and modes (see docs/doc-snippet-tests.md):
 *   ts/typescript  default: type-checked against the repo tsconfig
 *                  syntax:  parsed only (esbuild)
 *   json           parsed with JSON.parse
 *   sql            run against $DOCTEST_DATABASE_URL via psql inside a single
 *                  transaction per file that is always rolled back, after
 *                  scripts/doctest-sql-prelude.sql. Skipped when unset unless
 *                  --require-sql is passed (CI passes it).
 *   bash/sh/env    default/syntax: `bash -n` plus command allowlist check
 *                  exec: allowlist check, then run with an empty environment
 *                  (no secrets) in a temp dir under `unshare --net` (no network)
 *
 * Any command outside SHELL_ALLOWLIST is refused, in every mode.
 *
 * Usage:
 *   node scripts/run-doc-snippets.mjs [--require-sql]
 *
 * Exit codes: 0 all annotated blocks pass, 1 one or more failed.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { transformSync } from "esbuild";

const ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const DOCS = join(ROOT, "docs");
const REQUIRE_SQL = process.argv.includes("--require-sql");
const DATABASE_URL = process.env.DOCTEST_DATABASE_URL;

export const SHELL_ALLOWLIST = new Set([
  "cat",
  "cp",
  "echo",
  "jq",
  "k6",
  "ls",
  "node",
  "npm",
  "npx",
  "psql",
  "supabase",
]);

const ANNOTATION = /^<!--\s*doctest(?:\s+(syntax|exec))?\s*-->$/;
const LANG_ALIASES = { typescript: "ts", sh: "bash", shell: "bash" };

function collectMarkdown(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? collectMarkdown(join(dir, e.name))
        : e.name.endsWith(".md")
          ? [join(dir, e.name)]
          : [],
    )
    .sort();
}

function extractSnippets(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  const snippets = [];
  for (let i = 1; i < lines.length; i++) {
    const fence = /^```(\w*)/.exec(lines[i]);
    if (!fence) continue;
    let above = i - 1;
    while (above > 0 && !lines[above].trim()) above--;
    const match = ANNOTATION.exec(lines[above].trim());
    if (!match) {
      i = lines.findIndex((l, j) => j > i && l.startsWith("```"));
      if (i === -1) break;
      continue;
    }
    const end = lines.findIndex((l, j) => j > i && l.startsWith("```"));
    if (end === -1) throw new Error(`${file}:${i + 1}: unterminated fence`);
    const lang = LANG_ALIASES[fence[1]] ?? fence[1];
    snippets.push({
      file,
      line: i + 1,
      lang,
      mode: match[1] ?? "default",
      code: lines.slice(i + 1, end).join("\n"),
    });
    i = end;
  }
  return snippets;
}

// ─── Shell ────────────────────────────────────────────────────────────────────

/** Returns the command names a shell snippet would invoke. */
export function shellCommands(code) {
  const joined = code.replace(/\\\n/g, " ");
  const commands = [];
  for (const raw of joined.split("\n")) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    const substitutions = [...line.matchAll(/\$\(([^)]*)\)/g)].map((m) => m[1]);
    const outer = line
      .replace(/\$\([^)]*\)/g, "SUBST")
      .replace(/"[^"]*"|'[^']*'/g, "QUOTED");
    for (const segment of [outer, ...substitutions].flatMap((s) =>
      s.split(/&&|\|\||[|;&]/),
    )) {
      const words = segment.trim().split(/\s+/).filter(Boolean);
      const word = words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
      if (word) commands.push(word);
    }
  }
  return commands;
}

function checkShell(snippet) {
  if (snippet.lang === "env") {
    const bad = snippet.code
      .split("\n")
      .filter(
        (l) => l.trim() && !l.startsWith("#") && !/^[A-Z_][A-Z0-9_]*=/.test(l),
      );
    return bad.length ? `not KEY=value: ${bad[0]}` : null;
  }
  const refused = shellCommands(snippet.code).filter(
    (c) => !SHELL_ALLOWLIST.has(c),
  );
  if (refused.length)
    return `refused commands outside allowlist: ${[...new Set(refused)].join(", ")}`;
  const parse = spawnSync("bash", ["-n"], {
    input: snippet.code,
    encoding: "utf8",
  });
  if (parse.status !== 0) return parse.stderr.trim();
  if (snippet.mode !== "exec") return null;

  const dir = mkdtempSync(join(tmpdir(), "doctest-sh-"));
  try {
    const run = spawnSync(
      "unshare",
      ["--net", "--map-root-user", "bash", "-e", "-c", snippet.code],
      {
        cwd: dir,
        env: { PATH: process.env.PATH, HOME: dir },
        encoding: "utf8",
        timeout: 60_000,
      },
    );
    return run.status === 0
      ? null
      : (run.stderr || run.error?.message || `exit ${run.status}`).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─── TypeScript ───────────────────────────────────────────────────────────────

function checkTypeScript(snippets) {
  const errors = new Map();
  for (const s of snippets.filter((s) => s.mode === "syntax")) {
    try {
      transformSync(s.code, {
        loader: "ts",
        format: "esm",
        logLevel: "silent",
      });
    } catch (err) {
      errors.set(s, err.errors?.[0]?.text ?? err.message);
    }
  }

  const typed = snippets.filter((s) => s.mode !== "syntax");
  if (!typed.length) return errors;
  // Inside ROOT so the snippets resolve "@/..." imports like real repo code.
  const dir = mkdtempSync(join(ROOT, ".doctest-"));
  try {
    const files = typed.map((s, i) => {
      const name = `snippet-${i}.ts`;
      writeFileSync(join(dir, name), `${s.code}\nexport {};\n`);
      return name;
    });
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        extends: "../tsconfig.json",
        compilerOptions: { incremental: false, noEmit: true },
        include: files,
      }),
    );
    const run = spawnSync(
      "npx",
      ["tsc", "-p", join(dir, "tsconfig.json"), "--pretty", "false"],
      { cwd: ROOT, encoding: "utf8" },
    );
    for (const line of run.stdout.split("\n")) {
      const m = /snippet-(\d+)\.ts\(\d+,\d+\): (.*)$/.exec(line);
      if (m && !errors.has(typed[Number(m[1])]))
        errors.set(typed[Number(m[1])], m[2]);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return errors;
}

// ─── SQL ──────────────────────────────────────────────────────────────────────

function checkSql(snippets) {
  const errors = new Map();
  const prelude = readFileSync(
    join(ROOT, "scripts/doctest-sql-prelude.sql"),
    "utf8",
  );
  for (const file of new Set(snippets.map((s) => s.file))) {
    const blocks = snippets.filter((s) => s.file === file);
    const script = [
      "\\set ON_ERROR_STOP on",
      "begin;",
      prelude,
      ...blocks.map((b) => b.code),
      "rollback;",
    ].join("\n");
    try {
      execFileSync(
        "psql",
        [DATABASE_URL, "-q", "-X", "-v", "ON_ERROR_STOP=1"],
        { input: script, stdio: ["pipe", "ignore", "pipe"] },
      );
    } catch (err) {
      for (const b of blocks)
        errors.set(b, String(err.stderr || err.message).trim());
    }
  }
  return errors;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main() {
  const snippets = collectMarkdown(DOCS).flatMap(extractSnippets);
  const results = new Map();

  for (const s of snippets) {
    if (["bash", "env"].includes(s.lang)) results.set(s, checkShell(s));
    else if (s.lang === "json") {
      try {
        JSON.parse(s.code);
        results.set(s, null);
      } catch (err) {
        results.set(s, err.message);
      }
    } else if (!["ts", "sql"].includes(s.lang))
      results.set(s, `unsupported language "${s.lang}"`);
  }
  for (const [s, err] of checkTypeScript(
    snippets.filter((s) => s.lang === "ts"),
  ))
    results.set(s, err);
  snippets
    .filter((s) => s.lang === "ts" && !results.has(s))
    .forEach((s) => results.set(s, null));

  const sql = snippets.filter((s) => s.lang === "sql");
  let skipped = 0;
  if (DATABASE_URL) {
    const sqlErrors = checkSql(sql);
    sql.forEach((s) => results.set(s, sqlErrors.get(s) ?? null));
  } else if (REQUIRE_SQL) {
    sql.forEach((s) => results.set(s, "DOCTEST_DATABASE_URL is not set"));
  } else {
    skipped = sql.length;
  }

  let failed = 0;
  for (const [s, err] of results) {
    const where = `${relative(ROOT, s.file)}:${s.line} [${s.lang}${s.mode === "default" ? "" : ` ${s.mode}`}]`;
    if (err) {
      failed++;
      console.error(`✗ ${where}\n    ${err.split("\n").join("\n    ")}`);
    } else {
      console.log(`✓ ${where}`);
    }
  }
  console.log(
    `\n${results.size - failed} passed, ${failed} failed, ${skipped} skipped (sql without DOCTEST_DATABASE_URL)`,
  );
  process.exit(failed ? 1 : 0);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)
)
  main();
