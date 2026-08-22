import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const outputDirectory = join(process.cwd(), "artifacts");
const outputFile = join(outputDirectory, "lafiya-web.sbom.cdx.json");

mkdirSync(outputDirectory, { recursive: true });
const sbom = execFileSync(
  "npm",
  ["sbom", "--sbom-format=cyclonedx", "--omit=dev"],
  { cwd: process.cwd(), encoding: "utf8" },
);
writeFileSync(outputFile, sbom);
console.log(`Wrote CycloneDX SBOM to ${outputFile}`);
