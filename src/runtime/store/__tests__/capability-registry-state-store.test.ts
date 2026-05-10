import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import type { Capability, CapabilityDependency, CapabilityRegistry } from "../../../base/types/capability.js";
import { openControlDatabase } from "../control-db/index.js";
import { CapabilityRegistryStateStore } from "../capability-registry-state-store.js";
import {
  importLegacyCapabilityDependencyState,
  importLegacyCapabilityRegistryState,
} from "../capability-registry-state-migration.js";

function makeCapability(overrides: Partial<Capability> = {}): Capability {
  return {
    id: "cap-1",
    name: "Kaggle Submit",
    description: "Submit Kaggle predictions",
    type: "service",
    status: "available",
    ...overrides,
  };
}

function makeRegistry(capabilities: Capability[]): CapabilityRegistry {
  return {
    capabilities,
    last_checked: "2026-05-10T00:00:00.000Z",
  };
}

function makeDependency(capabilityId: string, dependsOn: string[]): CapabilityDependency {
  return { capability_id: capabilityId, depends_on: dependsOn };
}

describe("CapabilityRegistryStateStore", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      cleanupTempDir(dir);
    }
  });

  function tempHome(prefix: string): string {
    const dir = makeTempDir(prefix);
    tempDirs.push(dir);
    return dir;
  }

  it("stores capability registry entries in the control DB without legacy JSON", async () => {
    const baseDir = tempHome("pulseed-capability-registry-store-");
    const store = new CapabilityRegistryStateStore(baseDir);

    await store.saveRegistry(makeRegistry([
      makeCapability({ id: "cap-available", name: "Kaggle Submit", status: "available" }),
      makeCapability({ id: "cap-missing", name: "Stripe API", status: "missing" }),
    ]));

    await expect(store.loadRegistry()).resolves.toMatchObject({
      capabilities: [
        { id: "cap-available", name: "Kaggle Submit", status: "available" },
        { id: "cap-missing", name: "Stripe API", status: "missing" },
      ],
      last_checked: "2026-05-10T00:00:00.000Z",
    });
    await expect(store.isCapabilityAvailable("Kaggle Submit")).resolves.toBe(true);
    await expect(store.isCapabilityAvailable("Stripe API")).resolves.toBe(false);
    expect(fs.existsSync(path.join(baseDir, "capability_registry.json"))).toBe(false);
  });

  it("imports legacy capability_registry.json only through explicit repair input", async () => {
    const baseDir = tempHome("pulseed-capability-registry-import-");
    fs.writeFileSync(path.join(baseDir, "capability_registry.json"), JSON.stringify(makeRegistry([
      makeCapability({ id: "cap-imported", name: "Kaggle Submit", status: "available" }),
    ])));

    const report = await importLegacyCapabilityRegistryState(baseDir);
    expect(report).toEqual({
      registryFiles: 1,
      importedCapabilities: 1,
      blockedSources: [],
    });

    const store = new CapabilityRegistryStateStore(baseDir);
    await expect(store.isCapabilityAvailable("Kaggle Submit")).resolves.toBe(true);

    const database = await openControlDatabase({ baseDir });
    try {
      expect(database.listLegacyImports()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source_kind: "capability_registry",
          source_id: "current",
          migration_name: "capability-registry-state",
          status: "imported",
          details: expect.objectContaining({ capability_count: 1 }),
        }),
      ]));
    } finally {
      database.close();
    }
  });

  it("stores capability dependencies in the control DB without legacy JSON", async () => {
    const baseDir = tempHome("pulseed-capability-dependency-store-");
    const store = new CapabilityRegistryStateStore(baseDir);
    const dependencies = [
      makeDependency("cap-submit", ["cap-login", "cap-dataset"]),
      makeDependency("cap-report", []),
    ];

    await store.saveDependencies(dependencies);

    await expect(store.loadDependencies()).resolves.toEqual(dependencies);
    await expect(store.hasDependencies()).resolves.toBe(true);
    expect(fs.existsSync(path.join(baseDir, "capability_dependencies.json"))).toBe(false);
  });

  it("tracks an intentionally empty dependency map as typed state", async () => {
    const baseDir = tempHome("pulseed-capability-dependency-empty-");
    const store = new CapabilityRegistryStateStore(baseDir);

    await store.saveDependencies([]);

    await expect(store.loadDependencies()).resolves.toEqual([]);
    await expect(store.hasDependencies()).resolves.toBe(true);
  });

  it("imports legacy capability_dependencies.json only through explicit repair input", async () => {
    const baseDir = tempHome("pulseed-capability-dependency-import-");
    fs.writeFileSync(path.join(baseDir, "capability_dependencies.json"), JSON.stringify([
      makeDependency("cap-imported", ["cap-prereq"]),
    ]));

    const report = await importLegacyCapabilityDependencyState(baseDir);
    expect(report).toEqual({
      dependencyFiles: 1,
      dependencies: 1,
      skippedAlreadyImported: 0,
      retiredExistingTypedState: 0,
      blockedSources: [],
    });

    const store = new CapabilityRegistryStateStore(baseDir);
    await expect(store.loadDependencies()).resolves.toEqual([
      makeDependency("cap-imported", ["cap-prereq"]),
    ]);

    const database = await openControlDatabase({ baseDir });
    try {
      expect(database.listLegacyImports()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source_kind: "capability_dependency_state",
          source_id: "current",
          migration_name: "capability-dependency-state",
          status: "imported",
          details: expect.objectContaining({ dependency_count: 1 }),
        }),
      ]));
    } finally {
      database.close();
    }
  });

  it("retires legacy dependency input when typed dependency state already exists", async () => {
    const baseDir = tempHome("pulseed-capability-dependency-retire-");
    const store = new CapabilityRegistryStateStore(baseDir);
    await store.saveDependencies([]);
    fs.writeFileSync(path.join(baseDir, "capability_dependencies.json"), JSON.stringify([
      makeDependency("legacy-capability", ["legacy-prereq"]),
    ]));

    const report = await importLegacyCapabilityDependencyState(baseDir);
    expect(report).toMatchObject({
      dependencyFiles: 0,
      dependencies: 0,
      skippedAlreadyImported: 0,
      retiredExistingTypedState: 1,
      blockedSources: [],
    });

    await expect(store.loadDependencies()).resolves.toEqual([]);
  });
});
