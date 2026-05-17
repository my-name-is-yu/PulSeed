import { describe, it, expect, vi, beforeEach } from "vitest";
import { MCPDataSourceAdapter } from "../datasources/mcp-datasource.js";
import type { IMCPConnection } from "../../base/types/mcp.js";
import type { MCPServerConfig } from "../../base/types/mcp.js";

// ─── Helpers ───

function makeConnection(overrides: Partial<IMCPConnection> = {}): IMCPConnection {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue([{ name: "get_coverage" }]),
    callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "42" }] }),
    close: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    ...overrides,
  };
}

function makeServerConfig(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    id: "test-mcp-server",
    name: "Test MCP Server",
    transport: "stdio",
    command: "node",
    args: ["server.js"],
    tool_mappings: [
      {
        tool_name: "get_coverage",
        dimension_pattern: "coverage",
        capability_operation_kind: "read",
        capability_side_effect_profile: "read",
        capability_readiness: "executable_verified",
      },
      {
        tool_name: "get_test_count",
        dimension_pattern: "test_*",
        capability_operation_kind: "read",
        capability_side_effect_profile: "read",
        capability_readiness: "executable_verified",
      },
    ],
    enabled: true,
    ...overrides,
  };
}

// ─── connect / disconnect ───

describe("MCPDataSourceAdapter connect/disconnect", () => {
  it("connect calls connection.connect()", async () => {
    const conn = makeConnection();
    const adapter = new MCPDataSourceAdapter(makeServerConfig(), conn);
    await adapter.connect();
    expect(conn.connect).toHaveBeenCalledOnce();
  });

  it("connect is idempotent (does not reconnect if already connected)", async () => {
    const conn = makeConnection();
    const adapter = new MCPDataSourceAdapter(makeServerConfig(), conn);
    await adapter.connect();
    await adapter.connect();
    expect(conn.connect).toHaveBeenCalledOnce();
  });

  it("disconnect calls connection.close()", async () => {
    const conn = makeConnection();
    const adapter = new MCPDataSourceAdapter(makeServerConfig(), conn);
    await adapter.connect();
    await adapter.disconnect();
    expect(conn.close).toHaveBeenCalledOnce();
  });

  it("disconnect is idempotent (no-op if not connected)", async () => {
    const conn = makeConnection();
    const adapter = new MCPDataSourceAdapter(makeServerConfig(), conn);
    await adapter.disconnect();
    expect(conn.close).not.toHaveBeenCalled();
  });

  it("sourceId and sourceType are set correctly", () => {
    const conn = makeConnection();
    const adapter = new MCPDataSourceAdapter(makeServerConfig({ id: "my-mcp" }), conn);
    expect(adapter.sourceId).toBe("my-mcp");
    expect(adapter.sourceType).toBe("mcp");
  });

  it("config.type is 'mcp'", () => {
    const conn = makeConnection();
    const adapter = new MCPDataSourceAdapter(makeServerConfig(), conn);
    expect(adapter.config.type).toBe("mcp");
  });
});

// ─── healthCheck ───

describe("MCPDataSourceAdapter.healthCheck", () => {
  it("returns true when connection.isConnected() is true", async () => {
    const conn = makeConnection({ isConnected: vi.fn().mockReturnValue(true) });
    const adapter = new MCPDataSourceAdapter(makeServerConfig(), conn);
    expect(await adapter.healthCheck()).toBe(true);
  });

  it("returns false when connection.isConnected() is false", async () => {
    const conn = makeConnection({ isConnected: vi.fn().mockReturnValue(false) });
    const adapter = new MCPDataSourceAdapter(makeServerConfig(), conn);
    expect(await adapter.healthCheck()).toBe(false);
  });
});

// ─── getSupportedDimensions ───

describe("MCPDataSourceAdapter.getSupportedDimensions", () => {
  it("returns the dimension patterns from tool_mappings", () => {
    const conn = makeConnection();
    const adapter = new MCPDataSourceAdapter(makeServerConfig(), conn);
    const dims = adapter.getSupportedDimensions();
    expect(dims).toContain("coverage");
    expect(dims).toContain("test_*");
  });
});

// ─── query — matching dimension ───

describe("MCPDataSourceAdapter.query with matching dimension", () => {
  let conn: IMCPConnection;
  let adapter: MCPDataSourceAdapter;

  beforeEach(() => {
    conn = makeConnection();
    adapter = new MCPDataSourceAdapter(makeServerConfig(), conn);
  });

  it("calls the correct tool for an exact-match dimension", async () => {
    const result = await adapter.query({ dimension_name: "coverage", timeout_ms: 5000 });
    expect(conn.callTool).toHaveBeenCalledWith("get_coverage", expect.objectContaining({ dimension_name: "coverage" }));
    expect(result.value).toBe(42);
    expect(result.source_id).toBe("test-mcp-server");
  });

  it("records descriptor admission and fingerprint before a verified read-only MCP call", async () => {
    const order: string[] = [];
    const recordTrace = vi.fn(async (trace: any) => {
      order.push("trace");
      return {
        trace_id: trace.trace_id,
        replay_key: trace.replay_key,
        situation_frame: trace.situation_frame,
        initiative_events: trace.initiative_events,
        attention_transitions: trace.attention_transitions,
        task_candidates: trace.task_candidates,
        capability_decisions: trace.capability_decisions,
        intervention_decisions: trace.intervention_decisions,
        runtime_graph_nodes: trace.runtime_graph_nodes,
        runtime_graph_edges: trace.runtime_graph_edges,
        memory_audits: trace.memory_audits,
      };
    });
    const tracedConn = makeConnection({
      callTool: vi.fn(async () => {
        order.push("callTool");
        return { content: [{ type: "text", text: "42" }] };
      }),
    });
    const tracedAdapter = new MCPDataSourceAdapter(makeServerConfig(), tracedConn, {
      personalAgentRuntime: { recordTrace },
    });

    await tracedAdapter.query({ dimension_name: "coverage", timeout_ms: 5000 });

    expect(order).toEqual(["trace", "callTool"]);
    expect(recordTrace).toHaveBeenCalledOnce();
    expect(recordTrace.mock.calls[0]?.[0]).toMatchObject({
      situation_frame: {
        caller_path: "external_signal",
      },
      capability_decisions: expect.arrayContaining([
        expect.objectContaining({
          decision: "available",
          capability_refs: expect.arrayContaining([
            expect.objectContaining({ kind: "capability_admission" }),
            expect.objectContaining({ kind: "capability_fingerprint" }),
            expect.objectContaining({ kind: "mcp_tool", ref: "get_coverage" }),
          ]),
        }),
      ]),
    });
  });

  it("fails closed before calling imported MCP tools without verified capability readiness", async () => {
    const config = makeServerConfig({
      tool_mappings: [
        { tool_name: "get_coverage", dimension_pattern: "coverage" },
      ],
    });
    const adapter2 = new MCPDataSourceAdapter(config, conn);

    const result = await adapter2.query({ dimension_name: "coverage", timeout_ms: 5000 });

    expect(conn.callTool).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      value: null,
      raw: null,
      source_id: "test-mcp-server",
      metadata: {
        error: expect.stringContaining("Capability Plane blocked MCP datasource tool get_coverage"),
      },
    });
  });

  it("does not treat executable readiness as approval for mutating MCP datasource tools", async () => {
    const config = makeServerConfig({
      tool_mappings: [
        {
          tool_name: "update_remote_metric",
          dimension_pattern: "coverage",
          capability_readiness: "executable_verified",
        },
      ],
    });
    const adapter2 = new MCPDataSourceAdapter(config, conn);

    const result = await adapter2.query({ dimension_name: "coverage", timeout_ms: 5000 });

    expect(conn.callTool).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      value: null,
      raw: null,
      metadata: {
        error: expect.stringContaining("requires approval before mutate"),
      },
    });
  });

  it("calls the correct tool for a wildcard-matched dimension", async () => {
    (conn.callTool as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      content: [{ type: "text", text: "100" }],
    });
    const result = await adapter.query({ dimension_name: "test_count", timeout_ms: 5000 });
    expect(conn.callTool).toHaveBeenCalledWith("get_test_count", expect.objectContaining({ dimension_name: "test_count" }));
    expect(result.value).toBe(100);
  });

  it("passes args_template to the tool call", async () => {
    const config = makeServerConfig({
      tool_mappings: [
        {
          tool_name: "get_metric",
          dimension_pattern: "coverage",
          args_template: { threshold: 80 },
          capability_operation_kind: "read",
          capability_side_effect_profile: "read",
          capability_readiness: "executable_verified",
        },
      ],
    });
    const adapter2 = new MCPDataSourceAdapter(config, conn);
    await adapter2.query({ dimension_name: "coverage", timeout_ms: 5000 });
    expect(conn.callTool).toHaveBeenCalledWith(
      "get_metric",
      expect.objectContaining({ threshold: 80, dimension_name: "coverage" })
    );
  });

  it("parses boolean 'true' from tool result", async () => {
    (conn.callTool as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      content: [{ type: "text", text: "true" }],
    });
    const result = await adapter.query({ dimension_name: "coverage", timeout_ms: 5000 });
    expect(result.value).toBe(true);
  });

  it("parses boolean 'false' from tool result", async () => {
    (conn.callTool as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      content: [{ type: "text", text: "false" }],
    });
    const result = await adapter.query({ dimension_name: "coverage", timeout_ms: 5000 });
    expect(result.value).toBe(false);
  });

  it("parses 'null' string as null", async () => {
    (conn.callTool as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      content: [{ type: "text", text: "null" }],
    });
    const result = await adapter.query({ dimension_name: "coverage", timeout_ms: 5000 });
    expect(result.value).toBeNull();
  });

  it("returns string value for non-numeric text", async () => {
    (conn.callTool as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      content: [{ type: "text", text: "some-string" }],
    });
    const result = await adapter.query({ dimension_name: "coverage", timeout_ms: 5000 });
    expect(result.value).toBe("some-string");
  });

  it.each(["Infinity", "-Infinity", "1e309", "0x1"])(
    "returns %s as text instead of broad numeric coercion",
    async (text) => {
      (conn.callTool as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        content: [{ type: "text", text }],
      });

      const result = await adapter.query({ dimension_name: "coverage", timeout_ms: 5000 });

      expect(result.value).toBe(text);
    }
  );

  it("parses exact finite numeric tokens from tool text", async () => {
    (conn.callTool as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      content: [{ type: "text", text: " 1e3 " }],
    });

    const result = await adapter.query({ dimension_name: "coverage", timeout_ms: 5000 });

    expect(result.value).toBe(1000);
  });

  it("returns null when content array is empty", async () => {
    (conn.callTool as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      content: [],
    });
    const result = await adapter.query({ dimension_name: "coverage", timeout_ms: 5000 });
    expect(result.value).toBeNull();
  });
});

// ─── query — non-matching dimension ───

describe("MCPDataSourceAdapter.query with non-matching dimension", () => {
  it("returns null value without calling the tool", async () => {
    const conn = makeConnection();
    const adapter = new MCPDataSourceAdapter(makeServerConfig(), conn);
    const result = await adapter.query({ dimension_name: "unknown_dimension", timeout_ms: 5000 });
    expect(conn.callTool).not.toHaveBeenCalled();
    expect(result.value).toBeNull();
    expect(result.source_id).toBe("test-mcp-server");
  });
});

// ─── query — error handling ───

describe("MCPDataSourceAdapter.query error handling", () => {
  it("returns null value when callTool throws", async () => {
    const conn = makeConnection({
      callTool: vi.fn().mockRejectedValue(new Error("MCP tool failed")),
    });
    const adapter = new MCPDataSourceAdapter(makeServerConfig(), conn);
    const result = await adapter.query({ dimension_name: "coverage", timeout_ms: 5000 });
    expect(result.value).toBeNull();
    expect(result.metadata?.error).toContain("MCP tool failed");
  });
});
