import { describe, expect, it } from "vitest";
import { classify, validate } from "./check-schema-compat.mjs";

const base = {
  type: "object",
  required: ["id"],
  properties: {
    id: { type: "string" },
    kind: { enum: ["a", "b"] },
    count: { type: "integer", minimum: 0, maximum: 10 },
    tags: { type: "array", items: { type: "string" }, maxItems: 5 },
    code: { type: "string", pattern: "^[a-z]+$" },
    version: { const: 1 },
  },
};

function edit(mutate: (schema: typeof base & Record<string, unknown>) => void) {
  const schema = structuredClone(base) as typeof base & Record<string, unknown>;
  mutate(schema);
  return schema;
}

const closed = { ...base, additionalProperties: false };

const cases: [string, object, object, string][] = [
  ["no change", base, base, "compatible"],
  [
    "optional property added (open)",
    base,
    edit((s) => {
      (s.properties as Record<string, unknown>).note = { type: "string" };
    }),
    "compatible",
  ],
  [
    "optional property added (closed)",
    closed,
    {
      ...closed,
      properties: { ...closed.properties, note: { type: "string" } },
    },
    "backward-only",
  ],
  [
    "optional property removed (open)",
    base,
    edit((s) => {
      delete (s.properties as Record<string, unknown>).code;
    }),
    "compatible",
  ],
  [
    "optional property removed (closed)",
    closed,
    {
      ...closed,
      properties: {
        id: base.properties.id,
        kind: base.properties.kind,
        count: base.properties.count,
        tags: base.properties.tags,
        version: base.properties.version,
      },
    },
    "forward-only",
  ],
  [
    "required field added",
    base,
    edit((s) => {
      s.required = ["id", "kind"];
    }),
    "forward-only",
  ],
  [
    "required field added (closed, unknown prop)",
    closed,
    { ...closed, required: ["id", "extra"] },
    "breaking",
  ],
  [
    "required field removed",
    base,
    edit((s) => {
      s.required = [];
    }),
    "backward-only",
  ],
  [
    "enum value added",
    base,
    edit((s) => {
      s.properties.kind.enum = ["a", "b", "c"];
    }),
    "backward-only",
  ],
  [
    "enum value removed",
    base,
    edit((s) => {
      s.properties.kind.enum = ["a"];
    }),
    "forward-only",
  ],
  [
    "enum value replaced",
    base,
    edit((s) => {
      s.properties.kind.enum = ["a", "c"];
    }),
    "breaking",
  ],
  [
    "type widened",
    base,
    edit((s) => {
      (s.properties.id as { type: unknown }).type = ["string", "number"];
    }),
    "backward-only",
  ],
  [
    "type changed",
    base,
    edit((s) => {
      (s.properties.id as { type: unknown }).type = "number";
    }),
    "breaking",
  ],
  ["additionalProperties closed", base, closed, "forward-only"],
  ["additionalProperties opened", closed, base, "backward-only"],
  [
    "minimum tightened",
    base,
    edit((s) => {
      s.properties.count.minimum = 1;
    }),
    "forward-only",
  ],
  [
    "maximum loosened",
    base,
    edit((s) => {
      s.properties.count.maximum = 20;
    }),
    "backward-only",
  ],
  [
    "maxItems tightened",
    base,
    edit((s) => {
      s.properties.tags.maxItems = 2;
    }),
    "forward-only",
  ],
  [
    "array item type changed",
    base,
    edit((s) => {
      s.properties.tags.items.type = "number";
    }),
    "breaking",
  ],
  [
    "pattern changed",
    base,
    edit((s) => {
      s.properties.code.pattern = "^[0-9]+$";
    }),
    "breaking",
  ],
  [
    "pattern removed",
    base,
    edit((s) => {
      delete (s.properties.code as { pattern?: string }).pattern;
    }),
    "backward-only",
  ],
  [
    "const changed (version bump)",
    base,
    edit((s) => {
      s.properties.version.const = 2;
    }),
    "breaking",
  ],
  [
    "mixed backward and forward changes",
    base,
    edit((s) => {
      s.required = ["id", "kind"];
      s.properties.count.maximum = 20;
    }),
    "breaking",
  ],
];

describe("classify", () => {
  it.each(cases)("%s → %s", (_name, before, after, verdict) => {
    expect(classify(before, after).verdict).toBe(verdict);
  });

  it("covers at least 15 change types", () => {
    expect(cases.length).toBeGreaterThanOrEqual(15);
  });
});

describe("validate", () => {
  it("accepts a conforming document", () => {
    expect(
      validate(base, { id: "x", kind: "a", count: 3, tags: ["t"], version: 1 }),
    ).toEqual([]);
  });

  it("reports missing required fields, enum, bounds and closed objects", () => {
    expect(validate(closed, { kind: "z", count: 11, extra: true })).toEqual([
      '$: missing required "id"',
      "$.kind: value not in enum",
      "$.count: above maximum",
      '$: unexpected "extra"',
    ]);
  });
});
