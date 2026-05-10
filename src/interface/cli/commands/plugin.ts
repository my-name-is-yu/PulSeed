import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as cp from "node:child_process";
import { promisify } from "node:util";
import { getPulseedVersion as getPackageVersion } from "../../../base/utils/pulseed-meta.js";
import { formatOperationError } from "../utils.js";
import { getCliLogger } from "../cli-logger.js";
import { getPluginsDir } from "../../../base/utils/paths.js";
import { readTextFileWithinLimit } from "../../../base/utils/json-io.js";
import { satisfiesRange } from "../../../runtime/plugin-loader.js";
import {
  readPluginManifest,
  type PluginManifestReadResult,
} from "../../../runtime/plugin-manifest-reader.js";

const execFile = promisify(cp.execFile);
const NPM_SOURCE_METADATA = ".pulseed-plugin-source.json";
const NPM_SOURCE_METADATA_MAX_BYTES = 64 * 1024;

function defaultPluginsDir(): string {
  return getPluginsDir();
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readManifest(pluginDir: string): Promise<PluginManifestReadResult> {
  return readPluginManifest(pluginDir);
}

function isMissingManifest(result: PluginManifestReadResult): boolean {
  return !result.ok && result.failure === "missing";
}

function formatManifestReadError(result: PluginManifestReadResult): string {
  if (result.ok) return "";
  if (result.failure === "missing") return "plugin manifest not found";
  if (result.failure === "schema") {
    const issues = result.schemaIssues
      ?.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
      .join("; ");
    return issues ?? result.errorMessage ?? "manifest schema validation failed";
  }
  return `failed to ${result.failure} ${result.filename ?? "plugin manifest"}: ${result.errorMessage ?? "unknown error"}`;
}

export async function cmdPluginList(pluginsDir?: string): Promise<number> {
  const logger = getCliLogger();
  const dir = pluginsDir ?? defaultPluginsDir();

  if (!(await pathExists(dir))) {
    console.log("No plugins installed. Use `pulseed plugin install <path>` to install one.");
    return 0;
  }

  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch (err) {
    logger.error(formatOperationError("read plugins directory", err));
    return 1;
  }

  const rows: { name: string; version: string; type: string; description: string }[] = [];

  for (const entry of entries) {
    const pluginDir = path.join(dir, entry);
    let stat: Awaited<ReturnType<typeof fsp.stat>> | undefined;
    try {
      stat = await fsp.stat(pluginDir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    const result = await readManifest(pluginDir);
    if (!result.ok) continue;

    const m = result.data;
    rows.push({
      name: m.name,
      version: m.version,
      type: m.type,
      description: m.description.length > 40 ? m.description.slice(0, 37) + "..." : m.description,
    });
  }

  if (rows.length === 0) {
    console.log("No plugins installed. Use `pulseed plugin install <path>` to install one.");
    return 0;
  }

  console.log(`Found ${rows.length} plugin(s):\n`);
  console.log(`${"NAME".padEnd(24)} ${"VERSION".padEnd(10)} ${"TYPE".padEnd(14)} DESCRIPTION`);
  console.log("─".repeat(80));
  for (const r of rows) {
    console.log(`${r.name.padEnd(24)} ${r.version.padEnd(10)} ${r.type.padEnd(14)} ${r.description}`);
  }

  return 0;
}

/** Returns true when the argument looks like a local filesystem path. */
function isLocalPath(arg: string): boolean {
  return arg.startsWith("/") || arg.startsWith("./") || arg.startsWith("../");
}

/** Returns true when the argument looks like an npm package name. */
function isNpmPackage(arg: string): boolean {
  return arg.startsWith("@") || /^[a-zA-Z0-9]/.test(arg);
}

/** Read and validate plugin manifest from an npm-installed package directory. */
function getNpmPackageRoot(pluginDir: string, packageName: string): string {
  // Resolve the package dir inside node_modules
  const pkgName = packageName.startsWith("@")
    ? packageName.split("/").slice(0, 2).join("/")
    : packageName.split("/")[0];
  return path.join(pluginDir, "node_modules", pkgName);
}

/** Read and validate plugin manifest from an npm-installed package directory. */
async function readNpmManifest(pluginDir: string, packageName: string) {
  return readManifest(getNpmPackageRoot(pluginDir, packageName));
}

async function copyPackageRootToPluginDir(packageRoot: string, pluginDir: string): Promise<void> {
  const existingEntries = await fsp.readdir(pluginDir, { withFileTypes: true });
  for (const entry of existingEntries) {
    if (entry.name === "node_modules" || entry.name === NPM_SOURCE_METADATA) continue;
    await fsp.rm(path.join(pluginDir, entry.name), { recursive: true, force: true });
  }

  const entries = await fsp.readdir(packageRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules") continue;
    const source = path.join(packageRoot, entry.name);
    const destination = path.join(pluginDir, entry.name);
    await fsp.cp(source, destination, { recursive: true });
  }
}

async function writeNpmSourceMetadata(pluginDir: string, packageName: string): Promise<void> {
  await fsp.writeFile(
    path.join(pluginDir, NPM_SOURCE_METADATA),
    `${JSON.stringify({ type: "npm", packageName }, null, 2)}\n`,
    "utf-8",
  );
}

async function readNpmSourceMetadata(pluginDir: string): Promise<{ packageName: string } | null> {
  try {
    const raw = await readTextFileWithinLimit(path.join(pluginDir, NPM_SOURCE_METADATA), {
      maxBytes: NPM_SOURCE_METADATA_MAX_BYTES,
    });
    const parsed = JSON.parse(raw) as { type?: unknown; packageName?: unknown };
    if (parsed.type === "npm" && typeof parsed.packageName === "string" && parsed.packageName.length > 0) {
      return { packageName: parsed.packageName };
    }
  } catch {
    return null;
  }
  return null;
}

function pluginStorageDirName(pluginName: string): string {
  return pluginName.replace(/\//g, "__").replace(/@/g, "") || "unknown";
}

async function findPluginDirByName(pluginsDir: string, name: string): Promise<string | null> {
  const storageDirect = path.join(pluginsDir, pluginStorageDirName(name));
  if (await pathExists(storageDirect)) return storageDirect;

  const legacyDirect = path.join(pluginsDir, name);
  if (await pathExists(legacyDirect)) return legacyDirect;

  let entries: string[];
  try {
    entries = await fsp.readdir(pluginsDir);
  } catch {
    return null;
  }

  for (const entry of entries) {
    const candidate = path.join(pluginsDir, entry);
    let stat: Awaited<ReturnType<typeof fsp.stat>>;
    try {
      stat = await fsp.stat(candidate);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    let manifest: Awaited<ReturnType<typeof readManifest>>;
    try {
      manifest = await readManifest(candidate);
    } catch {
      continue;
    }
    if (manifest.ok && manifest.data.name === name) {
      return candidate;
    }
  }

  return null;
}

/** Check PulSeed version compatibility, log a warning if incompatible, return false to abort. */
function checkVersionCompat(
  manifest: { name: string; version: string; min_pulseed_version?: string; max_pulseed_version?: string },
  pulseedVersion: string
): boolean {
  const minVer = manifest.min_pulseed_version;
  const maxVer = manifest.max_pulseed_version;
  const range = [
    minVer ? `>=${minVer}` : "",
    maxVer ? `<=${maxVer}` : "",
  ]
    .filter(Boolean)
    .join(", ");
  let compatible: boolean;
  try {
    compatible = satisfiesRange(pulseedVersion, minVer, maxVer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getCliLogger().warn(
      `Plugin "${manifest.name}" has an invalid PulSeed version constraint (${range || "empty range"}): ${msg}. Aborting install.`
    );
    return false;
  }
  if (!compatible) {
    getCliLogger().warn(
      `Plugin "${manifest.name}" requires PulSeed ${range}, but current version is ${pulseedVersion}. Aborting install.`
    );
    return false;
  }
  return true;
}

function getPulseedVersion(): string {
  return getPackageVersion(import.meta.url);
}

export async function cmdPluginInstall(
  pluginsDir: string | undefined,
  argv: string[],
  _getPulseedVersion?: () => string,
  _execFileFn?: typeof execFile
): Promise<number> {
  const logger = getCliLogger();
  const dir = pluginsDir ?? defaultPluginsDir();
  const source = argv[0];
  const force = argv.includes("--force");

  if (!source) {
    logger.error("Error: source path or package name is required. Usage: pulseed plugin install <path|package> [--force]");
    return 1;
  }

  // ── npm package install ──────────────────────────────────────────────────
  if (!isLocalPath(source) && isNpmPackage(source)) {
    const packageName = source;
    const pluginDir = path.join(dir, pluginStorageDirName(packageName));

    if ((await pathExists(pluginDir)) && !force) {
      logger.error(`Error: plugin "${packageName}" is already installed. Use --force to overwrite.`);
      return 1;
    }

    try {
      if (force) {
        await fsp.rm(pluginDir, { recursive: true, force: true });
      }
      await fsp.mkdir(pluginDir, { recursive: true });
    } catch (err) {
      logger.error(formatOperationError("create plugin directory", err));
      return 1;
    }

    const execFn = _execFileFn ?? execFile;
    try {
      await execFn("npm", ["install", "--prefix", pluginDir, packageName]);
    } catch (err) {
      logger.error(formatOperationError("npm install", err));
      return 1;
    }

    const result = await readNpmManifest(pluginDir, packageName);
    if (isMissingManifest(result)) {
      logger.error(`Error: plugin manifest not found after npm install of "${packageName}".`);
      return 1;
    }
    if (!result.ok) {
      logger.error(`Error: invalid plugin manifest — ${formatManifestReadError(result)}`);
      return 1;
    }

    const manifest = result.data;
    const pulseedVer = _getPulseedVersion ? _getPulseedVersion() : getPulseedVersion();
    if (!checkVersionCompat(manifest, pulseedVer)) return 1;

    if (manifest.permissions.shell) {
      logger.warn(`Plugin "${manifest.name}" requests shell execution permission.`);
    }

    try {
      await copyPackageRootToPluginDir(getNpmPackageRoot(pluginDir, packageName), pluginDir);
      await writeNpmSourceMetadata(pluginDir, packageName);
    } catch (err) {
      logger.error(formatOperationError("prepare npm plugin for runtime discovery", err));
      return 1;
    }

    const verify = await readManifest(pluginDir);
    if (!verify.ok) {
      logger.error(`Error: plugin install failed — manifest unreadable after preparing npm package.`);
      return 1;
    }

    console.log(`Plugin "${manifest.name}" v${manifest.version} installed from npm.`);
    return 0;
  }

  // ── Local path install (existing flow) ───────────────────────────────────
  const sourcePath = source;

  if (!(await pathExists(sourcePath))) {
    logger.error(`Error: source path "${sourcePath}" does not exist.`);
    return 1;
  }

  const result = await readManifest(sourcePath);
  if (isMissingManifest(result)) {
    logger.error(`Error: plugin manifest not found in "${sourcePath}". Expected plugin.yaml or plugin.json.`);
    return 1;
  }
  if (!result.ok) {
    logger.error(`Error: invalid plugin manifest — ${formatManifestReadError(result)}`);
    return 1;
  }

  const manifest = result.data;
  const destDir = path.join(dir, pluginStorageDirName(manifest.name));

  if ((await pathExists(destDir)) && !force) {
    logger.error(`Error: plugin "${manifest.name}" is already installed. Use --force to overwrite.`);
    return 1;
  }

  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.cp(sourcePath, destDir, { recursive: true });
  } catch (err) {
    logger.error(formatOperationError("copy plugin", err));
    return 1;
  }

  // Verify after copy
  const verify = await readManifest(destDir);
  if (!verify.ok) {
    logger.error(`Error: plugin copy failed — manifest unreadable after install.`);
    return 1;
  }

  const pulseedVer = _getPulseedVersion ? _getPulseedVersion() : getPulseedVersion();
  if (!checkVersionCompat(manifest, pulseedVer)) return 1;

  if (manifest.permissions.shell) {
    getCliLogger().warn(`Plugin "${manifest.name}" requests shell execution permission.`);
  }

  console.log(`Plugin "${manifest.name}" v${manifest.version} installed.`);
  return 0;
}

export async function cmdPluginUpdate(
  pluginsDir: string | undefined,
  argv: string[],
  _execFileFn?: typeof execFile
): Promise<number> {
  const logger = getCliLogger();
  const dir = pluginsDir ?? defaultPluginsDir();
  const name = argv[0];

  if (!name) {
    logger.error("Error: plugin name is required. Usage: pulseed plugin update <name>");
    return 1;
  }

  const pluginDir = await findPluginDirByName(dir, name);
  if (!pluginDir) {
    logger.error(`Error: plugin "${name}" not found.`);
    return 1;
  }

  const metadata = await readNpmSourceMetadata(pluginDir);
  const manifest = await readManifest(pluginDir);
  const packageName = metadata?.packageName ?? (manifest.ok ? manifest.data.name : name);
  const execFn = _execFileFn ?? execFile;
  try {
    await execFn("npm", ["install", "--prefix", pluginDir, packageName]);
  } catch (err) {
    logger.error(formatOperationError("npm install", err));
    return 1;
  }

  const result = await readNpmManifest(pluginDir, packageName);
  if (isMissingManifest(result)) {
    logger.error(`Error: plugin manifest not found after npm install of "${packageName}".`);
    return 1;
  }
  if (!result.ok) {
    logger.error(`Error: invalid plugin manifest — ${formatManifestReadError(result)}`);
    return 1;
  }

  const updatedManifest = result.data;
  const pulseedVer = getPulseedVersion();
  if (!checkVersionCompat(updatedManifest, pulseedVer)) return 1;

  try {
    await copyPackageRootToPluginDir(getNpmPackageRoot(pluginDir, packageName), pluginDir);
    await writeNpmSourceMetadata(pluginDir, packageName);
  } catch (err) {
    logger.error(formatOperationError("prepare npm plugin for runtime discovery", err));
    return 1;
  }

  const verify = await readManifest(pluginDir);
  if (!verify.ok) {
    logger.error(`Error: plugin update failed — manifest unreadable after preparing npm package.`);
    return 1;
  }

  console.log(`Plugin "${updatedManifest.name}" updated.`);
  return 0;
}

export async function cmdPluginSearch(
  _pluginsDir: string | undefined,
  argv: string[],
  _execFileFn?: typeof execFile
): Promise<number> {
  const logger = getCliLogger();
  const keyword = argv[0];

  if (!keyword) {
    logger.error("Error: keyword is required. Usage: pulseed plugin search <keyword>");
    return 1;
  }

  const execFn = _execFileFn ?? execFile;
  let stdout: string;
  try {
    const result = await execFn("npm", ["search", `@pulseed-plugins/${keyword}`, "--json"]);
    stdout = result.stdout;
  } catch (err) {
    logger.error(formatOperationError("npm search", err));
    return 1;
  }

  let packages: { name: string; version: string; description: string }[] = [];
  try {
    packages = JSON.parse(stdout) as { name: string; version: string; description: string }[];
  } catch {
    logger.error("Error: failed to parse npm search results.");
    return 1;
  }

  if (packages.length === 0) {
    console.log(`No plugins found for keyword "${keyword}".`);
    return 0;
  }

  console.log(`Found ${packages.length} plugin(s):\n`);
  console.log(`${"NAME".padEnd(40)} ${"VERSION".padEnd(10)} DESCRIPTION`);
  console.log("─".repeat(80));
  for (const pkg of packages) {
    const desc = pkg.description?.length > 28 ? pkg.description.slice(0, 25) + "..." : (pkg.description ?? "");
    console.log(`${pkg.name.padEnd(40)} ${pkg.version.padEnd(10)} ${desc}`);
  }

  return 0;
}

export async function cmdPluginRemove(pluginsDir: string | undefined, argv: string[]): Promise<number> {
  const logger = getCliLogger();
  const dir = pluginsDir ?? defaultPluginsDir();
  const name = argv[0];

  if (!name) {
    logger.error("Error: plugin name is required. Usage: pulseed plugin remove <name>");
    return 1;
  }

  const pluginDir = await findPluginDirByName(dir, name);
  if (!pluginDir) {
    logger.error(`Error: plugin "${name}" not found.`);
    return 1;
  }

  try {
    await fsp.rm(pluginDir, { recursive: true });
  } catch (err) {
    logger.error(formatOperationError("remove plugin", err));
    return 1;
  }

  console.log(`Plugin "${name}" removed.`);
  return 0;
}
