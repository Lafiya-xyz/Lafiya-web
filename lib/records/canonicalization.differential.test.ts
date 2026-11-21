import { describe, expect, it } from "vitest";

import vectors from "@/contracts/record-canonicalization-differential-v1.json";
import { canonicalizeEmergencyRecordVerifier } from "./canonicalization";

describe("differential canonicalization vectors (issue #958)", () => {
  for (const vector of vectors.vectors) {
    it(vector.name, () => {
      expect(canonicalizeEmergencyRecordVerifier(vector.input as never)).toBe(
        vector.actual,
      );
    });
  }
});
