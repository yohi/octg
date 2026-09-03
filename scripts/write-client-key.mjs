import {
  closeSync,
  constants,
  fchmodSync,
  ftruncateSync,
  openSync,
  writeFileSync,
} from "node:fs";

export function writeClientKey(path, key) {
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(fd, 0o600);
    ftruncateSync(fd, 0);
    writeFileSync(fd, `${key}\n`);
  } finally {
    closeSync(fd);
  }
}
