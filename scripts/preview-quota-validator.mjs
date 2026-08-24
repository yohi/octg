// Tier 3 provider ceilings documented in docs/DEPLOY_FROM_TEMPLATE.md and
// mirrored by packages/shared/src/pool.ts.
export const PROVIDER_QUOTA_CEILINGS = Object.freeze({
  STANDARD: 1_000_000,
  MINI: 10_000_000,
});

const POOLS = ["STANDARD", "MINI"];

const isNonNegativeSafeInteger = (value) => Number.isSafeInteger(value) && value >= 0;

export function assertPreviewQuotaAllocation({ production, preview }) {
  for (const pool of POOLS) {
    const productionLimit = production?.[pool];
    const previewLimit = preview?.[pool];
    const providerCeiling = PROVIDER_QUOTA_CEILINGS[pool];
    if (!isNonNegativeSafeInteger(productionLimit) || !isNonNegativeSafeInteger(previewLimit)) {
      throw new TypeError(`${pool} quota allocation must be a non-negative safe integer`);
    }
    if (productionLimit + previewLimit > providerCeiling) {
      throw new Error(`${pool} quota allocation exceeds provider ceiling`);
    }
  }
}
