import { describe, expect, it } from "vitest";
import type { MCPServerConfig } from "../../../base/types/mcp.js";
import {
  evaluateMcpOperationCompatibility,
  summarizeMcpImportCompatibility,
  type McpOperationVerificationKey,
} from "../compatibility.js";

function makeServer(overrides: Partial<MCPServerConfig> = {}): MCPServerConfig {
  return {
    id: "openclaw-filesystem",
    name: "Filesystem",
    transport: "stdio",
    command: "node",
    args: ["server.js"],
    tool_mappings: [
      {
        tool_name: "read_file",
        dimension_pattern: "filesystem_read",
      },
    ],
    enabled: false,
    ...overrides,
  };
}

describe("MCP compatibility", () => {
  it("keeps imported MCP servers non-executable until every operation-specific gate passes", () => {
    const server = makeServer();
    const snapshot = evaluateMcpOperationCompatibility(server, {
      tool_name: "read_file",
      operation_kind: "read",
      payload_class: "path",
      risk_class: "low",
      side_effect_profile: "read",
    }, {
      listed_tools: ["read_file"],
    });

    expect(snapshot.execution).toEqual({
      executable: false,
      reason: "mcp_config_disabled",
    });
    expect(snapshot.states).toMatchObject({
      config_imported: true,
      config_enabled: false,
      tool_list_available: true,
      tool_alias_mapped: true,
      operation_specific_verified: false,
      blocked: true,
    });
    expect(snapshot.blockers).toEqual(expect.arrayContaining([
      "mcp_config_disabled",
      "mcp_server_not_spawnable",
      "mcp_auth_or_env_not_validated",
      "mcp_operation_contract_not_mapped",
      "mcp_operation_specific_verification_missing",
    ]));
  });

  it("requires verification keyed by operation kind, payload class, risk class, and side-effect profile", () => {
    const server = makeServer({ enabled: true });
    const readKey: McpOperationVerificationKey = {
      provider: "mcp",
      server_id: "openclaw-filesystem",
      tool_name: "read_file",
      operation_kind: "read",
      payload_class: "path",
      risk_class: "low",
      side_effect_profile: "read",
    };

    const readSnapshot = evaluateMcpOperationCompatibility(server, {
      tool_name: "read_file",
      operation_kind: "read",
      payload_class: "path",
      risk_class: "low",
      side_effect_profile: "read",
    }, {
      server_spawnable: true,
      listed_tools: ["read_file"],
      auth_or_env_valid: true,
      operation_contract_mapped: true,
      operation_verifications: [{
        key: readKey,
        status: "verified",
        verified_at: "2026-05-09T00:00:00.000Z",
        evidence_ref: "audit:mcp-read",
      }],
    });
    const writeSnapshot = evaluateMcpOperationCompatibility(server, {
      tool_name: "read_file",
      operation_kind: "write",
      payload_class: "path",
      risk_class: "medium",
      side_effect_profile: "write",
    }, {
      server_spawnable: true,
      listed_tools: ["read_file"],
      auth_or_env_valid: true,
      operation_contract_mapped: true,
      operation_verifications: [{
        key: readKey,
        status: "verified",
        verified_at: "2026-05-09T00:00:00.000Z",
        evidence_ref: "audit:mcp-read",
      }],
    });

    expect(readSnapshot.execution).toEqual({
      executable: true,
      reason: "mcp_operation_verified",
    });
    expect(writeSnapshot.execution).toEqual({
      executable: false,
      reason: "mcp_operation_specific_verification_missing",
    });
    expect(writeSnapshot.states.operation_specific_verified).toBe(false);
  });

  it("records import compatibility as asset evidence without executable readiness", () => {
    const summary = summarizeMcpImportCompatibility(makeServer({
      enabled: false,
      tool_mappings: [],
    }));

    expect(summary).toMatchObject({
      schema_version: "mcp-import-compatibility/v1",
      server_id: "openclaw-filesystem",
      execution: {
        executable: false,
        reason: "mcp_operation_specific_verification_required",
      },
    });
    expect(summary.states).toMatchObject({
      config_imported: true,
      config_enabled: false,
      tool_alias_mapped: false,
      operation_specific_verified: false,
      blocked: true,
    });
    expect(summary.operation_verification_key_fields).toEqual([
      "provider",
      "server_id",
      "tool_name",
      "operation_kind",
      "payload_class",
      "risk_class",
      "side_effect_profile",
    ]);
  });
});
