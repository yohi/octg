import { chmodSync, writeFileSync } from "node:fs";

export function writeClientKey(path, key) {
  writeFileSync(path, `${key}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
