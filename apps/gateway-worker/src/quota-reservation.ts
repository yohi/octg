import type { ReserveResult } from "@octg/shared";
import { safeErrorDetails } from "./error-details";

export type ResolvedReserve = { readonly kind: "resolved"; readonly result: ReserveResult };
export type UnknownReserve = { readonly kind: "unknown" };
export type ReserveOutcome = ResolvedReserve | UnknownReserve;

export type ReserveRpc = (
  requestId: string,
  tokens: number,
  upperBoundTokens: number,
  idempotencyKey?: string,
  clientId?: string,
) => Promise<ReserveResult>;

export interface ReserveArguments {
  readonly requestId: string;
  readonly tokens: number;
  readonly upperBoundTokens: number;
  readonly idempotencyKey?: string;
  readonly clientId?: string;
}

async function callReserve(reserve: ReserveRpc, args: ReserveArguments): Promise<ReserveResult> {
  return reserve(
    args.requestId,
    args.tokens,
    args.upperBoundTokens,
    args.idempotencyKey,
    args.clientId,
  );
}

export async function reserveFailClosed(
  reserve: ReserveRpc,
  args: ReserveArguments,
): Promise<ReserveOutcome> {
  try {
    return { kind: "resolved", result: await callReserve(reserve, args) };
  } catch (error) {
    console.warn("quota_reservation.retry_failed", { requestId: args.requestId, error: safeErrorDetails(error) });
    try {
      return { kind: "resolved", result: await callReserve(reserve, args) };
    } catch (error) {
      console.error("quota_reservation.unknown", { requestId: args.requestId, error: safeErrorDetails(error) });
      return { kind: "unknown" };
    }
  }
}
