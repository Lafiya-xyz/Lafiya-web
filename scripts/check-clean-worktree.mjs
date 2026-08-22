import { spawnSync } from "node:child_process";

const status = spawnSync(
  "git",
  ["status", "--porcelain=v1", "--untracked-files=no"],
  { encoding: "utf8" },
);

if (status.status !== 0) {
  console.error(status.stderr || "Unable to inspect the git worktree.");
  process.exit(status.status ?? 1);
}

if (status.stdout.trim()) {
  console.error("Build or generation changed tracked source files:");
  console.error(status.stdout.trim());
  process.exit(1);
}

console.log("Tracked worktree is clean after build.");
