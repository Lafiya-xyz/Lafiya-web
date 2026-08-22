import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const workflowsDirectory = join(process.cwd(), ".github", "workflows");
const references = [];

for (const name of readdirSync(workflowsDirectory).filter((file) =>
  /\.ya?ml$/i.test(file),
)) {
  const contents = readFileSync(join(workflowsDirectory, name), "utf8");
  for (const match of contents.matchAll(
    /^\s*(?:-\s*)?uses:\s*([^\s#]+)@([^\s#]+).*$/gm,
  )) {
    references.push({ file: name, action: match[1], revision: match[2] });
  }
}

const mutable = references.filter(
  ({ action, revision }) =>
    !action.startsWith("./") && !/^[0-9a-f]{40}$/i.test(revision),
);

if (mutable.length > 0) {
  console.error("GitHub Actions must use immutable 40-character commit SHAs:");
  for (const { file, action, revision } of mutable) {
    console.error(`  ${file}: ${action}@${revision}`);
  }
  process.exit(1);
}

console.log(
  `Verified ${references.length} immutable GitHub Action references.`,
);
