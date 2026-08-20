import { decideOutput, safetyMargin, upperBoundOf } from "@octg/shared";

export interface TokenBudgetArguments {
  readonly estimatedInput: number;
  readonly maxOutputTokens: number;
  readonly remaining: number;
  readonly limit: number;
  readonly outputLimitMode: "REJECT" | "CLAMP";
}

export type TokenBudgetOutcome =
  | {
      readonly kind: "resolved";
      readonly margin: number;
      readonly upperBound: number;
      readonly maxOutputTokens: number;
      readonly reservation: number;
    }
  | { readonly kind: "request_too_large" }
  | { readonly kind: "quota_exceeded" }
  | { readonly kind: "arithmetic_error" };

export function resolveTokenBudget(args: TokenBudgetArguments): TokenBudgetOutcome {
  if (!validArguments(args)) return { kind: "arithmetic_error" };

  try {
    const margin = safetyMargin(args.estimatedInput, args.remaining / args.limit);
    const upperBound = upperBoundOf(args.estimatedInput, args.maxOutputTokens);
    if (!validNonNegativeSafeInteger(margin) || !validNonNegativeSafeInteger(upperBound)) {
      return { kind: "arithmetic_error" };
    }
    if (upperBound > args.limit) return { kind: "request_too_large" };

    const output = decideOutput({
      estimatedInput: args.estimatedInput,
      maxOutputTokens: args.maxOutputTokens,
      margin,
      remaining: args.remaining,
      outputLimitMode: args.outputLimitMode,
    });
    switch (output.action) {
      case "reject":
        return { kind: "quota_exceeded" };
      case "proceed": {
        const maxOutputTokens = output.maxOutputTokens;
        const reservation = args.estimatedInput + maxOutputTokens + margin;
        return validNonNegativeSafeInteger(maxOutputTokens) && validNonNegativeSafeInteger(reservation)
          ? { kind: "resolved", margin, upperBound, maxOutputTokens, reservation }
          : { kind: "arithmetic_error" };
      }
      default:
        return assertNever(output);
    }
  } catch (error) {
    // no-excuse-ok: catch — invalid arithmetic is a typed fail-closed outcome.
    void error;
    return { kind: "arithmetic_error" };
  }
}

function validArguments(args: TokenBudgetArguments): boolean {
  return (
    validNonNegativeSafeInteger(args.estimatedInput) &&
    validNonNegativeSafeInteger(args.maxOutputTokens) &&
    validNonNegativeSafeInteger(args.remaining) &&
    Number.isSafeInteger(args.limit) &&
    args.limit > 0 &&
    args.remaining <= args.limit &&
    (args.outputLimitMode === "REJECT" || args.outputLimitMode === "CLAMP")
  );
}

function validNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertNever(value: never): never {
  throw new TypeError(`Unexpected output decision: ${String(value)}`);
}
