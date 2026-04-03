import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { MCPClientManager } from "../mcp-client-manager.js";
import type { IMCPConnection, MCPServerConfig } from "../../types/mcp.js";
import { makeTempDir, cleanupTempDir } from "../../../tests/helpers/temp-dir.js";

// ─── Mock IMCPConnection factory ───

function makeMockConnection(): IMCPConnection {
  let connected = false;
  return {
    async connect() { connected = true; },
    async close() { connected = false; },
    isConnected() { return connected; },
    async listTools() { return []; },
    async callTool() { return { content: [] }; },
  };
}

// ─── Helpers ───

function writeConfig(dir: string, servers: unknown[]): void {
  fs.writeFileSync(
    path.join(dir, "mcp-servers.json"),
    JSON.stringify({ servers }),
    "utf-8"
  );
}

function makeServerEntry(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    id: "server-1",
    name: "Test Server",
    transport: "stdio",
    command: "node",
    args: ["server.js"],
    tool_mappings: [{ tool_name: "get_coverage", dimension_pattern: "coverage" }],
    enabled: true,
    ...overrides,
  };
}

// ─── Tests ───

describe("MCPClientManager.loadConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("mcp-mgr-test-");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("returns empty array when config file does not exist", async () => {
    const manager = new MCPClientManager(tmpDir);
    const configs = await manager.loadConfig();
    expect(configs).toEqual([]);
  });

  it("does not throw when config file is missing", async () => {
    const manager = new MCPClientManager(tmpDir);
    await expect(manager.loadConfig()).resolves.not.toThrow();
  });

  it("loads and parses a valid config file", async () => {
    writeConfig(tmpDir, [makeServerEntry({ id: "srv-a" })]);
    const manager = new MCPClientManager(tmpDir);
    const configs = await manager.loadConfig();
    expect(configs).toHaveLength(1);
    expect(configs[0].id).toBe("srv-a");
  });

  it("loads multiple server entries", async () => {
    writeConfig(tmpDir, [
      makeServerEntry({ id: "srv-1" }),
      makeServerEntry({ id: "srv-2" }),
    ]);
    const manager = new MCPClientManager(tmpDir);
    const configs = await manager.loadConfig();
    expect(configs).toHaveLength(2);
    const ids = configs.map((c) => c.id);
    expect(ids).toContain("srv-1");
    expect(ids).toContain("srv-2");
  });

  it("throws on malformed JSON", async () => {
    fs.writeFileSync(path.join(tmpDir, "mcp-servers.json"), "{ invalid json", "utf-8");
    const manager = new MCPClientManager(tmpDir);
    await expect(manager.loadConfig()).rejects.toThrow();
  });
});

// ─── connectAll ───

describe("MCPClientManager.connectAll", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("mcp-mgr-test-");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("returns empty array when no config file", async () => {
    const manager = new MCPClientManager(tmpDir, makeMockConnection);
    const adapters = await manager.connectAll();
    expect(adapters).toEqual([]);
  });

  it("creates an adapter for each enabled server", async () => {
    writeConfig(tmpDir, [
      makeServerEntry({ id: "srv-1" }),
      makeServerEntry({ id: "srv-2" }),
    ]);
    const connectionFactory = vi.fn().mockImplementation(makeMockConnection);
    const manager = new MCPClientManager(tmpDir, connectionFactory);
    const adapters = await manager.connectAll();
    expect(adapters).toHaveLength(2);
    expect(connectionFactory).toHaveBeenCalledTimes(2);
  });

  it("skips disabled servers", async () => {
    writeConfig(tmpDir, [
      makeServerEntry({ id: "enabled-srv", enabled: true }),
      makeServerEntry({ id: "disabled-srv", enabled: false }),
    ]);
    const connectionFactory = vi.fn().mockImplementation(makeMockConnection);
    const manager = new MCPClientManager(tmpDir, connectionFactory);
    const adapters = await manager.connectAll();
    expect(adapters).toHaveLength(1);
    expect(adapters[0].sourceId).toBe("enabled-srv");
  });

  it("adapter sourceType is 'mcp'", async () => {
    writeConfig(tmpDir, [makeServerEntry({ id: "srv-x" })]);
    const manager = new MCPClientManager(tmpDir, makeMockConnection);
    const adapters = await manager.connectAll();
    expect(adapters[0].sourceType).toBe("mcp");
  });

  it("continues when a single connection fails", async () => {
    writeConfig(tmpDir, [
      makeServerEntry({ id: "good-srv" }),
      makeServerEntry({ id: "bad-srv" }),
    ]);

    let callCount = 0;
    const connectionFactory = (_cfg: MCPServerConfig): IMCPConnection => {
      callCount++;
      if (callCount === 2) {
        // Second server's connection will fail on connect
        return {
          async connect() { throw new Error("Connection refused"); },
          async close() {},
          isConnected() { return false; },
          async listTools() { return []; },
          async callTool() { return { content: [] }; },
        };
      }
      return makeMockConnection();
    };

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const manager = new MCPClientManager(tmpDir, connectionFactory);
    const adapters = await manager.connectAll();

    expect(adapters).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

// ─── getAdapter ───

describe("MCPClientManager.getAdapter", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("mcp-mgr-test-");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("returns undefined for unknown server id", async () => {
    const manager = new MCPClientManager(tmpDir, makeMockConnection);
    expect(manager.getAdapter("nonexistent")).toBeUndefined();
  });

  it("returns the adapter after connectAll", async () => {
    writeConfig(tmpDir, [makeServerEntry({ id: "srv-z" })]);
    const manager = new MCPClientManager(tmpDir, makeMockConnection);
    await manager.connectAll();
    const adapter = manager.getAdapter("srv-z");
    expect(adapter).toBeDefined();
    expect(adapter?.sourceId).toBe("srv-z");
  });
});

// ─── listServers ───

describe("MCPClientManager.listServers", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("mcp-mgr-test-");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("returns empty array when no config file", async () => {
    const manager = new MCPClientManager(tmpDir, makeMockConnection);
    const servers = await manager.listServers();
    expect(servers).toEqual([]);
  });

  it("lists all servers with enabled and connected fields", async () => {
    writeConfig(tmpDir, [
      makeServerEntry({ id: "srv-on", enabled: true }),
      makeServerEntry({ id: "srv-off", enabled: false }),
    ]);
    const manager = new MCPClientManager(tmpDir, makeMockConnection);
    const servers = await manager.listServers();
    expect(servers).toHaveLength(2);
    const srvOn = servers.find((s) => s.id === "srv-on");
    const srvOff = servers.find((s) => s.id === "srv-off");
    expect(srvOn?.enabled).toBe(true);
    expect(srvOff?.enabled).toBe(false);
  });

  it("shows connected=true for servers that have been connected", async () => {
    writeConfig(tmpDir, [makeServerEntry({ id: "srv-conn" })]);
    const manager = new MCPClientManager(tmpDir, makeMockConnection);
    await manager.connectAll();
    const servers = await manager.listServers();
    const srv = servers.find((s) => s.id === "srv-conn");
    expect(srv?.connected).toBe(true);
  });

  it("shows connected=false for servers not yet connected", async () => {
    writeConfig(tmpDir, [makeServerEntry({ id: "srv-idle" })]);
    const manager = new MCPClientManager(tmpDir, makeMockConnection);
    // loadConfig only, no connectAll
    await manager.loadConfig();
    const servers = await manager.listServers();
    const srv = servers.find((s) => s.id === "srv-idle");
    expect(srv?.connected).toBe(false);
  });
});

// ─── disconnectAll ───

describe("MCPClientManager.disconnectAll", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTempDir("mcp-mgr-test-");
  });

  afterEach(() => {
    cleanupTempDir(tmpDir);
  });

  it("disconnects all connected adapters", async () => {
    writeConfig(tmpDir, [
      makeServerEntry({ id: "srv-1" }),
      makeServerEntry({ id: "srv-2" }),
    ]);
    const connections: IMCPConnection[] = [];
    const factory = (_cfg: MCPServerConfig): IMCPConnection => {
      const conn = makeMockConnection();
      connections.push(conn);
      return conn;
    };
    const manager = new MCPClientManager(tmpDir, factory);
    await manager.connectAll();
    await manager.disconnectAll();

    for (const conn of connections) {
      expect(conn.isConnected()).toBe(false);
    }
  });

  it("getAdapter returns undefined after disconnectAll", async () => {
    writeConfig(tmpDir, [makeServerEntry({ id: "srv-1" })]);
    const manager = new MCPClientManager(tmpDir, makeMockConnection);
    await manager.connectAll();
    await manager.disconnectAll();
    expect(manager.getAdapter("srv-1")).toBeUndefined();
  });
});
