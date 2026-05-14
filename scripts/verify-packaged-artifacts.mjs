#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
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

const parsed = parsePackJson(packResult, "npm pack --json --dry-run");

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

const installRoot = mkdtempSync(join(tmpdir(), "pulseed-packaged-install-"));
try {
  const packDir = join(installRoot, "pack");
  const projectDir = join(installRoot, "project");
  const installedHome = join(installRoot, "home");
  mkdirSync(packDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "package.json"), JSON.stringify({
    private: true,
    name: "pulseed-packaged-smoke",
    version: "0.0.0",
    type: "module",
  }, null, 2));

  const actualPackResult = spawnSync("npm", ["pack", "--json", "--pack-destination", packDir], {
    encoding: "utf8",
  });
  if (actualPackResult.error) {
    fail(`npm pack failed: ${actualPackResult.error.message}`);
  }
  if (actualPackResult.status !== 0) {
    fail(actualPackResult.stderr.trim() || "npm pack --json failed");
  }
  const actualPack = parsePackJson(actualPackResult, "npm pack --json");
  const actualEntry = actualPack[0];
  const tarballPath = resolve(packDir, actualEntry.filename);
  if (!existsSync(tarballPath)) {
    fail(`npm pack did not create tarball at ${tarballPath}`);
  }

  const installResult = spawnSync("npm", ["install", "--no-audit", "--no-fund", tarballPath], {
    cwd: projectDir,
    encoding: "utf8",
    env: smokeEnv({ PULSEED_HOME: installedHome }),
  });
  if (installResult.error) {
    fail(`Clean temp install failed: ${installResult.error.message}`);
  }
  if (installResult.status !== 0) {
    fail(`Clean temp install failed with status ${installResult.status}:\n${installResult.stderr.trim() || installResult.stdout.trim()}`);
  }

  const binPath = join(projectDir, "node_modules", ".bin", process.platform === "win32" ? "pulseed.cmd" : "pulseed");
  runPackagedCli(binPath, ["--version"], installedHome, { mustContain: /\d+\.\d+\.\d+/, label: "pulseed --version" });
  runPackagedCli(binPath, ["help"], installedHome, { mustContain: /Usage:/, label: "pulseed help" });
  runPackagedCli(binPath, ["setup", "--help"], installedHome, { mustContain: /Usage: pulseed setup/, label: "pulseed setup --help" });
  runPackagedCli(binPath, ["setup", "--provider", "ollama", "--model", "llama3.1", "--adapter", "agent_loop"], installedHome, {
    mustContain: /Auth:\s+local Ollama/,
    label: "pulseed setup --provider ollama",
  });

  const providerConfig = JSON.parse(readFileSync(join(installedHome, "provider.json"), "utf8"));
  if (Object.prototype.hasOwnProperty.call(providerConfig, "api_key")) {
    fail("Packaged first-run setup stored an api_key even though the smoke path used local Ollama.");
  }

  runPackagedCli(binPath, ["status"], installedHome, { mustContain: /No active goals found|Current goal|Current goals:/, label: "pulseed status" });
  runPackagedCli(binPath, ["doctor"], installedHome, {
    mustContain: /does not require an API key|Summary:/,
    label: "pulseed doctor",
  });
} finally {
  rmSync(installRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

console.log("Packaged artifact verification passed.");
console.log(`Tarball: ${entry.filename ?? "(unknown)"}`);
for (const filePath of requiredFiles) {
  console.log(`- ${filePath}`);
}
console.log("- packaged CLI --version smoke");
console.log("- clean temp npm pack/install smoke");
console.log("- packaged CLI help/setup/status/doctor smoke with temp PULSEED_HOME and no provider API keys");

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parsePackJson(result, label) {
  const payload = `${result.stdout}\n${result.stderr}`.trim();
  const jsonStart = payload.indexOf("[");
  const jsonEnd = payload.lastIndexOf("]");
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
    fail(`Could not find JSON output from ${label}.`);
  }

  let parsedPayload;
  try {
    parsedPayload = JSON.parse(payload.slice(jsonStart, jsonEnd + 1));
  } catch (error) {
    fail(`Could not parse ${label} output: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!Array.isArray(parsedPayload) || parsedPayload.length === 0) {
    fail(`${label} did not return any tarball metadata.`);
  }
  return parsedPayload;
}

function smokeEnv(overrides = {}) {
  const env = { ...process.env, NO_COLOR: "1", ...overrides };
  for (const key of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "PULSEED_API_KEY",
    "PULSEED_OPENAI_API_KEY",
    "PULSEED_ANTHROPIC_API_KEY",
  ]) {
    delete env[key];
  }
  return env;
}

function runPackagedCli(binPath, args, homeDir, options) {
  const result = spawnSync(binPath, args, {
    encoding: "utf8",
    env: smokeEnv({ PULSEED_HOME: homeDir }),
  });
  if (result.error) {
    fail(`${options.label} failed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${options.label} failed with status ${result.status}:\n${result.stderr.trim() || result.stdout.trim()}`);
  }
  const output = `${result.stdout}\n${result.stderr}`.trim();
  if (options.mustContain && !options.mustContain.test(output)) {
    fail(`${options.label} did not produce expected output:\n${output || "(empty output)"}`);
  }
}
