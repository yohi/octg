export type RelayInvocationClass = "ingress" | "decision" | "activation" | "renewal" | "terminal";

type RelayInvocationBase = {
  readonly invocationClass: RelayInvocationClass;
  readonly revisionId: string;
  readonly requestId?: string;
  readonly workloadClass?: string;
  readonly concurrency?: number;
};

export type RelayInvocationEvent =
  | (RelayInvocationBase & { readonly phase: "start"; readonly outcome?: never })
  | (RelayInvocationBase & { readonly phase: "finish"; readonly outcome: string });

export function emitRelayInvocation(event: RelayInvocationEvent): void {
  console.info({
    event: "octg.relay_invocation",
    invocationClass: event.invocationClass,
    revisionId: event.revisionId,
    ...(event.requestId === undefined ? {} : { requestId: event.requestId }),
    ...(event.workloadClass === undefined ? {} : { workloadClass: event.workloadClass }),
    ...(event.concurrency === undefined ? {} : { concurrency: event.concurrency }),
    phase: event.phase,
    ...(event.phase === "finish" ? { outcome: event.outcome } : {}),
  });
}
