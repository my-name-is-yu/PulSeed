import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";
import { BackpressureController } from "../guardrails/backpressure-controller.js";
import { GuardrailStore } from "../guardrails/guardrail-store.js";

describe("BackpressureController", () => {
  let tmpDir: string;
  let store: GuardrailStore;

  beforeEach(() => {
    tmpDir = makeTempDir();
    store = new GuardrailStore(tmpDir);
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("rejects unsafe numeric options before writing backpressure state", async () => {
    expect(() => new BackpressureController(store, { leaseTtlMs: Infinity })).toThrow("leaseTtlMs");
    expect(() => new BackpressureController(store, { maxConcurrentPerProvider: Number.MAX_SAFE_INTEGER + 1 }))
      .toThrow("maxConcurrentPerProvider");
    expect(() => new BackpressureController(store, { maxConcurrentPerService: 0 })).toThrow("maxConcurrentPerService");

    await expect(store.loadBackpressureSnapshot()).resolves.toBeNull();
  });

  it("prunes expired leases with a validated TTL before admitting new work", async () => {
    await store.saveBackpressureSnapshot({
      updated_at: "2026-05-09T00:00:00.000Z",
      active: [{
        provider_id: "browser",
        service_key: "mail.example.com",
        run_key: "old-run",
        acquired_at: "2026-05-09T00:00:00.000Z",
      }],
      throttled: [],
    });

    const controller = new BackpressureController(store, {
      maxConcurrentPerProvider: 1,
      maxConcurrentPerService: 1,
      leaseTtlMs: 1_000,
      now: () => new Date("2026-05-09T00:00:02.000Z"),
    });

    await expect(controller.acquire({
      providerId: "browser",
      serviceKey: "mail.example.com",
      runKey: "new-run",
    })).resolves.toEqual({ ok: true });

    await expect(store.loadBackpressureSnapshot()).resolves.toMatchObject({
      active: [{
        provider_id: "browser",
        service_key: "mail.example.com",
        run_key: "new-run",
      }],
    });
  });
});
