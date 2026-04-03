import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export function makeTempDir(prefix = "pulseed-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function cleanupTempDir(dir: string): void {
  for (let i = 0; i < 3; i++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (e: unknown) {
      if (i === 2 || (e as NodeJS.ErrnoException).code !== "ENOTEMPTY") throw e;
    }
  }
}
