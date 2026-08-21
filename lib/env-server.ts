import "server-only";
import { z } from "zod";
import { clientEnvSchema } from "./env";

export const serverEnvSchema = clientEnvSchema
  .extend({
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
    STELLAR_NETWORK_PASSPHRASE: z.string().min(1),
    SOROBAN_RPC_URL: z.url(),
    ATTESTATION_CONTRACT_ID: z.string().optional(),
    // Mock attestations are an explicit development/test switch. They are
    // never enabled implicitly by a missing contract in a production process.
    ATTESTATION_MOCK_MODE: z.enum(["true", "false"]).default("false"),
    STELLAR_HORIZON_URL: z.url().optional(),
    STELLAR_USDC_ISSUER: z.string().optional(),
    CHW_INCENTIVE_POOL_ADDRESS: z.string().optional(),
    PAYOUT_INDEXER_START_LEDGER: z.coerce.number().int().positive().optional(),
    PAYOUT_INDEXER_START_PAYMENT_CURSOR: z.string().optional(),
    PAYOUT_INDEXER_CRON_SECRET: z.string().min(16).optional(),
  })
  .superRefine((env, context) => {
    if (process.env.NODE_ENV === "production") {
      if (!env.ATTESTATION_CONTRACT_ID) {
        context.addIssue({
          code: "custom",
          path: ["ATTESTATION_CONTRACT_ID"],
          message: "ATTESTATION_CONTRACT_ID is required in production",
        });
      }
      if (env.ATTESTATION_MOCK_MODE === "true") {
        context.addIssue({
          code: "custom",
          path: ["ATTESTATION_MOCK_MODE"],
          message: "Mock attestations are forbidden in production",
        });
      }
    }
  });

export const serverEnv = serverEnvSchema.parse({
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  STELLAR_NETWORK_PASSPHRASE: process.env.STELLAR_NETWORK_PASSPHRASE,
  SOROBAN_RPC_URL: process.env.SOROBAN_RPC_URL,
  ATTESTATION_CONTRACT_ID: process.env.ATTESTATION_CONTRACT_ID,
  ATTESTATION_MOCK_MODE:
    process.env.ATTESTATION_MOCK_MODE ??
    (process.env.NODE_ENV === "test" ? "true" : "false"),
  STELLAR_HORIZON_URL: process.env.STELLAR_HORIZON_URL,
  STELLAR_USDC_ISSUER: process.env.STELLAR_USDC_ISSUER,
  CHW_INCENTIVE_POOL_ADDRESS: process.env.CHW_INCENTIVE_POOL_ADDRESS,
  PAYOUT_INDEXER_START_LEDGER: process.env.PAYOUT_INDEXER_START_LEDGER,
  PAYOUT_INDEXER_START_PAYMENT_CURSOR:
    process.env.PAYOUT_INDEXER_START_PAYMENT_CURSOR,
  PAYOUT_INDEXER_CRON_SECRET: process.env.PAYOUT_INDEXER_CRON_SECRET,
});
