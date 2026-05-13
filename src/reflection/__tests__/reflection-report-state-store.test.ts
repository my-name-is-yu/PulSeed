import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../tests/helpers/temp-dir.js";
import { openControlDatabase } from "../../runtime/store/control-db/index.js";
import { ReflectionReportStateStore } from "../reflection-report-state-store.js";
import { importLegacyReflectionReportState } from "../reflection-report-state-migration.js";

describe("ReflectionReportStateStore", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) cleanupTempDir(tmpDir);
  });

  it("saves and loads typed reflection reports", async () => {
    tmpDir = makeTempDir();
    const store = new ReflectionReportStateStore(tmpDir);

    await store.save("morning", "2026-05-11", {
      date: "2026-05-11",
      created_at: "2026-05-11T00:00:00.000Z",
      goals_reviewed: 1,
      priorities: [],
      suggestions: ["Focus on DB closure"],
      concerns: [],
    });

    const loaded = await store.load("morning", "2026-05-11");
    expect(loaded?.suggestions).toEqual(["Focus on DB closure"]);
    await store.close();
  });

  it("imports legacy report files through doctor/repair boundary", async () => {
    tmpDir = makeTempDir();
    fs.mkdirSync(path.join(tmpDir, "reflections"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "reflections", "morning-2026-05-11.json"),
      JSON.stringify({
        date: "2026-05-11",
        created_at: "2026-05-11T00:00:00.000Z",
        goals_reviewed: 1,
        priorities: [],
        suggestions: ["legacy import"],
        concerns: [],
      }),
      "utf8",
    );

    const report = await importLegacyReflectionReportState(tmpDir);
    expect(report).toMatchObject({
      reflectionReportFiles: 1,
      importedReports: 1,
      skippedAlreadyImported: 0,
      retiredExistingTypedState: 0,
      blockedSources: [],
    });

    const store = new ReflectionReportStateStore(tmpDir);
    const loaded = await store.load("morning", "2026-05-11");
    expect(loaded?.suggestions).toEqual(["legacy import"]);
    await store.close();

    const controlDb = await openControlDatabase({ baseDir: tmpDir });
    try {
      expect(controlDb.listLegacyImports()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source_kind: "reflection_report",
          source_id: "morning:2026-05-11",
          migration_name: "reflection-report-runtime-state",
          status: "imported",
        }),
      ]));
    } finally {
      controlDb.close();
    }
  });

  it("retires legacy files when typed state already exists", async () => {
    tmpDir = makeTempDir();
    const store = new ReflectionReportStateStore(tmpDir);
    await store.save("dream", "2026-05-11", {
      date: "2026-05-11",
      created_at: "2026-05-11T00:00:00.000Z",
      goals_consolidated: 1,
      entries_compressed: 0,
      stale_entries_found: 0,
      revalidation_tasks_created: 0,
      cognition_writeback_inputs_read: 0,
      cognition_runtime_authority_granted: false,
    });
    await store.close();

    fs.mkdirSync(path.join(tmpDir, "reflections"), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, "reflections", "dream-2026-05-11.json"),
      JSON.stringify({
        date: "2026-05-11",
        created_at: "2026-05-11T01:00:00.000Z",
        goals_consolidated: 2,
        entries_compressed: 9,
        stale_entries_found: 1,
        revalidation_tasks_created: 1,
      }),
      "utf8",
    );

    const report = await importLegacyReflectionReportState(tmpDir);
    expect(report.importedReports).toBe(0);
    expect(report.retiredExistingTypedState).toBe(1);

    const verifyStore = new ReflectionReportStateStore(tmpDir);
    const loaded = await verifyStore.load("dream", "2026-05-11");
    expect(loaded?.goals_consolidated).toBe(1);
    await verifyStore.close();
  });
});
