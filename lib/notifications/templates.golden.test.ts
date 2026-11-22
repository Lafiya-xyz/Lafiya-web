import {
  getTemplateDefinitions,
  renderTemplate,
  SMS_SEGMENT_BUDGETS,
  SUPPORTED_LOCALES,
  TEMPLATE_IDS,
  templateVariables,
} from "./templates";
import { smsSegments } from "./sms-segments";

/**
 * Golden tests for every notification template in every locale (issue #955).
 *
 * Renders each template with representative (non-PHI) variables, snapshots the
 * rendered subject/body, and enforces the per-template SMS segment budget so CI
 * fails when a translation grows past its budget.
 */

/** Representative values for the non-PHI variables used by the templates. */
const SAMPLE_VARS: Record<string, string> = {
  device_type: "Android phone",
  timestamp_utc: "2026-11-25 09:30",
  access_time_utc: "2026-11-25 09:30",
  completed_at_utc: "2026-11-25 09:30",
  requested_at_utc: "2026-11-25 09:30",
};

const definitions = getTemplateDefinitions();

/** Representative (non-PHI) variables for a template/locale pair. */
function sampleVars(
  templateId: (typeof TEMPLATE_IDS)[number],
  locale: (typeof SUPPORTED_LOCALES)[number],
) {
  const message = definitions[templateId][locale] ?? { body: "" };
  return Object.fromEntries(
    templateVariables(message).map((key) => [key, SAMPLE_VARS[key] ?? `{${key}}`]),
  );
}

describe("notification template golden snapshots", () => {
  for (const templateId of TEMPLATE_IDS) {
    for (const locale of SUPPORTED_LOCALES) {
      it(`${templateId} [${locale}]`, () => {
        expect(
          renderTemplate(templateId, locale, sampleVars(templateId, locale)),
        ).toMatchSnapshot();
      });
    }
  }
});

describe("notification template locale coverage", () => {
  for (const templateId of TEMPLATE_IDS) {
    it(`${templateId} defines every supported locale`, () => {
      expect(Object.keys(definitions[templateId]).sort()).toEqual(
        [...SUPPORTED_LOCALES].sort(),
      );
    });
  }
});

describe("notification template SMS segment budgets", () => {
  for (const templateId of TEMPLATE_IDS) {
    for (const locale of SUPPORTED_LOCALES) {
      it(`${templateId} [${locale}] fits its ${SMS_SEGMENT_BUDGETS[templateId]}-segment budget`, () => {
        const { body } = renderTemplate(
          templateId,
          locale,
          sampleVars(templateId, locale),
        );
        const info = smsSegments(body);
        expect(
          info.segments,
          `${templateId} [${locale}] is ${info.segments} ${info.encoding} segment(s) ` +
            `(${info.length} chars), budget ${SMS_SEGMENT_BUDGETS[templateId]}`,
        ).toBeLessThanOrEqual(SMS_SEGMENT_BUDGETS[templateId]);
      });
    }
  }
});
