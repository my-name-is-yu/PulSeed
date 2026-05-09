import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { atomicWrite } from "../../base/state/state-manager.js";
import type { StateManager } from "../../base/state/state-manager.js";
import { RunSpecIdSchema, RunSpecSchema, type RunSpec } from "./types.js";

export class RunSpecStore {
  constructor(private readonly stateManager: Pick<StateManager, "getBaseDir">) {}

  async save(spec: RunSpec): Promise<RunSpec> {
    const parsed = RunSpecSchema.parse(spec);
    const dir = this.runSpecsDir();
    await fsp.mkdir(dir, { recursive: true });
    await atomicWrite(path.join(dir, `${parsed.id}.json`), parsed);
    return parsed;
  }

  async load(id: string): Promise<RunSpec | null> {
    const parsedId = RunSpecIdSchema.parse(id);
    let raw: string;
    try {
      raw = await fsp.readFile(path.join(this.runSpecsDir(), `${parsedId}.json`), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }

    const parsed = RunSpecSchema.safeParse(parsedJson);
    return parsed.success ? parsed.data : null;
  }

  private runSpecsDir(): string {
    return path.join(this.stateManager.getBaseDir(), "run-specs");
  }
}

export function createRunSpecStore(stateManager: Pick<StateManager, "getBaseDir">): RunSpecStore {
  return new RunSpecStore(stateManager);
}
