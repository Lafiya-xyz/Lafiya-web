/**
 * @module passContent
 *
 * Builds the *content* (not the signed bytes) of a Lafiya wallet pass —
 * shared by both the Apple PassKit builder and the Google Wallet JWT
 * builder so the two platforms can never drift on what they disclose.
 *
 * ## Hard rule: no PHI
 * A wallet pass is cached on the holder's device, outside Supabase RLS and
 * outside our control (Apple/Google infrastructure, iCloud/Google account
 * backups, screenshots). It must contain *only* the capability link — the
 * same non-secret, revocable URL already shown by the QR code — never a
 * name, blood group, allergy, medication, or any other field from
 * `EMERGENCY_FIELD_ALLOWLIST` (lib/emergency/capability.ts). Scanning the
 * link re-checks the capability's live policy (expiry/revocation/view
 * budget) before revealing anything, exactly like the QR path.
 *
 * See docs/wallet-passes.md for the full design and current status.
 */
import "server-only";

/** Must resolve under the public capability-share route, never the legacy
 * permanent `/card/[id]` route — passes are meant to be revocable the same
 * way a capability-share QR is (see /card/c/[token]/page.tsx). */
const CAPABILITY_URL_PATTERN = /^https:\/\/[^/]+\/card\/c\/lafiya_e1_[A-Za-z0-9_-]{43}$/;

/** Loosened to allow http://localhost for local development. */
const CAPABILITY_URL_PATTERN_DEV =
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/card\/c\/lafiya_e1_[A-Za-z0-9_-]{43}$/;

export class InvalidCapabilityUrlError extends Error {
  constructor() {
    super(
      "capabilityUrl must be a Lafiya emergency capability-share link " +
        "(/card/c/<token>), not a permanent card link or an arbitrary URL.",
    );
    this.name = "InvalidCapabilityUrlError";
  }
}

export function assertValidCapabilityUrl(capabilityUrl: string): void {
  if (
    !CAPABILITY_URL_PATTERN.test(capabilityUrl) &&
    !CAPABILITY_URL_PATTERN_DEV.test(capabilityUrl)
  ) {
    throw new InvalidCapabilityUrlError();
  }
}

/**
 * Platform-neutral description of everything a Lafiya wallet pass shows.
 * Both `buildApplePassJson` and `buildGoogleWalletObject` are pure
 * projections of this value — neither may add its own fields.
 */
export interface WalletPassContent {
  /** Fixed branding string, never patient-supplied. */
  organizationName: "Lafiya";
  /** Fixed label — deliberately generic, see module doc. */
  description: "Medical information: scan";
  /** The capability-share URL encoded as the pass's barcode payload. */
  capabilityUrl: string;
  /** Stable identifier for updates/voiding (issue #538 AC 2); derived from
   * the capability, never the underlying patient/profile id. */
  serialNumber: string;
}

/** Serial numbers are derived from the capability token itself (already
 * high-entropy, already revocable) rather than any patient/profile
 * identifier, so voiding a pass never requires looking up who it belongs
 * to. */
export function buildWalletPassContent(capabilityUrl: string): WalletPassContent {
  assertValidCapabilityUrl(capabilityUrl);
  const token = capabilityUrl.slice(capabilityUrl.lastIndexOf("/") + 1);
  return {
    organizationName: "Lafiya",
    description: "Medical information: scan",
    capabilityUrl,
    serialNumber: token,
  };
}

/**
 * The exact JSON shape written into `pass.json` inside the `.pkpass`
 * archive (before signing/zipping). Field names follow Apple's PassKit
 * package format.
 *
 * NOTE: This is a plain data builder with no I/O and no signing — it is
 * intentionally unit-testable without any certificate. The
 * certificate-dependent step is `lib/wallet-passes/apple.ts`.
 */
export function buildApplePassJson(
  content: WalletPassContent,
  passTypeIdentifier: string,
  teamIdentifier: string,
) {
  return {
    formatVersion: 1,
    passTypeIdentifier,
    teamIdentifier,
    organizationName: content.organizationName,
    description: content.description,
    serialNumber: content.serialNumber,
    generic: {
      primaryFields: [
        {
          key: "label",
          label: "Lafiya",
          value: content.description,
        },
      ],
    },
    barcodes: [
      {
        format: "PKBarcodeFormatQR",
        message: content.capabilityUrl,
        messageEncoding: "iso-8859-1",
      },
    ],
  };
}

/**
 * The Google Wallet "generic object" payload embedded in the signed JWT
 * used for the "Add to Google Wallet" save link. Same no-I/O contract as
 * `buildApplePassJson` above.
 */
export function buildGoogleWalletObject(
  content: WalletPassContent,
  issuerId: string,
  classId: string,
) {
  const objectId = `${issuerId}.${content.serialNumber}`;
  return {
    id: objectId,
    classId: `${issuerId}.${classId}`,
    genericType: "GENERIC_TYPE_UNSPECIFIED",
    cardTitle: { defaultValue: { language: "en", value: content.organizationName } },
    subheader: { defaultValue: { language: "en", value: content.description } },
    barcode: {
      type: "QR_CODE",
      value: content.capabilityUrl,
    },
    hexBackgroundColor: "#18181b",
  };
}
