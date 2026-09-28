export function safetyMargin(estimatedInput: number, remainingRatio: number): number {
  return remainingRatio <= 0.2
    ? Math.max(512, Math.ceil(estimatedInput * 0.05))
    : Math.max(256, Math.ceil(estimatedInput * 0.02));
}

export function upperBoundOf(estimatedInput: number, maxOutput: number): number {
  return estimatedInput + maxOutput + Math.max(512, Math.ceil(estimatedInput * 0.05));
}

export type OutputDecision =
  | { action: "proceed"; maxOutputTokens: number }
  | { action: "reject" };

export function decideOutput(args: {
  estimatedInput: number;
  maxOutputTokens: number;
  margin: number;
  remaining: number;
  outputLimitMode: "REJECT" | "CLAMP";
}): OutputDecision {
  const { estimatedInput, maxOutputTokens, margin, remaining, outputLimitMode } = args;
  if (estimatedInput + maxOutputTokens + margin <= remaining) {
    return { action: "proceed", maxOutputTokens };
  }
  if (outputLimitMode === "CLAMP") {
    const candidate = remaining - estimatedInput - margin;
    if (candidate > 0) return { action: "proceed", maxOutputTokens: candidate };
  }
  return { action: "reject" };
}


export interface RelayTokenBudgetArguments {
  readonly estimatedInput: number;
  readonly maxOutputTokens: number;
  readonly remaining: number;
  readonly limit: number;
  readonly outputLimitMode: "REJECT" | "CLAMP";
}

export type RelayTokenBudgetOutcome =
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

function validNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validRelayBudgetArguments(args: RelayTokenBudgetArguments): boolean {
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

export function resolveRelayTokenBudget(args: RelayTokenBudgetArguments): RelayTokenBudgetOutcome {
  if (!validRelayBudgetArguments(args)) return { kind: "arithmetic_error" };

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
        throw new Error(`Unknown output decision action: ${(output as { readonly action: string }).action}`);
    }
  } catch {
    return { kind: "arithmetic_error" };
  }
}