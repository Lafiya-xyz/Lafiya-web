/**
 * Localized notification template registry (issue #625).
 *
 * Templates are typed ICU-style messages with named `{variable}` placeholders.
 * A PHI lint is enforced at render time: any variable key in the PHI_BLOCKLIST
 * is rejected before the message is passed to a provider.
 *
 * ## Adding a template
 * 1. Add an entry to TEMPLATES for all four locales (en, ha, ig, yo).
 * 2. Ensure no variable key from PHI_BLOCKLIST appears in any template string.
 * 3. Export a `TemplateId` union member.
 *
 * ## Locale fallback
 * If a requested locale is absent for a template, `en` is used as the fallback.
 */

import type { RenderedMessage, SupportedLocale } from "./types";

// ─── PHI lint ───────────────────────────────────────────────────────────────

/**
 * Variable keys that must never appear in notification payloads sent to
 * third-party providers.  Checked at render time; an error is thrown if any
 * of these appear in `vars`.
 */
const PHI_BLOCKLIST = new Set([
  "name",
  "date_of_birth",
  "dob",
  "blood_group",
  "genotype",
  "allergies",
  "medications",
  "chronic_conditions",
  "emergency_contacts",
  "photo_url",
  "language",
  "age",
  "phone",
  "email",
  "card_id",
  "capability",
  "token",
  "commitment",
  "user_id",
]);

function assertNoPhi(vars: Record<string, string>): void {
  for (const key of Object.keys(vars)) {
    if (PHI_BLOCKLIST.has(key.toLowerCase())) {
      throw new Error(
        `Notification template variable "${key}" is a PHI/sensitive field and ` +
          `must not be sent to notification providers.`,
      );
    }
  }
}

// ─── Template definitions ───────────────────────────────────────────────────

type LocaleMap = Partial<Record<SupportedLocale, RenderedMessage>>;
type TemplateMap = Record<string, LocaleMap>;

/**
 * Notification templates keyed by template ID then locale.
 *
 * Only non-PHI, non-sensitive variables are permitted in template strings.
 * Variables are interpolated with {variable_name} syntax.
 */
const TEMPLATES: TemplateMap = {
  /**
   * Sent when a security event (sign-in from new device) is detected.
   * Variables: {device_type}, {timestamp_utc}
   */
  "security.new_signin": {
    en: {
      subject: "New sign-in to your Lafiya account",
      body: "A new sign-in was detected on {device_type} at {timestamp_utc} UTC. If this was not you, please secure your account immediately.",
    },
    ha: {
      subject: "An shiga sabon Lafiya account naka",
      body: "An gano shiga sabon {device_type} a {timestamp_utc} UTC. Idan ba kai ba, da fatan a tsare asusun ka nan take.",
    },
    ig: {
      subject: "Ọbịbịa ọhụrụ n'akanti Lafiya gị",
      body: "Achọpụtara ọbịbịa ọhụrụ na {device_type} na {timestamp_utc} UTC. Ọ bụrụ na ị nweghị ihe ọ bụla, biko chebe akanti gị ozugbo.",
    },
    yo: {
      subject: "Ìwọlé tuntun sí àkántì Lafiya rẹ",
      body: "A ṣàwárí ìwọlé tuntun lórí {device_type} ní {timestamp_utc} UTC. Tí ó kò bá jẹ́ ìwọ, jọ̀wọ́ dáàbò bo àkántì rẹ lẹ́sẹ̀kẹsẹ̀.",
    },
  },

  /**
   * Sent to emergency contacts when a card is accessed.
   * Variables: {access_time_utc}
   * Note: the contact's name is never included to avoid transmitting PHI.
   */
  "emergency.card_accessed": {
    en: {
      body: "A Lafiya emergency card was accessed at {access_time_utc} UTC. No medical data was sent to us.",
    },
    ha: {
      body: "An duba katin gaggawa na Lafiya a {access_time_utc} UTC. Ba a aika mana da bayanan lafiya ba.",
    },
    ig: {
      body: "Enyere ahụike Lafiya ihe oge mberede na {access_time_utc} UTC. Ezigharịghị anyị data ahụike ọ bụla.",
    },
    yo: {
      body: "Káàdì pàjáwìrì Lafiya kan ni wọ́n wọlé rẹ ni {access_time_utc} UTC. A kò firanṣẹ data ìlera kankan sí wa.",
    },
  },

  /**
   * Sent when a CHW completes a verification.
   * Variables: {completed_at_utc}
   */
  "chw.verification_complete": {
    en: {
      subject: "Your Lafiya record has been verified",
      body: "A community health worker completed verification of your record at {completed_at_utc} UTC.",
    },
    ha: {
      subject: "An tabbatar da rikodin Lafiya naka",
      body: "Ma'aikacin lafiya na al'umma ya tabbatar da rikodinku a {completed_at_utc} UTC.",
    },
    ig: {
      subject: "Ejiri ndekọ Lafiya gị gosipụta",
      body: "Onye ọrụ ahụike obodo mezụrụ nkwado nke ndekọ gị na {completed_at_utc} UTC.",
    },
    yo: {
      subject: "Wọ́n ti fọwọ́ sí àkọsílẹ̀ Lafiya rẹ",
      body: "Òṣìṣẹ́ ìlera àwùjọ parí ìfọwọ́sí àkọsílẹ̀ rẹ ní {completed_at_utc} UTC.",
    },
  },

  /**
   * Sent when a reattestation request requires attention.
   * Variables: {requested_at_utc}
   */
  "chw.reattestation_requested": {
    en: {
      subject: "Verification request received",
      body: "A request to verify a Lafiya record was received at {requested_at_utc} UTC and is awaiting review.",
    },
    ha: {
      subject: "An karbi bukata don tabbatarwa",
      body: "An karbi bukata don tabbatar da rikodin Lafiya a {requested_at_utc} UTC kuma yana jiran dubawa.",
    },
    ig: {
      subject: "Nnọchite anya maka nkwado natara",
      body: "A natara arịọ iji gosipụta ndekọ Lafiya na {requested_at_utc} UTC ma ọ na-atọ ule.",
    },
    yo: {
      subject: "Gba ìbéèrè fọwọ́ sí",
      body: "A gba ìbéèrè lati fọwọ́ sí àkọsílẹ̀ Lafiya ní {requested_at_utc} UTC, ó sì ń dúró fún àgbeyẹwò.",
    },
  },
};

export type TemplateId = keyof typeof TEMPLATES;

// ─── Renderer ───────────────────────────────────────────────────────────────

/**
 * Renders a notification template to a provider-ready message.
 *
 * @throws if the template ID is unknown, the locale has no definition, or
 *   any variable key is on the PHI blocklist.
 */
export function renderTemplate(
  templateId: TemplateId,
  locale: SupportedLocale,
  vars: Record<string, string>,
): RenderedMessage {
  assertNoPhi(vars);

  const localeMap = TEMPLATES[templateId];
  if (!localeMap) {
    throw new Error(`Unknown notification template: "${templateId}"`);
  }

  // Locale fallback: requested locale → "en".
  const message = localeMap[locale] ?? localeMap["en"];
  if (!message) {
    throw new Error(
      `Template "${templateId}" has no definition for locale "${locale}" and no "en" fallback.`,
    );
  }

  const interpolate = (str: string) =>
    str.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? `{${key}}`);

  return {
    subject: message.subject ? interpolate(message.subject) : undefined,
    body: interpolate(message.body),
  };
}
