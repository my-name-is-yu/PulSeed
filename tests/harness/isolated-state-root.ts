import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { JsonObject } from "./types.js";
import { stableJson } from "./normalizers.js";

export interface IsolatedStateRoot {
  root: string;
  pulseedHome: string;
  runtimeRoot: string;
  controlDbBase: string;
  workspaceRoot: string;
  env: NodeJS.ProcessEnv;
  writeJson(relativePath: string, value: JsonObject): Promise<void>;
  cleanup(): Promise<void>;
}

export async function createIsolatedStateRoot(
  name: string,
  initialState: JsonObject = {},
): Promise<IsolatedStateRoot> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `${sanitizeName(name)}-`));
  const pulseedHome = path.join(root, "pulseed-home");
  const runtimeRoot = path.join(root, "runtime");
  const controlDbBase = path.join(root, "state");
  const workspaceRoot = path.join(root, "workspace");
  await Promise.all([
    fsp.mkdir(pulseedHome, { recursive: true }),
    fsp.mkdir(runtimeRoot, { recursive: true }),
    fsp.mkdir(controlDbBase, { recursive: true }),
    fsp.mkdir(workspaceRoot, { recursive: true }),
  ]);
  await writeInitialState(root, initialState);

  return {
    root,
    pulseedHome,
    runtimeRoot,
    controlDbBase,
    workspaceRoot,
    env: {
      ...process.env,
      PULSEED_HOME: pulseedHome,
      PULSEED_RUNTIME_ROOT: runtimeRoot,
      PULSEED_CONTROL_DB_BASE: controlDbBase,
    },
    async writeJson(relativePath: string, value: JsonObject): Promise<void> {
      const target = path.join(root, relativePath);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, stableJson(value), "utf8");
    },
    async cleanup(): Promise<void> {
      await fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

async function writeInitialState(root: string, initialState: JsonObject): Promise<void> {
  for (const [relativePath, value] of Object.entries(initialState)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const target = path.join(root, relativePath);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, stableJson(value), "utf8");
  }
}

function sanitizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "pulseed-trace";
}
