import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StateManager } from "../../../base/state/state-manager.js";
import { getDatasourcesDir } from "../../../base/utils/paths.js";
import { cmdDatasourceAdd } from "../commands/config.js";
import { createCliDataSourceAdapter } from "../setup.js";
import { PostgresDataSourceAdapter } from "../../../platform/observation/data-source-adapter.js";
import { ArtifactMetricDataSourceAdapter } from "../../../adapters/datasources/artifact-metric-datasource.js";
import { buildCliDataSourceRegistry } from "../data-source-bootstrap.js";

describe("cmdDatasourceAdd(database)", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-datasource-command-"));
    stateManager = new StateManager(tmpDir);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("writes a database datasource config with a dimension mapping", async () => {
    const exitCode = await cmdDatasourceAdd(stateManager, [
      "database",
      "--connection-string",
      "postgresql://localhost:5432/analytics",
      "--dimension",
      "open_issue_count",
      "--query",
      "SELECT count(*) FROM issues WHERE state = 'open'",
    ]);

    expect(exitCode).toBe(0);

    const datasourcesDir = getDatasourcesDir(stateManager.getBaseDir());
    const [filename] = fs.readdirSync(datasourcesDir);
    const saved = JSON.parse(
      fs.readFileSync(path.join(datasourcesDir, filename!), "utf-8")
    ) as {
      id: string;
      type: string;
      connection_string?: string;
      dimension_mapping?: Record<string, string>;
    };

    expect(saved.type).toBe("database");
    expect(saved.connection_string).toBe("postgresql://localhost:5432/analytics");
    expect(saved.dimension_mapping).toEqual({
      [saved.id!]: "SELECT count(*) FROM issues WHERE state = 'open'",
      open_issue_count: "SELECT count(*) FROM issues WHERE state = 'open'",
    });
  });

  it("accepts postgres as an alias for database", async () => {
    const exitCode = await cmdDatasourceAdd(stateManager, [
      "postgres",
      "--connection-string",
      "postgresql://localhost:5432/app",
      "--query",
      "SELECT 1",
    ]);

    expect(exitCode).toBe(0);

    const datasourcesDir = getDatasourcesDir(stateManager.getBaseDir());
    const [filename] = fs.readdirSync(datasourcesDir);
    const saved = JSON.parse(
      fs.readFileSync(path.join(datasourcesDir, filename!), "utf-8")
    ) as { type: string };

    expect(saved.type).toBe("database");
  });
});

describe("createCliDataSourceAdapter", () => {
  it("maps database datasources to PostgresDataSourceAdapter", () => {
    const adapter = createCliDataSourceAdapter({
      id: "db-source",
      name: "Analytics DB",
      type: "database",
      connection: {},
      connection_string: "postgresql://localhost:5432/analytics",
      dimension_mapping: {
        open_issue_count: "SELECT count(*) FROM issues WHERE state = 'open'",
      },
      enabled: true,
      created_at: new Date().toISOString(),
    });

    expect(adapter).toBeInstanceOf(PostgresDataSourceAdapter);
  });

  it("maps artifact_metric datasources to ArtifactMetricDataSourceAdapter", () => {
    const adapter = createCliDataSourceAdapter({
      id: "artifact-source",
      name: "Workspace Artifacts",
      type: "artifact_metric",
      connection: { path: process.cwd() },
      enabled: true,
      created_at: new Date().toISOString(),
    });

    expect(adapter).toBeInstanceOf(ArtifactMetricDataSourceAdapter);
  });

  it("adds the builtin workspace artifact datasource even without saved configs", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-datasource-bootstrap-"));
    const originalHome = process.env["PULSEED_HOME"];
    process.env["PULSEED_HOME"] = tmpDir;
    try {
      const registry = await buildCliDataSourceRegistry(tmpDir);
      expect(registry.listSources()).toContain("ds_builtin_workspace_artifacts");
    } finally {
      if (originalHome === undefined) {
        delete process.env["PULSEED_HOME"];
      } else {
        process.env["PULSEED_HOME"] = originalHome;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it("skips invalid persisted datasource files without aborting valid registry entries", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-datasource-bootstrap-"));
    const originalHome = process.env["PULSEED_HOME"];
    process.env["PULSEED_HOME"] = tmpDir;
    const datasourcesDir = getDatasourcesDir(tmpDir);
    fs.mkdirSync(datasourcesDir, { recursive: true });
    fs.writeFileSync(path.join(datasourcesDir, "00-malformed.json"), "{", "utf-8");
    fs.writeFileSync(
      path.join(datasourcesDir, "01-invalid-schema.json"),
      JSON.stringify({
        id: "missing-name",
        type: "file_existence",
        connection: {},
        created_at: new Date().toISOString(),
      }),
      "utf-8"
    );
    fs.writeFileSync(
      path.join(datasourcesDir, "02-invalid-adapter.json"),
      JSON.stringify({
        id: "ds_invalid_shell",
        name: "Invalid Shell",
        type: "shell",
        connection: { commands: { todo_count: {} } },
        enabled: true,
        created_at: new Date().toISOString(),
      }),
      "utf-8"
    );
    fs.writeFileSync(
      path.join(datasourcesDir, "10-valid.json"),
      JSON.stringify({
        id: "ds_valid_file",
        name: "Valid File",
        type: "file_existence",
        connection: { path: "README.md" },
        enabled: true,
        created_at: new Date().toISOString(),
      }),
      "utf-8"
    );
    const logger = {
      warn: vi.fn(),
      error: vi.fn(),
    };

    try {
      const registry = await buildCliDataSourceRegistry(tmpDir, logger);

      expect(registry.listSources()).toEqual(expect.arrayContaining([
        "ds_builtin_workspace_artifacts",
        "ds_valid_file",
      ]));
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("00-malformed.json"));
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("01-invalid-schema.json"));
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("02-invalid-adapter.json"));
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      if (originalHome === undefined) {
        delete process.env["PULSEED_HOME"];
      } else {
        process.env["PULSEED_HOME"] = originalHome;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it("loads persisted shell datasource commands through the config schema", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-datasource-bootstrap-"));
    const originalHome = process.env["PULSEED_HOME"];
    process.env["PULSEED_HOME"] = tmpDir;
    const datasourcesDir = getDatasourcesDir(tmpDir);
    fs.mkdirSync(datasourcesDir, { recursive: true });
    fs.writeFileSync(
      path.join(datasourcesDir, "shell.json"),
      JSON.stringify({
        id: "ds_shell",
        name: "Shell",
        type: "shell",
        connection: {
          path: tmpDir,
          commands: {
            todo_count: {
              argv: ["echo", "1"],
              output_type: "number",
              timeout_ms: 1000,
            },
          },
        },
        enabled: true,
        created_at: new Date().toISOString(),
      }),
      "utf-8"
    );
    const logger = {
      warn: vi.fn(),
      error: vi.fn(),
    };

    try {
      const registry = await buildCliDataSourceRegistry(tmpDir, logger);

      expect(registry.listSources()).toEqual(expect.arrayContaining([
        "ds_builtin_workspace_artifacts",
        "ds_shell",
      ]));
      const shellSource = registry.getSource("ds_shell");
      expect(shellSource.getSupportedDimensions?.()).toEqual(["todo_count"]);
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      if (originalHome === undefined) {
        delete process.env["PULSEED_HOME"];
      } else {
        process.env["PULSEED_HOME"] = originalHome;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
});
