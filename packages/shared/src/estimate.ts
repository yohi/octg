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
