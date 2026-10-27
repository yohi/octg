import type { RequestEntry } from "@octg/shared";
import type { RelayGrant } from "../src/relay-grant";

export interface FixtureRecords {
  readonly grant: RelayGrant | undefined;
  readonly entry: RequestEntry | undefined;
}

export interface FixtureMutation {
  readonly name: string;
  readonly change: (records: FixtureRecords) => FixtureRecords;
}

export function fixturePredicateMutations(
  canonicalGrant: RelayGrant,
  canonicalEntry: RequestEntry,
): readonly FixtureMutation[] {
  const changeGrant = (name: string, change: (grant: RelayGrant) => RelayGrant): FixtureMutation => ({
    name,
    change: (records) => ({ grant: change(canonicalGrant), entry: records.entry }),
  });
  const changeEntry = (name: string, change: (entry: RequestEntry) => RequestEntry): FixtureMutation => ({
    name,
    change: (records) => ({ grant: records.grant, entry: change(canonicalEntry) }),
  });
  return [
    changeGrant("grant.clientId", (grant) => ({ ...grant, clientId: "other-client" })),
    changeGrant("grant.model", (grant) => ({ ...grant, model: "other-model" })),
    changeGrant("grant.pool", (grant) => ({ ...grant, pool: "MINI" })),
    changeGrant("grant.admissionUtcDay", (grant) => ({ ...grant, admissionUtcDay: "2026-10-02" })),
    changeGrant("grant.idempotencyKeyHash", (grant) => ({ ...grant, idempotencyKeyHash: "0".repeat(64) })),
    changeGrant("admission.reservedTokens", (grant) => ({ ...grant, admission: { ...grant.admission, reservedTokens: 1 } })),
    changeGrant("admission.upperBoundTokens", (grant) => ({ ...grant, admission: { ...grant.admission, upperBoundTokens: 1 } })),
    changeGrant("admission.maxOutputTokens", (grant) => ({ ...grant, admission: { ...grant.admission, maxOutputTokens: 1 } })),
    changeGrant("admission.cacheEnabled", (grant) => ({ ...grant, admission: { ...grant.admission, cacheEnabled: true } })),
    changeGrant("metadata.estimatedInputTokens", (grant) => ({ ...grant, admission: { ...grant.admission, metadata: { ...grant.admission.metadata, estimatedInputTokens: 1 } } })),
    changeGrant("metadata.maxOutputTokens", (grant) => ({ ...grant, admission: { ...grant.admission, metadata: { ...grant.admission.metadata, maxOutputTokens: 1 } } })),
    changeGrant("metadata.inputBytes", (grant) => ({ ...grant, admission: { ...grant.admission, metadata: { ...grant.admission.metadata, inputBytes: 1 } } })),
    changeGrant("metadata.rawBodyBytes", (grant) => ({ ...grant, admission: { ...grant.admission, metadata: { ...grant.admission.metadata, rawBodyBytes: 1 } } })),
    changeGrant("metadata.isToolUse", (grant) => ({ ...grant, admission: { ...grant.admission, metadata: { ...grant.admission.metadata, isToolUse: true } } })),
    changeGrant("metadata.stream", (grant) => ({ ...grant, admission: { ...grant.admission, metadata: { ...grant.admission.metadata, stream: true } } })),
    { name: "request entry presence", change: ({ grant }) => ({ grant, entry: undefined }) },
    changeEntry("request entry idempotencyKey", (entry) => ({ ...entry, idempotencyKey: "key" })),
    changeEntry("request entry tokens", (entry) => ({ ...entry, tokens: 1 })),
    changeEntry("request entry upperBoundTokens", (entry) => ({ ...entry, upperBoundTokens: 1 })),
    changeEntry("request entry reservedTokens", (entry) => ({ ...entry, reservedTokens: 1 })),
    { name: "grant presence", change: ({ entry }) => ({ grant: undefined, entry }) },
  ];
}
