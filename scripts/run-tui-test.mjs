import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const tscBin = path.join(repoRoot, "node_modules", ".bin", "tsc");
const entryPath = path.join(
  repoRoot,
  "dist-tui-test",
  "interface",
  "tui",
  "test-entry.js",
);

execFileSync(tscBin, ["-p", "tsconfig.tui-test.json"], {
  cwd: repoRoot,
  stdio: "inherit",
});

if (process.argv.includes("--build-only")) {
  process.exit(0);
}

execFileSync(process.execPath, [entryPath], {
  cwd: repoRoot,
  stdio: "inherit",
  env: process.env,
});
