import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { StateManager } from "../../../../base/state/state-manager.js";
import {
  PersonalAgentRuntimeStore,
  buildPersonalAgentDecisionTrace,
} from "../../../../runtime/personal-agent/index.js";
import { cleanupTempDir, makeTempDir } from "../../../../../tests/helpers/temp-dir.js";
import { cmdRuntime } from "../runtime.js";

describe("runtime initiative-trace normal projection", () => {
  it("projects a durable personal-agent trace through the CLI without raw trace refs, memory refs, or policy refs", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-normal-trace-");
    const rawTraceSecret = "trace-secret-must-not-render";
    const rawMemoryRef = "memory:raw-private-ref";
    const rawPolicyRef = "policy:raw-internal";
    const rawAuditRef = "audit:raw-evidence";
    try {
      const stateManager = new StateManager(tmpDir);
      await stateManager.init();
      const store = new PersonalAgentRuntimeStore(path.join(tmpDir, "runtime"), {
        controlBaseDir: tmpDir,
      });
      const trace = buildPersonalAgentDecisionTrace({
        callerPath: "memory_correction",
        source: {
          sourceKind: "memory_operation",
          sourceId: "memory-operation-raw-id",
          emittedAt: "2026-05-16T00:00:00.000Z",
          summary: rawTraceSecret,
          sourceRef: { kind: "memory_correction", ref: "correction:raw-id" },
        },
        target: {
          kind: "memory_update",
          ref: { kind: "memory", ref: rawMemoryRef },
          effect: "write_memory",
          summary: "raw target summary must not render",
        },
        decision: "allow",
        decisionReason: "raw policy reason must not render",
        policyRef: { kind: "intervention_policy", ref: rawPolicyRef },
        currentRefs: [{ kind: "memory", ref: rawMemoryRef }],
        staleRefs: [{ kind: "memory", ref: rawMemoryRef }],
        auditRefs: [{ kind: "audit_trace", ref: rawAuditRef }],
      });
      await store.recordTrace(trace);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

      const code = await cmdRuntime(stateManager, ["initiative-trace", trace.trace_id, "--normal", "--json"]);
      const output = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      logSpy.mockRestore();

      expect(code).toBe(0);
      expect(output).not.toContain(trace.trace_id);
      expect(output).not.toContain(rawTraceSecret);
      expect(output).not.toContain(rawMemoryRef);
      expect(output).not.toContain(rawPolicyRef);
      expect(output).not.toContain(rawAuditRef);
      expect(output).not.toContain("raw target summary");
      expect(output).not.toContain("raw policy reason");
      const projection = JSON.parse(output) as {
        schema_version: string;
        surface_target: string;
        why_now: string;
        what_i_will_do: string;
        confidence_or_uncertainty: string | null;
        action_authority_increased: boolean;
        raw_refs_visible: boolean;
        raw_evidence_refs_visible: boolean;
        internal_policy_refs_visible: boolean;
      };
      expect(projection).toMatchObject({
        schema_version: "personal-agent-normal-surface-projection/v1",
        surface_target: "normal_user",
        why_now: "You asked PulSeed to update how a memory may be used.",
        what_i_will_do: "Record the logical memory update so future decisions do not rely on invalidated memory.",
        action_authority_increased: false,
        raw_refs_visible: false,
        raw_evidence_refs_visible: false,
        internal_policy_refs_visible: false,
      });
      expect(projection.confidence_or_uncertainty).toContain("withheld, stale, corrected, or uncertain");
    } finally {
      cleanupTempDir(tmpDir);
    }
  });
});
