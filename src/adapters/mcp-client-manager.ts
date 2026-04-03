// ─── MCPClientManager ───
//
// Manages multiple MCP server connections loaded from a config file.
// Each enabled server gets its own MCPDataSourceAdapter backed by a real
// MCP Client. For testability, a connection factory can be injected.

import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { MCPServersConfigSchema } from "../types/mcp.js";
import type { MCPServerConfig, IMCPConnection } from "../types/mcp.js";
import { MCPDataSourceAdapter } from "./datasources/mcp-datasource.js";

const CONFIG_FILE = "mcp-servers.json";

// ─── ServerStatus ───

export interface ServerStatus {
  id: string;
  name: string;
  enabled: boolean;
  connected: boolean;
}

// ─── Connection factory type ───

export type MCPConnectionFactory = (config: MCPServerConfig) => IMCPConnection;

// ─── Default factory using real MCP SDK ───

async function createRealConnection(config: MCPServerConfig): Promise<IMCPConnection> {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  let connected = false;

  // Dynamically import transports to avoid loading them when mocked
  let transport: import("@modelcontextprotocol/sdk/shared/transport.js").Transport;

  if (config.transport === "stdio") {
    const { StdioClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/stdio.js"
    );
    transport = new StdioClientTransport({
      command: config.command ?? "",
      args: config.args ?? [],
      env: config.env,
    });
  } else {
    const { SSEClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/sse.js"
    );
    transport = new SSEClientTransport(new URL(config.url ?? ""));
  }

  const client = new Client({ name: "pulseed", version: "0.1.0" }, { capabilities: {} });

  return {
    async connect() {
      await client.connect(transport);
      connected = true;
    },
    async listTools() {
      const result = await client.listTools();
      return result.tools.map((t: { name: string }) => ({ name: t.name }));
    },
    async callTool(name: string, args: Record<string, unknown>) {
      const result = await client.callTool({ name, arguments: args });
      return result as { content: Array<{ type: string; text?: string }> };
    },
    async close() {
      await client.close();
      connected = false;
    },
    isConnected() {
      return connected;
    },
  };
}

// ─── MCPClientManager ───

export class MCPClientManager {
  private readonly baseDir: string;
  private readonly connectionFactory?: MCPConnectionFactory;
  private adapters: Map<string, MCPDataSourceAdapter> = new Map();
  private serverConfigs: MCPServerConfig[] = [];

  constructor(baseDir: string, connectionFactory?: MCPConnectionFactory) {
    this.baseDir = baseDir;
    this.connectionFactory = connectionFactory;
  }

  async loadConfig(): Promise<MCPServerConfig[]> {
    const configPath = path.join(this.baseDir, CONFIG_FILE);
    let raw: string;
    try {
      raw = await fsp.readFile(configPath, "utf-8");
    } catch {
      // No config file — return empty list
      this.serverConfigs = [];
      return [];
    }

    const parsed = MCPServersConfigSchema.parse(JSON.parse(raw));
    this.serverConfigs = parsed.servers;
    return this.serverConfigs;
  }

  async connectAll(): Promise<MCPDataSourceAdapter[]> {
    const configs = this.serverConfigs.length > 0
      ? this.serverConfigs
      : await this.loadConfig();

    const results: MCPDataSourceAdapter[] = [];

    for (const config of configs) {
      if (!config.enabled) continue;

      let connection: IMCPConnection;
      if (this.connectionFactory) {
        connection = this.connectionFactory(config);
      } else {
        connection = await createRealConnection(config);
      }

      const adapter = new MCPDataSourceAdapter(config, connection);
      try {
        await adapter.connect();
        this.adapters.set(config.id, adapter);
        results.push(adapter);
      } catch (err) {
        // Connection failure is non-fatal — log and skip
        console.warn(`[MCPClientManager] Failed to connect to "${config.name}": ${String(err)}`);
      }
    }

    return results;
  }

  async disconnectAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      try {
        await adapter.disconnect();
      } catch {
        // Ignore disconnect errors
      }
    }
    this.adapters.clear();
  }

  getAdapter(serverId: string): MCPDataSourceAdapter | undefined {
    return this.adapters.get(serverId);
  }

  async listServers(): Promise<ServerStatus[]> {
    const configs = this.serverConfigs.length > 0
      ? this.serverConfigs
      : await this.loadConfig();

    return configs.map((c) => ({
      id: c.id,
      name: c.name,
      enabled: c.enabled,
      connected: this.adapters.get(c.id) !== undefined,
    }));
  }
}
