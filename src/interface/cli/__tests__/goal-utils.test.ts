import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { buildThreshold, autoRegisterFileExistenceDataSources, loadExistingDatasources, findShellPattern } from "../commands/goal-utils.js";

// ─── fileExistenceDatasourceExists dedup tests ───
// Tested indirectly via autoRegisterFileExistenceDataSources

describe("autoRegisterFileExistenceDataSources — dedup by path and scope_goal_id", () => {
  let tmpDir: string;
  let datasourcesDir: string;
  let fakeStateManager: { getBaseDir: () => string };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-goal-utils-test-"));
    datasourcesDir = path.join(tmpDir, "datasources");
    fs.mkdirSync(datasourcesDir, { recursive: true });
    fakeStateManager = { getBaseDir: () => tmpDir };
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true , maxRetries: 3, retryDelay: 100 });
  });

  function writeDatasource(filename: string, cfg: Record<string, unknown>): void {
    const id = filename.replace(/\.json$/, "");
    fs.writeFileSync(path.join(datasourcesDir, filename), JSON.stringify({
      id,
      name: id,
      type: "file_existence",
      connection: {},
      enabled: true,
      created_at: "2026-05-09T00:00:00.000Z",
      ...cfg,
    }));
  }

  it("skips registration when identical datasource (same dims, same path, same goalId) already exists", async () => {
    writeDatasource("existing.json", {
      id: "existing",
      type: "file_existence",
      connection: { path: "/workspace/proj" },
      dimension_mapping: { readme_exists: "README.md" },
      scope_goal_id: "goal-1",
    });

    await autoRegisterFileExistenceDataSources(
      fakeStateManager as never,
      [{ name: "readme_exists", label: "README.md must exist" }],
      "Ensure README.md is present",
      "goal-1",
      ["workspace_path:/workspace/proj"]
    );

    const files = fs.readdirSync(datasourcesDir).filter((f) => f.endsWith(".json"));
    expect(files).toHaveLength(1); // no new file added
  });

  it("registers new datasource when same dims but different workspace path", async () => {
    writeDatasource("existing.json", {
      id: "existing",
      type: "file_existence",
      connection: { path: "/workspace/old-proj" },
      dimension_mapping: { readme_exists: "README.md" },
      scope_goal_id: "goal-1",
    });

    await autoRegisterFileExistenceDataSources(
      fakeStateManager as never,
      [{ name: "readme_exists", label: "README.md must exist" }],
      "Ensure README.md is present",
      "goal-1",
      ["workspace_path:/workspace/new-proj"]
    );

    const configs = await loadExistingDatasources(datasourcesDir);
    const newEntry = configs.find(
      (c) => c.connection?.path === "/workspace/new-proj"
    );
    expect(newEntry).toBeDefined();
  });

  it("registers new datasource when same dims and path but different goalId", async () => {
    writeDatasource("existing.json", {
      id: "existing",
      type: "file_existence",
      connection: { path: "/workspace/proj" },
      dimension_mapping: { readme_exists: "README.md" },
      scope_goal_id: "goal-1",
    });

    await autoRegisterFileExistenceDataSources(
      fakeStateManager as never,
      [{ name: "readme_exists", label: "README.md must exist" }],
      "Ensure README.md is present",
      "goal-2",
      ["workspace_path:/workspace/proj"]
    );

    const configs = await loadExistingDatasources(datasourcesDir);
    const newEntry = configs.find((c) => c.scope_goal_id === "goal-2");
    expect(newEntry).toBeDefined();
  });

  it("ignores invalid persisted datasource JSON during auto-registration", async () => {
    fs.writeFileSync(path.join(datasourcesDir, "bad.json"), "null");

    await autoRegisterFileExistenceDataSources(
      fakeStateManager as never,
      [{ name: "readme_exists", label: "README.md must exist" }],
      "Ensure README.md is present",
      "goal-1",
      ["workspace_path:/workspace/proj"]
    );

    const configs = await loadExistingDatasources(datasourcesDir);
    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({
      type: "file_existence",
      connection: { path: "/workspace/proj" },
      dimension_mapping: { readme_exists: "README.md" },
      scope_goal_id: "goal-1",
    });
  });

  it("skips oversized persisted datasource JSON while loading existing configs", async () => {
    writeDatasource("oversized.json", {
      id: "oversized",
      type: "file_existence",
      connection: { path: "/workspace/proj" },
      dimension_mapping: { readme_exists: "README.md" },
      scope_goal_id: "goal-1",
      padding: "x".repeat(300 * 1024),
    });
    writeDatasource("valid.json", {
      id: "valid",
      type: "file_existence",
      connection: { path: "/workspace/proj" },
      dimension_mapping: { package_exists: "package.json" },
      scope_goal_id: "goal-1",
    });

    const configs = await loadExistingDatasources(datasourcesDir);

    expect(configs.map((config) => config.id)).toEqual(["valid"]);
  });
});

describe("buildThreshold", () => {
  describe("range type", () => {
    it("parses comma-separated range", () => {
      expect(buildThreshold({ name: "x", type: "range", value: "7,9" })).toEqual({
        type: "range",
        low: 7,
        high: 9,
      });
    });

    it("parses hyphen-separated range", () => {
      expect(buildThreshold({ name: "x", type: "range", value: "7-9" })).toEqual({
        type: "range",
        low: 7,
        high: 9,
      });
    });

    it("parses negative range with hyphen fallback", () => {
      expect(buildThreshold({ name: "x", type: "range", value: "-5-5" })).toEqual({
        type: "range",
        low: -5,
        high: 5,
      });
    });

    it("parses both-negative range with hyphen fallback", () => {
      expect(buildThreshold({ name: "x", type: "range", value: "-10--5" })).toEqual({
        type: "range",
        low: -10,
        high: -5,
      });
    });

    it("parses negative decimal range with hyphen fallback", () => {
      expect(buildThreshold({ name: "x", type: "range", value: "-5.5-10.5" })).toEqual({
        type: "range",
        low: -5.5,
        high: 10.5,
      });
    });

    it("parses decimal comma-separated range", () => {
      expect(buildThreshold({ name: "x", type: "range", value: "10.5,20.5" })).toEqual({
        type: "range",
        low: 10.5,
        high: 20.5,
      });
    });

    it("returns null when value is missing", () => {
      expect(buildThreshold({ name: "x", type: "range", value: undefined })).toBeNull();
    });

    it("returns null when value is not parseable", () => {
      expect(buildThreshold({ name: "x", type: "range", value: "abc" })).toBeNull();
    });

    it("does not partially parse comma-separated range values", () => {
      expect(buildThreshold({ name: "x", type: "range", value: "1px,2" })).toBeNull();
      expect(buildThreshold({ name: "x", type: "range", value: "1,2px" })).toBeNull();
    });

    it("rejects non-finite range values", () => {
      expect(buildThreshold({ name: "x", type: "range", value: "1,Infinity" })).toBeNull();
    });
  });

  describe("min and max types", () => {
    it("parses exact finite numbers", () => {
      expect(buildThreshold({ name: "x", type: "min", value: "1.5" })).toEqual({
        type: "min",
        value: 1.5,
      });
      expect(buildThreshold({ name: "x", type: "max", value: "1e3" })).toEqual({
        type: "max",
        value: 1000,
      });
    });

    it("rejects partial and non-finite numbers", () => {
      expect(buildThreshold({ name: "x", type: "min", value: "1abc" })).toBeNull();
      expect(buildThreshold({ name: "x", type: "max", value: "Infinity" })).toBeNull();
    });
  });

  describe("match type", () => {
    it("only converts exact finite numeric values to numbers", () => {
      expect(buildThreshold({ name: "x", type: "match", value: "123" })).toEqual({
        type: "match",
        value: 123,
      });
      expect(buildThreshold({ name: "x", type: "match", value: "123done" })).toEqual({
        type: "match",
        value: "123done",
      });
      expect(buildThreshold({ name: "x", type: "match", value: "Infinity" })).toEqual({
        type: "match",
        value: "Infinity",
      });
    });
  });
});

describe("findShellPattern", () => {
  it("returns defined pattern for test_pass_count with output_type raw and timeout_ms", () => {
    const pattern = findShellPattern("test_pass_count");
    expect(pattern).toBeDefined();
    expect(pattern!.output_type).toBe("raw");
    expect(pattern!.timeout_ms).toBe(120000);
  });

  it("does not match known shell patterns by substring", () => {
    expect(findShellPattern("not_todo_count")).toBeUndefined();
    expect(findShellPattern("todo_count_remaining")).toBeUndefined();
  });

  it("accepts exact known shell pattern names after trimming whitespace", () => {
    expect(findShellPattern(" todo_count ")).toBeDefined();
  });
});
