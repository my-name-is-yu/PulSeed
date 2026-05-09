import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";
import { GuardrailStore } from "../guardrails/index.js";
import { createRuntimeStorePaths } from "../store/index.js";

describe("GuardrailStore", () => {
  let tmpDir: string;
  let store: GuardrailStore;

  beforeEach(() => {
    tmpDir = makeTempDir();
    store = new GuardrailStore(tmpDir);
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("rejects unsafe circuit breaker failure counts before persistence", async () => {
    await expect(store.saveBreaker({
      key: "browser::example",
      provider_id: "browser",
      service_key: "example",
      state: "open",
      failure_count: Number.MAX_SAFE_INTEGER + 1,
      last_failure_code: "provider_unavailable",
      last_failure_message: null,
      last_failure_at: "2026-05-09T00:00:00.000Z",
      opened_at: "2026-05-09T00:00:00.000Z",
      cooldown_until: "2026-05-09T00:05:00.000Z",
      updated_at: "2026-05-09T00:00:00.000Z",
    })).rejects.toThrow();

    await expect(store.listBreakers()).resolves.toEqual([]);
  });

  it("skips persisted circuit breaker records with unsafe failure counts", async () => {
    const paths = createRuntimeStorePaths(tmpDir);
    await fs.promises.mkdir(paths.guardrailBreakersDir, { recursive: true });
    await fs.promises.writeFile(paths.guardrailBreakerPath("browser::example"), JSON.stringify({
      key: "browser::example",
      provider_id: "browser",
      service_key: "example",
      state: "open",
      failure_count: Number.MAX_SAFE_INTEGER + 1,
      last_failure_code: "provider_unavailable",
      last_failure_message: null,
      last_failure_at: "2026-05-09T00:00:00.000Z",
      opened_at: "2026-05-09T00:00:00.000Z",
      cooldown_until: "2026-05-09T00:05:00.000Z",
      updated_at: "2026-05-09T00:00:00.000Z",
    }), "utf-8");

    await expect(store.loadBreaker("browser::example")).resolves.toBeNull();
    await expect(store.listBreakers()).resolves.toEqual([]);
  });
});
