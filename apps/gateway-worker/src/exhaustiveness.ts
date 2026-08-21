export function assertNever(value: never, label: string): never {
  throw new TypeError(`Unexpected ${label}: ${String(value)}`);
}
