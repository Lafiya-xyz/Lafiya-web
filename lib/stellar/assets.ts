/**
 * Per-network Stellar asset definitions (issue #898).
 *
 * An asset on Stellar is identified by the pair (code, issuer) -- the code
 * alone is spoofable: anyone can issue a token called "USDC". Every
 * comparison in payout and indexing code must therefore go through
 * `Asset.equals` / `isSameAsset` rather than comparing `asset_code` alone.
 */

export type StellarNetwork = "mainnet" | "testnet";

export interface AssetDefinition {
  readonly code: string;
  readonly issuer: string;
  /** Stellar Asset Contract address for this (code, issuer) pair. */
  readonly sacContractId: string;
}

export interface AssetIdentity {
  readonly code: string;
  readonly issuer: string;
}

/** Circle's USDC issuer on the public network. */
export const MAINNET_USDC_ISSUER =
  "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

/** SDF's testnet USDC issuer. */
export const TESTNET_USDC_ISSUER =
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

export const NETWORK_ASSETS: Readonly<
  Record<StellarNetwork, { readonly USDC: AssetDefinition }>
> = {
  mainnet: {
    USDC: {
      code: "USDC",
      issuer: MAINNET_USDC_ISSUER,
      sacContractId:
        "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    },
  },
  testnet: {
    USDC: {
      code: "USDC",
      issuer: TESTNET_USDC_ISSUER,
      sacContractId:
        "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    },
  },
};

export function networkFromPassphrase(
  passphrase: string | undefined,
): StellarNetwork | null {
  if (!passphrase) return null;
  if (passphrase === "Public Global Stellar Network ; September 2015") {
    return "mainnet";
  }
  if (passphrase === "Test SDF Network ; September 2015") return "testnet";
  return null;
}

/** The canonical USDC definition for a network, or null when unknown. */
export function usdcAssetFor(
  network: StellarNetwork | null,
): AssetDefinition | null {
  return network ? NETWORK_ASSETS[network].USDC : null;
}

/**
 * Typed asset identity. Constructing one requires both a code and an issuer,
 * so a code-only comparison cannot be expressed through this type.
 */
export class Asset {
  private constructor(
    readonly code: string,
    readonly issuer: string,
  ) {}

  static of(code: string, issuer: string): Asset {
    if (!code || !issuer) {
      throw new Error("asset identity requires both a code and an issuer");
    }
    return new Asset(code, issuer);
  }

  static fromDefinition(definition: AssetDefinition): Asset {
    return new Asset(definition.code, definition.issuer);
  }

  equals(other: AssetIdentity | null | undefined): boolean {
    return (
      other != null && other.code === this.code && other.issuer === this.issuer
    );
  }

  /** True when a Horizon balance/operation belongs to this exact asset. */
  matchesHorizonAsset(
    candidate:
      | { asset_type?: string; asset_code?: string; asset_issuer?: string }
      | null
      | undefined,
  ): boolean {
    if (!candidate || candidate.asset_type === "native") return false;
    return this.equals({
      code: candidate.asset_code ?? "",
      issuer: candidate.asset_issuer ?? "",
    });
  }
}

export function isSameAsset(
  a: AssetIdentity | null | undefined,
  b: AssetIdentity | null | undefined,
): boolean {
  return a != null && b != null && a.code === b.code && a.issuer === b.issuer;
}
