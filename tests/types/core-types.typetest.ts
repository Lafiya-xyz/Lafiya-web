import type {
  Database,
  EmergencyCardRow,
  ProfileSecretRow,
} from "@/lib/supabase/types";
import type { ProtocolErrorCode, TrustState } from "@/lib/chw-protocol/types";
import { toUsdcAmount, type UsdcAmount } from "@/lib/types/brand";
import type { Equal, Expect } from "./assert";

// get_emergency_card() public RPC contract. Changing the SQL return shape
// without updating this exact key list fails typecheck.
type CardRpc = Database["public"]["Functions"]["get_emergency_card"];

export type _CardArgs = Expect<Equal<CardRpc["Args"], { p_card_id: string }>>;
export type _CardReturns = Expect<
  Equal<CardRpc["Returns"], EmergencyCardRow[]>
>;
export type _CardKeys = Expect<
  Equal<
    keyof EmergencyCardRow,
    | "name"
    | "age"
    | "photo_url"
    | "blood_group"
    | "genotype"
    | "allergies"
    | "medications"
    | "chronic_conditions"
    | "emergency_contacts"
    | "language"
    | "disclosure_states"
    | "schema_version"
    | "offline_cache_allowed"
    | "trust_state"
    | "trust_updated_at"
    | "record_updated_at"
    | "authorization_expires_at"
  >
>;
export type _CardNullableName = Expect<
  Equal<EmergencyCardRow["name"], string | null>
>;
export type _CardOfflineFlag = Expect<
  Equal<EmergencyCardRow["offline_cache_allowed"], boolean>
>;

// Sensitive table: profile_secrets rows must keep their exact shape.
export type _SecretRow = Expect<
  Equal<
    Database["public"]["Tables"]["profile_secrets"]["Row"],
    ProfileSecretRow
  >
>;
export type _SecretValue = Expect<Equal<ProfileSecretRow["secret"], string>>;

// The public card must never expose the secret or clinician-only policy.
export type _NoSecretOnCard = Expect<
  Equal<Extract<keyof EmergencyCardRow, "secret">, never>
>;
export type _NoClinicianPolicyOnCard = Expect<
  Equal<Extract<keyof EmergencyCardRow, "clinician_disclosure_policy">, never>
>;

// Key domain unions.
export type _TrustState = Expect<
  Equal<
    TrustState,
    | "unverified"
    | "submitted"
    | "confirming"
    | "verified"
    | "expired"
    | "revoked"
    | "superseded"
    | "conflicted"
    | "unavailable"
  >
>;
export type _ErrorCodeIsUnion = Expect<
  Equal<string extends ProtocolErrorCode ? true : false, false>
>;

// Negative tests: branded money resists raw values.
export const usdc: UsdcAmount = toUsdcAmount("412.5000000");
// @ts-expect-error raw string is not a UsdcAmount
export const rawString: UsdcAmount = "412.5000000";
// @ts-expect-error raw number is not a UsdcAmount
export const rawNumber: UsdcAmount = 412.5;
// @ts-expect-error unknown RPC args are rejected
export const badArgs: CardRpc["Args"] = { p_card_id: "x", p_extra: 1 };
// @ts-expect-error card name cannot be assigned a number
export const badName: EmergencyCardRow["name"] = 1;
