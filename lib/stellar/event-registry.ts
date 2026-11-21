/**
 * Versioned Soroban event topic registry (Issue #902).
 *
 * Soroban contract events carry a topic vector. Lafiya contracts publish the
 * event name and a schema version as the first two topics:
 *
 *   topics = [Symbol("attestation_finalized"), u32(1), ...payload topics]
 *
 * Both indexers (`lib/stellar/verification-indexer` and
 * `lib/stellar/payout-indexer`) decode events through this single registry so
 * a contract upgrade that bumps the topic version can never be silently
 * misread by one indexer and understood by the other. Unknown versions are
 * reported as `unknown_version` and must be quarantined by the caller — never
 * dropped and never decoded with an older decoder.
 */

import { logError } from "@/lib/logging/logger";

export type SorobanEventTopic = string | number | bigint | Uint8Array;

export type SorobanEventEnvelope = {
  /** Contract that emitted the event (C... address). */
  contractId: string;
  /** Raw topic vector as returned by Soroban RPC `getEvents`. */
  topics: readonly SorobanEventTopic[];
  /** Raw event value (scVal already converted to native). */
  value: unknown;
  /** Stable identity used for quarantine bookkeeping. */
  eventId: string;
  ledger: number;
  transactionHash: string;
};

export type DecodedSorobanEvent<T> = {
  contractId: string;
  eventName: string;
  version: number;
  payload: T;
};

export type DecodeResult<T> =
  | { status: "decoded"; event: DecodedSorobanEvent<T> }
  | {
      status: "unknown_version";
      contractId: string;
      eventName: string;
      version: number | null;
      reasonCode: "UNKNOWN_EVENT_VERSION";
    }
  | {
      status: "malformed";
      contractId: string;
      eventName: string | null;
      reasonCode: "MALFORMED_EVENT_TOPIC";
    };

export type EventDecoder<T> = (envelope: SorobanEventEnvelope) => T | null;

type RegistryKey = `${string}:${string}:${number}`;

function registryKey(contractId: string, eventName: string, version: number): RegistryKey {
  return `${contractId}:${eventName}:${version}`;
}

function topicToString(topic: SorobanEventTopic): string | null {
  if (typeof topic === "string") return topic;
  if (topic instanceof Uint8Array) {
    try {
      return new TextDecoder().decode(topic);
    } catch {
      return null;
    }
  }
  return null;
}

function topicToVersion(topic: SorobanEventTopic | undefined): number | null {
  if (typeof topic === "number") {
    return Number.isSafeInteger(topic) && topic > 0 ? topic : null;
  }
  if (typeof topic === "bigint") {
    const asNumber = Number(topic);
    return Number.isSafeInteger(asNumber) && asNumber > 0 ? asNumber : null;
  }
  return null;
}

/**
 * Shared decoder registry keyed by (contract, event name, version).
 * Registering the same key twice is a programming error and throws, so a
 * version can never be silently redefined by a later import.
 */
export class SorobanEventRegistry {
  private readonly decoders = new Map<RegistryKey, EventDecoder<unknown>>();

  register<T>(
    contractId: string,
    eventName: string,
    version: number,
    decoder: EventDecoder<T>,
  ): this {
    const key = registryKey(contractId, eventName, version);
    if (this.decoders.has(key)) {
      throw new Error(`Duplicate Soroban event decoder for ${key}`);
    }
    this.decoders.set(key, decoder as EventDecoder<unknown>);
    return this;
  }

  has(contractId: string, eventName: string, version: number): boolean {
    return this.decoders.has(registryKey(contractId, eventName, version));
  }

  /** Versions registered for a (contract, event name) pair, ascending. */
  versions(contractId: string, eventName: string): number[] {
    const prefix = `${contractId}:${eventName}:`;
    return [...this.decoders.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => Number(key.slice(prefix.length)))
      .sort((a, b) => a - b);
  }

  /**
   * Decode an envelope. Never throws and never falls back to another version:
   * an unregistered version yields `unknown_version` so the caller quarantines
   * it, and a decoder that rejects its own payload yields `malformed`.
   */
  decode<T>(envelope: SorobanEventEnvelope): DecodeResult<T> {
    const eventName = topicToString(envelope.topics[0]);
    if (!eventName) {
      return {
        status: "malformed",
        contractId: envelope.contractId,
        eventName: null,
        reasonCode: "MALFORMED_EVENT_TOPIC",
      };
    }

    const version = topicToVersion(envelope.topics[1]);
    if (version === null) {
      return {
        status: "malformed",
        contractId: envelope.contractId,
        eventName,
        reasonCode: "MALFORMED_EVENT_TOPIC",
      };
    }

    const decoder = this.decoders.get(
      registryKey(envelope.contractId, eventName, version),
    );
    if (!decoder) {
      return {
        status: "unknown_version",
        contractId: envelope.contractId,
        eventName,
        version,
        reasonCode: "UNKNOWN_EVENT_VERSION",
      };
    }

    const payload = decoder(envelope);
    if (payload === null) {
      return {
        status: "malformed",
        contractId: envelope.contractId,
        eventName,
        reasonCode: "MALFORMED_EVENT_TOPIC",
      };
    }

    return {
      status: "decoded",
      event: {
        contractId: envelope.contractId,
        eventName,
        version,
        payload: payload as T,
      },
    };
  }
}

/** Process-wide registry shared by every indexer in this deployment. */
export const sorobanEventRegistry = new SorobanEventRegistry();

/** Quarantine reason codes emitted by the registry. */
export const UNKNOWN_EVENT_VERSION = "UNKNOWN_EVENT_VERSION" as const;
export const MALFORMED_EVENT_TOPIC = "MALFORMED_EVENT_TOPIC" as const;

/**
 * Operator alert raised when an event version has no registered decoder.
 * Value-free: contract, event name and version only — never payload data.
 */
export type UnknownEventVersionAlert = {
  code: typeof UNKNOWN_EVENT_VERSION;
  contractId: string;
  eventName: string;
  version: number | null;
  eventId: string;
  ledger: number;
  transactionHash: string;
};

export type EventVersionAlerter = {
  alert(alert: UnknownEventVersionAlert): Promise<void>;
};

/** Default alert sink: a stable, value-free error log that Sentry picks up. */
export const logEventVersionAlerter: EventVersionAlerter = {
  async alert(alert) {
    logError(
      "Soroban event version alert",
      new Error(`SOROBAN_EVENT_${alert.code}`),
      {
        contractId: alert.contractId,
        eventName: alert.eventName,
        version: alert.version,
        eventId: alert.eventId,
        ledger: alert.ledger,
        transactionHash: alert.transactionHash,
      },
    );
  },
};
