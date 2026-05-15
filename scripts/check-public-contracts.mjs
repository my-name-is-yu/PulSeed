#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";

const packageJsonPath = resolve("package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const issues = [];

expectEqual("package name", packageJson.name, "pulseed");
expectEqual("package type", packageJson.type, "module");
expectEqual("main entry", packageJson.main, "dist/index.js");
expectEqual("types entry", packageJson.types, "dist/index.d.ts");
expectEqual("exports[.].import", packageJson.exports?.["."]?.import, "./dist/index.js");
expectEqual("exports[.].types", packageJson.exports?.["."]?.types, "./dist/index.d.ts");
expectEqual("bin.pulseed", packageJson.bin?.pulseed, "dist/interface/cli/cli-runner.js");

const requiredPackageFiles = [
  "dist",
  "assets/seedy.png",
  "README.md",
  "LICENSE",
];
for (const filePath of requiredPackageFiles) {
  if (!Array.isArray(packageJson.files) || !packageJson.files.includes(filePath)) {
    issues.push(`package.json files is missing ${filePath}`);
  }
}

const requiredBuiltFiles = [
  "dist/index.js",
  "dist/index.d.ts",
  "dist/interface/cli/cli-runner.js",
];
for (const filePath of requiredBuiltFiles) {
  if (!existsSync(filePath)) {
    issues.push(`missing built public artifact: ${filePath}`);
  }
}

for (const filePath of ["assets/seedy.png", "README.md", "LICENSE"]) {
  if (!existsSync(filePath)) {
    issues.push(`missing packaged source artifact: ${filePath}`);
  }
}

if (existsSync("dist/index.d.ts")) {
  const declarations = readFileSync("dist/index.d.ts", "utf8");
  if (!/\bexport\b/.test(declarations)) {
    issues.push("dist/index.d.ts does not expose any exports");
  }
}

if (existsSync("dist/interface/cli/cli-runner.js")) {
  const cliContent = readFileSync("dist/interface/cli/cli-runner.js", "utf8");
  if (!cliContent.startsWith("#!/usr/bin/env node")) {
    issues.push("dist/interface/cli/cli-runner.js is missing the node shebang");
  }

  const mode = statSync("dist/interface/cli/cli-runner.js").mode;
  if ((mode & 0o111) === 0) {
    issues.push("dist/interface/cli/cli-runner.js is not executable");
  }
}

if (existsSync("dist/index.js")) {
  const publicModule = await import(pathToFileURL(resolve("dist/index.js")).href);
  for (const exportName of [
    "CLIRunner",
    "ChatRunner",
    "StateManager",
    "DaemonRunner",
    "EXTERNAL_SURFACE_METADATA_KEY",
    "buildChannelPolicyMetadata",
    "buildExternalSurfaceDecision",
    "evaluateChannelAccess",
    "normalizeExternalSurfaceDecision",
    "resolveChannelRoute",
    "loadExternalAdapterConfigJson",
    "readExternalAdapterHttpBody",
    "respondExternalAdapterJson",
    "formatExternalAdapterHttpFailure",
    "ExternalAdapterIntervalPoller",
  ]) {
    if (!(exportName in publicModule)) {
      issues.push(`dist/index.js is missing public export ${exportName}`);
    }
  }
}

const packResult = spawnSync("npm", ["pack", "--json", "--dry-run", "--ignore-scripts"], {
  encoding: "utf8",
});
if (packResult.error) {
  issues.push(`npm pack failed: ${packResult.error.message}`);
} else if (packResult.status !== 0) {
  issues.push(packResult.stderr.trim() || "npm pack --dry-run failed");
} else {
  const packedFiles = parsePackedFiles(`${packResult.stdout}\n${packResult.stderr}`.trim());
  for (const filePath of [
    "dist/index.js",
    "dist/index.d.ts",
    "dist/interface/cli/cli-runner.js",
    "assets/seedy.png",
    "README.md",
    "LICENSE",
  ]) {
    if (!packedFiles.includes(filePath)) {
      issues.push(`npm package is missing ${filePath}`);
    }
  }
}

if (issues.length > 0) {
  console.error("Public contract check failed:");
  for (const issue of issues) {
    console.error(`- ${issue}`);
  }
  process.exit(1);
}

console.log("Public contract check passed.");

function expectEqual(label, actual, expected) {
  if (actual !== expected) {
    issues.push(`${label} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function parsePackedFiles(payload) {
  const jsonStart = payload.indexOf("[");
  const jsonEnd = payload.lastIndexOf("]");
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
    issues.push("could not find JSON output from npm pack --json --dry-run");
    return [];
  }

  try {
    const parsed = JSON.parse(payload.slice(jsonStart, jsonEnd + 1));
    const [entry] = parsed;
    return Array.isArray(entry?.files)
      ? entry.files
          .map((file) => (file && typeof file === "object" ? file.path : null))
          .filter((filePath) => typeof filePath === "string")
      : [];
  } catch (error) {
    issues.push(`could not parse npm pack output: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}
