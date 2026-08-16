import type { ReserveResult } from "@octg/shared";

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
  } catch {
    try {
      return { kind: "resolved", result: await callReserve(reserve, args) };
    } catch {
      return { kind: "unknown" };
    }
  }
}
