import type { File, Reporter, Task } from "vitest";
import { findQuarantineEntry, quarantineLabel } from "../quarantine";

/**
 * Vitest reporter that downgrades failures of quarantined tests (issue #962).
 *
 * Quarantined tests still run; when they fail the reporter prints a warning and
 * rewrites the task result to `pass` so the run (and the merge queue) is not
 * blocked. The quarantine list lives in tests/quarantine.json.
 */
export default class QuarantineReporter implements Reporter {
  private downgraded: string[] = [];

  onFinished(files: File[] = []) {
    const walk = (task: Task) => {
      for (const child of task.tasks ?? []) {
        if (child.type === "test" || child.type === "custom") {
          const result = child.result;
          if (!result || result.state !== "fail") continue;
          const file = child.file?.name ?? "";
          const entry = findQuarantineEntry(file, child.name);
          if (!entry) continue;
          result.state = "pass";
          result.errors = [];
          this.downgraded.push(`${file}: ${child.name}`);
          console.warn(
            `::warning::Quarantined test failed, not blocking: ${file} :: ${child.name} — ${quarantineLabel(entry)}`,
          );
        } else {
          walk(child);
        }
      }
    };
    files.forEach(walk);
    if (this.downgraded.length > 0) {
      console.warn(
        `Quarantine: ${this.downgraded.length} failing quarantined test(s) ignored.`,
      );
    }
  }
}
