#!/usr/bin/env node
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const requiredFiles = [
  "dist/interface/cli/cli-runner.js",
  "dist/index.js",
  "dist/index.d.ts",
  "README.md",
  "LICENSE",
];
const requiredExecutableFiles = [
  "dist/interface/cli/cli-runner.js",
];

const packResult = spawnSync("npm", ["pack", "--json", "--dry-run"], {
  encoding: "utf8",
});

if (packResult.error) {
  fail(packResult.error.message);
}

if (packResult.status !== 0) {
  fail(packResult.stderr.trim() || "npm pack --json --dry-run failed");
}

const payload = `${packResult.stdout}\n${packResult.stderr}`.trim();
const jsonStart = payload.indexOf("[");
const jsonEnd = payload.lastIndexOf("]");
if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
  fail("Could not find JSON output from npm pack --json --dry-run.");
}

let parsed;
try {
  parsed = JSON.parse(payload.slice(jsonStart, jsonEnd + 1));
} catch (error) {
  fail(`Could not parse npm pack output: ${error instanceof Error ? error.message : String(error)}`);
}

if (!Array.isArray(parsed) || parsed.length === 0) {
  fail("npm pack --json --dry-run did not return any tarball metadata.");
}

const [entry] = parsed;
const files = Array.isArray(entry?.files)
  ? entry.files
      .map((file) => (file && typeof file === "object" ? file.path : null))
      .filter((filePath) => typeof filePath === "string")
  : [];

if (files.length === 0) {
  fail("npm pack --json --dry-run did not include a file list.");
}

const missingFiles = requiredFiles.filter((filePath) => !files.includes(filePath));

if (missingFiles.length > 0) {
  fail(`Packaged artifact is missing required files:\n- ${missingFiles.join("\n- ")}`);
}

for (const filePath of requiredExecutableFiles) {
  try {
    const mode = statSync(filePath).mode;
    if ((mode & 0o111) === 0) {
      fail(`Packaged executable is not executable: ${filePath}`);
    }
  } catch (error) {
    fail(`Could not inspect executable mode for ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const smokeHome = mkdtempSync(join(tmpdir(), "pulseed-packaged-smoke-"));
try {
  const smokeResult = spawnSync(process.execPath, ["dist/interface/cli/cli-runner.js", "--version"], {
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
      PULSEED_HOME: smokeHome,
    },
  });
  if (smokeResult.error) {
    fail(`Packaged CLI smoke failed: ${smokeResult.error.message}`);
  }
  if (smokeResult.status !== 0) {
    fail(
      `Packaged CLI smoke failed with status ${smokeResult.status}:\n${smokeResult.stderr.trim() || smokeResult.stdout.trim()}`
    );
  }
  const smokeOutput = `${smokeResult.stdout}\n${smokeResult.stderr}`.trim();
  if (!/\d+\.\d+\.\d+/.test(smokeOutput)) {
    fail(`Packaged CLI smoke did not print a version: ${smokeOutput || "(empty output)"}`);
  }
} finally {
  rmSync(smokeHome, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

console.log("Packaged artifact verification passed.");
console.log(`Tarball: ${entry.filename ?? "(unknown)"}`);
for (const filePath of requiredFiles) {
  console.log(`- ${filePath}`);
}
console.log("- packaged CLI --version smoke");

function fail(message) {
  console.error(message);
  process.exit(1);
}
