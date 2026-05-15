#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const args = new Set(process.argv.slice(2));
const verifyAll = args.has("--all");
const changedBase = process.argv.find((value, index) => process.argv[index - 1] === "--base") ?? resolveDefaultBase();

const packageDirs = [
  "plugins/discord-bot",
  "plugins/signal-bridge",
  "plugins/slack-notifier",
  "plugins/telegram-bot",
  "plugins/whatsapp-webhook",
  "examples/plugins/jira-datasource",
  "examples/plugins/mysql-datasource",
  "examples/plugins/pagerduty-notifier",
  "examples/plugins/postgres-datasource",
  "examples/plugins/sqlite-datasource",
  "examples/plugins/sse-datasource",
  "examples/plugins/websocket-datasource",
];

const changedFiles = verifyAll ? [] : gitChangedFiles(changedBase);
const targets = verifyAll
  ? packageDirs
  : packageDirs.filter((dir) => changedFiles.some((file) => file === dir || file.startsWith(`${dir}/`)));

if (targets.length === 0) {
  console.log("No changed subpackages detected.");
  process.exit(0);
}

console.log(`Verifying ${targets.length} subpackage(s):`);
for (const target of targets) {
  console.log(`- ${target}`);
}

for (const dir of targets) {
  verifyBuild(dir);
  verifyTests(dir);
  verifyPackageEntry(dir);
}

console.log("Subpackage verification passed.");

function gitChangedFiles(base) {
  const committed = spawnSync("git", ["diff", "--name-only", `${base}...HEAD`], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (committed.status !== 0) {
    fail(`Unable to resolve changed files against ${base}.`);
  }
  return unique([
    ...lines(committed.stdout),
    ...gitLines(["diff", "--name-only", "--diff-filter=ACMRD"]),
    ...gitLines(["diff", "--cached", "--name-only", "--diff-filter=ACMRD"]),
    ...gitLines(["ls-files", "--others", "--exclude-standard"]),
  ]);
}

function resolveDefaultBase() {
  for (const candidate of ["origin/main", "HEAD~1"]) {
    const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", candidate], {
      stdio: "ignore",
    });
    if (result.status === 0) {
      return candidate;
    }
  }
  return "HEAD";
}

function verifyBuild(dir) {
  const tsconfigPath = path.join(dir, "tsconfig.json");
  if (!existsSync(tsconfigPath)) {
    fail(`Missing tsconfig.json for ${dir}`);
  }
  rmSync(path.join(dir, "dist"), { recursive: true, force: true });
  run("npx", ["tsc", "--project", tsconfigPath, "--pretty", "false"]);
}

function verifyTests(dir) {
  const pkgPath = path.join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  if (!pkg.scripts || typeof pkg.scripts.test !== "string") {
    return;
  }
  run("npx", ["vitest", "run", dir]);
}

function verifyPackageEntry(dir) {
  const pkgPath = path.join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
  const entryPaths = packageEntryPaths(pkg);

  for (const entryPath of entryPaths) {
    const resolved = path.resolve(dir, entryPath);
    if (!existsSync(resolved)) {
      fail(`${dir} package entry is missing ${entryPath}`);
    }
  }

  const packResult = spawnSync("npm", ["pack", "--json", "--dry-run", "--ignore-scripts"], {
    cwd: dir,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (packResult.error) {
    fail(`${dir} npm pack failed: ${packResult.error.message}`);
  }
  if (packResult.status !== 0) {
    fail(`${dir} npm pack --dry-run failed: ${packResult.stderr.trim() || packResult.stdout.trim()}`);
  }

  const packedFiles = parsePackedFiles(dir, `${packResult.stdout}\n${packResult.stderr}`.trim());
  for (const entryPath of entryPaths) {
    const packedPath = stripDotSlash(entryPath);
    if (!packedFiles.includes(packedPath)) {
      fail(`${dir} package tarball is missing ${entryPath}`);
    }
  }

  const mainEntry = typeof pkg.main === "string" ? pkg.main : null;
  if (dir.startsWith("plugins/") && pkg.type === "module" && mainEntry && mainEntry.endsWith(".js")) {
    verifyRuntimeImport(dir, pkg);
  }
}

function verifyRuntimeImport(dir, pkg) {
  if (typeof pkg.name !== "string" || pkg.name.length === 0) {
    fail(`${dir} package.json is missing package name for runtime import check`);
  }

  const tempDir = mkdtempSync(path.join(tmpdir(), "pulseed-subpackage-import-"));
  try {
    const nodeModulesDir = path.join(tempDir, "node_modules");
    mkdirSync(nodeModulesDir, { recursive: true });
    symlinkSync(path.resolve("."), path.join(nodeModulesDir, "pulseed"), "dir");
    symlinkPackage(nodeModulesDir, pkg.name, path.resolve(dir));

    const probe = spawnSync(
      process.execPath,
      [
        "--preserve-symlinks",
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(pkg.name)});`,
      ],
      {
        cwd: tempDir,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    if (probe.error) {
      fail(`${dir} runtime import failed: ${probe.error.message}`);
    }
    if (probe.status !== 0) {
      fail(`${dir} runtime import failed: ${probe.stderr.trim() || probe.stdout.trim()}`);
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function symlinkPackage(nodeModulesDir, packageName, packagePath) {
  if (packageName.startsWith("@")) {
    const [scope, name] = packageName.split("/");
    if (!scope || !name) {
      fail(`invalid scoped package name ${packageName}`);
    }
    const scopeDir = path.join(nodeModulesDir, scope);
    mkdirSync(scopeDir, { recursive: true });
    symlinkSync(packagePath, path.join(scopeDir, name), "dir");
    return;
  }

  symlinkSync(packagePath, path.join(nodeModulesDir, packageName), "dir");
}

function packageEntryPaths(pkg) {
  return unique([
    ...entryValuePaths(pkg.main),
    ...entryValuePaths(pkg.exports),
  ]);
}

function entryValuePaths(value) {
  if (typeof value === "string") {
    return [value];
  }
  if (!value || typeof value !== "object") {
    return [];
  }
  return Object.values(value).flatMap((nested) => entryValuePaths(nested));
}

function parsePackedFiles(dir, payload) {
  const jsonStart = payload.indexOf("[");
  const jsonEnd = payload.lastIndexOf("]");
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
    fail(`${dir} npm pack did not emit JSON file metadata`);
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
    fail(`${dir} could not parse npm pack output: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function stripDotSlash(value) {
  return value.startsWith("./") ? value.slice(2) : value;
}

function run(command, commandArgs) {
  const rendered = [command, ...commandArgs].join(" ");
  console.log(`$ ${rendered}`);
  const result = spawnSync(command, commandArgs, { stdio: "inherit" });
  if (result.error) {
    fail(result.error.message);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function gitLines(commandArgs) {
  const result = spawnSync("git", commandArgs, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? lines(result.stdout) : [];
}

function lines(output) {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function unique(items) {
  return [...new Set(items)];
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
