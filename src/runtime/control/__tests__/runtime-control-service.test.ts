import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { RuntimeOperationStore } from "../../store/runtime-operation-store.js";
import {
  PermissionGrantStore,
  type PermissionGrantCreateInput,
} from "../../store/permission-grant-store.js";
import { RuntimeControlService } from "../runtime-control-service.js";
import type { RuntimeSessionRegistrySnapshot } from "../../session-registry/types.js";
import { BrowserSessionStore, RuntimeAuthHandoffStore } from "../../interactive-automation/index.js";
import { GuardrailStore } from "../../guardrails/index.js";

function snapshotWithRuns(runs: RuntimeSessionRegistrySnapshot["background_runs"]): RuntimeSessionRegistrySnapshot {
  return {
    schema_version: "runtime-session-registry-v1",
    generated_at: "2026-05-02T00:00:00.000Z",
    sessions: [],
    background_runs: runs,
    warnings: [],
  };
}

function makeRun(input: Partial<RuntimeSessionRegistrySnapshot["background_runs"][number]> = {}): RuntimeSessionRegistrySnapshot["background_runs"][number] {
  return {
    schema_version: "background-run-v1",
    id: "run:coreloop:active",
    kind: "coreloop_run",
    parent_session_id: null,
    child_session_id: "session:coreloop:worker-1",
    process_session_id: null,
    goal_id: "goal-1",
    status: "running",
    notify_policy: "done_only",
    reply_target_source: "none",
    pinned_reply_target: null,
    title: "DurableLoop goal goal-1",
    workspace: "/repo",
    created_at: "2026-05-02T00:00:00.000Z",
    started_at: "2026-05-02T00:00:00.000Z",
    updated_at: "2026-05-02T00:00:00.000Z",
    completed_at: null,
    summary: null,
    error: null,
    artifacts: [],
    source_refs: [],
    ...input,
  };
}

function makeGrant(input: Partial<PermissionGrantCreateInput> = {}): PermissionGrantCreateInput {
  return {
    grant_id: "grant-current-run",
    subject: { kind: "operator", id: "U123" },
    origin: {
      channel: "slack",
      platform: "slack",
      conversation_id: "C123:1700.1",
      user_id: "U123",
      session_id: "identity:workspace:U123",
      turn_id: "1700.2",
    },
    source: {
      kind: "redacted_text",
      redacted_text: "raw approval text with sensitive details",
      redaction_reason: "test",
    },
    scope: { kind: "run", run_id: "run-chat-1" },
    duration: { kind: "until_run_done" },
    capabilities: ["write_workspace", "run_tests"],
    excluded_capabilities: ["write_remote", "network_send"],
    ...input,
  };
}

describe("RuntimeControlService", () => {
  it("inspects active permission grants with redacted shared state", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-permission-inspect-");
    try {
      const runtimeRoot = path.join(tmpDir, "runtime");
      const operationStore = new RuntimeOperationStore(runtimeRoot);
      const permissionGrantStore = new PermissionGrantStore(runtimeRoot);
      await permissionGrantStore.createActive(makeGrant());
      const service = new RuntimeControlService({ operationStore, permissionGrantStore });

      const result = await service.request({
        intent: { kind: "inspect_permission_boundary", reason: "what is allowed" },
        cwd: "/repo",
        requestedBy: {
          surface: "chat",
          platform: "slack",
          conversation_id: "C123:1700.1",
          user_id: "U123",
        },
        replyTarget: {
          surface: "chat",
          platform: "slack",
          conversation_id: "C123:1700.1",
          user_id: "U123",
        },
      });

      expect(result).toMatchObject({ success: true, state: "verified" });
      expect(result.message).toContain("grant-current-run");
      expect(result.message).toContain("write_workspace, run_tests");
      expect(result.message).toContain("write_remote, network_send");
      expect(result.message).toContain("source=redacted");
      expect(result.message).not.toContain("raw approval text");
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("revokes active grants and removes them from active reuse", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-permission-revoke-");
    try {
      const runtimeRoot = path.join(tmpDir, "runtime");
      const operationStore = new RuntimeOperationStore(runtimeRoot);
      const permissionGrantStore = new PermissionGrantStore(runtimeRoot);
      await permissionGrantStore.createActive(makeGrant());
      const service = new RuntimeControlService({ operationStore, permissionGrantStore });

      const result = await service.request({
        intent: { kind: "revoke_permission", reason: "revoke this permission" },
        cwd: "/repo",
        requestedBy: {
          surface: "chat",
          platform: "slack",
          conversation_id: "C123:1700.1",
          user_id: "U123",
        },
        replyTarget: {
          surface: "chat",
          platform: "slack",
          conversation_id: "C123:1700.1",
          user_id: "U123",
        },
      });

      expect(result).toMatchObject({ success: true, state: "verified" });
      expect(result.message).toContain("Future covered actions will ask again or block");
      await expect(permissionGrantStore.load("grant-current-run")).resolves.toMatchObject({
        state: "revoked",
        revoked_by: "U123",
      });
      await expect(permissionGrantStore.listActive()).resolves.toHaveLength(0);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("does not fall back to grants from another chat context", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-permission-context-");
    try {
      const runtimeRoot = path.join(tmpDir, "runtime");
      const operationStore = new RuntimeOperationStore(runtimeRoot);
      const permissionGrantStore = new PermissionGrantStore(runtimeRoot);
      await permissionGrantStore.createActive(makeGrant({
        grant_id: "grant-other-chat",
        origin: {
          channel: "slack",
          platform: "slack",
          conversation_id: "C999:1700.1",
          user_id: "U123",
          session_id: "identity:workspace:U999",
          turn_id: "1700.2",
        },
      }));
      const service = new RuntimeControlService({ operationStore, permissionGrantStore });

      const inspected = await service.request({
        intent: { kind: "inspect_permission_boundary", reason: "what is allowed here" },
        cwd: "/repo",
        requestedBy: {
          surface: "chat",
          platform: "slack",
          conversation_id: "C123:1700.1",
          user_id: "U123",
        },
      });
      expect(inspected).toMatchObject({ success: true, state: "verified" });
      expect(inspected.message).toBe("No active PermissionGrant matches this chat/runtime context.");
      expect(inspected.message).not.toContain("grant-other-chat");

      const revoked = await service.request({
        intent: { kind: "revoke_permission", reason: "revoke this permission" },
        cwd: "/repo",
        requestedBy: {
          surface: "chat",
          platform: "slack",
          conversation_id: "C123:1700.1",
          user_id: "U123",
        },
      });
      expect(revoked).toMatchObject({ success: false, state: "blocked" });
      await expect(permissionGrantStore.load("grant-other-chat")).resolves.toMatchObject({
        state: "active",
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("does not let an exact grant id bypass chat permission identity", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-permission-target-context-");
    try {
      const runtimeRoot = path.join(tmpDir, "runtime");
      const operationStore = new RuntimeOperationStore(runtimeRoot);
      const permissionGrantStore = new PermissionGrantStore(runtimeRoot);
      await permissionGrantStore.createActive(makeGrant({
        grant_id: "grant-other-chat",
        origin: {
          channel: "slack",
          platform: "slack",
          conversation_id: "C999:1700.1",
          user_id: "U123",
          session_id: "identity:workspace:U999",
          turn_id: "1700.2",
        },
      }));
      const service = new RuntimeControlService({ operationStore, permissionGrantStore });

      const result = await service.request({
        intent: {
          kind: "revoke_permission",
          reason: "revoke the named grant",
          target: {
            grantId: "grant-other-chat",
            runId: "run-1",
            sessionId: "identity:workspace:U999",
          },
        },
        cwd: "/repo",
        requestedBy: {
          surface: "chat",
          platform: "slack",
          conversation_id: "C123:1700.1",
          user_id: "U123",
        },
        replyTarget: {
          surface: "chat",
          platform: "slack",
          conversation_id: "C123:1700.1",
          user_id: "U123",
        },
      });

      expect(result).toMatchObject({ success: false, state: "blocked" });
      expect(result.message).toBe("No active PermissionGrant matches this chat/runtime context.");
      await expect(permissionGrantStore.load("grant-other-chat")).resolves.toMatchObject({
        state: "active",
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("narrows and extends permission grants through superseding replacements", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-permission-update-");
    try {
      const runtimeRoot = path.join(tmpDir, "runtime");
      const operationStore = new RuntimeOperationStore(runtimeRoot);
      const permissionGrantStore = new PermissionGrantStore(runtimeRoot);
      await permissionGrantStore.createActive(makeGrant());
      const service = new RuntimeControlService({ operationStore, permissionGrantStore });

      const narrowed = await service.request({
        intent: {
          kind: "narrow_permission",
          reason: "allow tests only",
          target: { grantId: "grant-current-run" },
          permissionCapabilities: ["run_tests"],
        },
        cwd: "/repo",
        requestedBy: { surface: "chat", user_id: "U123" },
      });

      expect(narrowed).toMatchObject({ success: true, state: "verified" });
      await expect(permissionGrantStore.load("grant-current-run")).resolves.toMatchObject({
        state: "superseded",
      });
      let active = await permissionGrantStore.listActive();
      expect(active).toHaveLength(1);
      expect(active[0]).toMatchObject({
        capabilities: ["run_tests"],
        supersedes: ["grant-current-run"],
      });

      const extended = await service.request({
        intent: {
          kind: "extend_permission",
          reason: "allow local edits too",
          target: { grantId: active[0]!.grant_id },
          permissionCapabilities: ["write_workspace"],
        },
        cwd: "/repo",
        requestedBy: { surface: "chat", user_id: "U123" },
        approvalFn: vi.fn().mockResolvedValue(true),
      });

      expect(extended).toMatchObject({ success: true, state: "verified" });
      active = await permissionGrantStore.listActive();
      expect(active).toHaveLength(1);
      expect(active[0]?.capabilities).toEqual(["run_tests", "write_workspace"]);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("audits active and inactive permission grant evidence", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-permission-audit-");
    try {
      const runtimeRoot = path.join(tmpDir, "runtime");
      const operationStore = new RuntimeOperationStore(runtimeRoot);
      const permissionGrantStore = new PermissionGrantStore(runtimeRoot);
      await permissionGrantStore.createActive(makeGrant({
        audit_refs: ["tool-call:call-1"],
      }));
      await permissionGrantStore.recordUse("grant-current-run", { audit_ref: "tool-call:call-2" });
      await permissionGrantStore.revoke("grant-current-run", {
        revoked_by: "U123",
        reason: "test revoke",
        audit_refs: ["runtime-control:revoke"],
      });
      const service = new RuntimeControlService({ operationStore, permissionGrantStore });

      const result = await service.request({
        intent: { kind: "audit_permission_check", reason: "why did you not ask" },
        cwd: "/repo",
        requestedBy: {
          surface: "chat",
          platform: "slack",
          conversation_id: "C123:1700.1",
          user_id: "U123",
        },
      });

      expect(result).toMatchObject({ success: true, state: "verified" });
      expect(result.message).toContain("state=revoked");
      expect(result.message).toContain("tool-call:call-1");
      expect(result.message).toContain("tool-call:call-2");
      expect(result.message).toContain("still ask again or block");
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("executes approved restart operations through the configured executor", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-service-");
    try {
      const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
      const executor = vi.fn().mockResolvedValue({
        ok: true,
        state: "acknowledged",
        message: "reload queued",
      });
      const service = new RuntimeControlService({ operationStore, executor });

      const result = await service.request({
        intent: { kind: "restart_gateway", reason: "gateway を再起動して" },
        cwd: "/repo",
        approvalFn: vi.fn().mockResolvedValue(true),
      });

      expect(result).toMatchObject({
        success: true,
        message: "reload queued",
        state: "acknowledged",
      });
      expect(executor).toHaveBeenCalledOnce();
      expect(await operationStore.listCompleted()).toHaveLength(0);
      const pending = await operationStore.listPending();
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        kind: "restart_gateway",
        state: "acknowledged",
        expected_health: {
          daemon_ping: true,
          gateway_acceptance: true,
        },
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("routes reload_config through approval and executor support", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-service-reload-config-");
    try {
      const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
      const executor = vi.fn().mockResolvedValue({ ok: true, state: "verified", message: "config reloaded" });
      const service = new RuntimeControlService({ operationStore, executor });

      const result = await service.request({
        intent: { kind: "reload_config", reason: "runtime 設定を再読み込みして" },
        cwd: "/repo",
        approvalFn: vi.fn().mockResolvedValue(true),
      });

      expect(result).toMatchObject({
        success: true,
        state: "verified",
        message: "config reloaded",
      });
      expect(executor).toHaveBeenCalledOnce();
      expect(await operationStore.listPending()).toHaveLength(0);
      expect(await operationStore.listCompleted()).toHaveLength(1);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("records cancelled operations when required approval is rejected", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-service-rejected-");
    try {
      const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
      const executor = vi.fn();
      const service = new RuntimeControlService({ operationStore, executor });

      const result = await service.request({
        intent: { kind: "restart_daemon", reason: "PulSeed を再起動して" },
        cwd: "/repo",
        approvalFn: vi.fn().mockResolvedValue(false),
      });

      expect(result).toMatchObject({
        success: false,
        message: "Runtime control operation was not approved.",
        state: "cancelled",
      });
      expect(executor).not.toHaveBeenCalled();
      expect(await operationStore.listPending()).toHaveLength(0);
      const completed = await operationStore.listCompleted();
      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({
        kind: "restart_daemon",
        state: "cancelled",
        result: {
          ok: false,
          message: "Runtime control operation was not approved.",
        },
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("completes pending auth handoffs through typed automation control and rejects stale completion", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-auth-handoff-");
    try {
      const runtimeRoot = path.join(tmpDir, "runtime");
      const authHandoffStore = new RuntimeAuthHandoffStore(runtimeRoot);
      const browserSessionStore = new BrowserSessionStore(runtimeRoot);
      await browserSessionStore.recordAuthRequired({
        sessionId: "sess-auth",
        providerId: "browser",
        serviceKey: "mail.example.com",
        workspace: "/repo",
        actorKey: "chat-1",
        failureCode: "auth_required",
        failureMessage: "login required",
      });
      const handoff = await authHandoffStore.createPending({
        providerId: "browser",
        serviceKey: "mail.example.com",
        workspace: "/repo",
        actorKey: "chat-1",
        browserSessionId: "sess-auth",
        resumableSessionId: "sess-auth",
        taskSummary: "Open mail",
      });
      const service = new RuntimeControlService({
        runtimeRoot,
        authHandoffStore,
        browserSessionStore,
      });

      const completed = await service.controlAutomation({
        domain: "auth_handoff",
        action: "complete",
        handoffId: handoff.handoff_id,
        reason: "operator completed login",
        cwd: "/repo",
        approvalFn: vi.fn().mockResolvedValue(true),
      });
      const stale = await service.controlAutomation({
        domain: "auth_handoff",
        action: "complete",
        handoffId: handoff.handoff_id,
        reason: "repeat stale completion",
        cwd: "/repo",
        approvalFn: vi.fn().mockResolvedValue(true),
      });

      expect(completed).toMatchObject({ success: true, state: "verified" });
      await expect(authHandoffStore.load(handoff.handoff_id)).resolves.toMatchObject({ state: "completed" });
      await expect(browserSessionStore.load("sess-auth")).resolves.toMatchObject({ state: "authenticated" });
      expect(stale).toMatchObject({ success: false, state: "blocked" });
      expect(stale.message).toContain("terminal");
      const completedOperations = await new RuntimeOperationStore(runtimeRoot).listCompleted();
      expect(completedOperations).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "automation_control", state: "verified" }),
        expect.objectContaining({ kind: "automation_control", state: "blocked" }),
      ]));
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("rejects expired auth handoffs and missing linked browser sessions", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-auth-stale-");
    try {
      const runtimeRoot = path.join(tmpDir, "runtime");
      const authHandoffStore = new RuntimeAuthHandoffStore(runtimeRoot);
      const expired = await authHandoffStore.createPending({
        providerId: "browser",
        serviceKey: "mail.example.com",
        workspace: "/repo",
        actorKey: "chat-1",
        browserSessionId: "sess-expired-handoff",
        expiresAt: "2000-01-01T00:00:00.000Z",
        taskSummary: "Open mail",
      });
      const missingSession = await authHandoffStore.createPending({
        providerId: "browser",
        serviceKey: "docs.example.com",
        workspace: "/repo",
        actorKey: "chat-1",
        browserSessionId: "sess-missing",
        taskSummary: "Open docs",
      });
      const service = new RuntimeControlService({ runtimeRoot, authHandoffStore });
      const approvalFn = vi.fn().mockResolvedValue(true);

      const expiredResult = await service.controlAutomation({
        domain: "auth_handoff",
        action: "complete",
        handoffId: expired.handoff_id,
        reason: "complete expired handoff",
        cwd: "/repo",
        approvalFn,
      });
      const missingResult = await service.controlAutomation({
        domain: "auth_handoff",
        action: "complete",
        handoffId: missingSession.handoff_id,
        reason: "complete missing session handoff",
        cwd: "/repo",
        approvalFn,
      });

      expect(expiredResult).toMatchObject({ success: false, state: "blocked" });
      expect(expiredResult.message).toContain("expired");
      await expect(authHandoffStore.load(expired.handoff_id)).resolves.toMatchObject({ state: "expired" });
      expect(missingResult).toMatchObject({ success: false, state: "blocked" });
      expect(missingResult.message).toContain("Linked browser session not found");
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("fails closed for unauthorized automation mutations when approval is unavailable", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-auth-unauthorized-");
    try {
      const runtimeRoot = path.join(tmpDir, "runtime");
      const service = new RuntimeControlService({ runtimeRoot });

      const result = await service.controlAutomation({
        domain: "guardrail",
        action: "reset",
        providerId: "browser",
        serviceKey: "mail.example.com",
        reason: "reset without approval surface",
        cwd: "/repo",
      });

      expect(result).toMatchObject({
        success: false,
        state: "blocked",
        message: "Runtime automation mutation requires an approval surface.",
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("controls guardrails and browser sessions through typed automation operations", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-guardrail-");
    try {
      const runtimeRoot = path.join(tmpDir, "runtime");
      const browserSessionStore = new BrowserSessionStore(runtimeRoot);
      const guardrailStore = new GuardrailStore(runtimeRoot);
      await browserSessionStore.recordAuthenticated({
        sessionId: "sess-browser",
        providerId: "browser",
        serviceKey: "mail.example.com",
        workspace: "/repo",
        actorKey: "chat-1",
      });
      const service = new RuntimeControlService({ runtimeRoot, browserSessionStore, guardrailStore });
      const approvalFn = vi.fn().mockResolvedValue(true);

      const pause = await service.controlAutomation({
        domain: "guardrail",
        action: "pause",
        providerId: "browser",
        serviceKey: "mail.example.com",
        reason: "pause mail browser work",
        cwd: "/repo",
        approvalFn,
      });
      const reset = await service.controlAutomation({
        domain: "guardrail",
        action: "reset",
        providerId: "browser",
        serviceKey: "mail.example.com",
        reason: "reset mail breaker",
        cwd: "/repo",
        approvalFn,
      });
      const expire = await service.controlAutomation({
        domain: "browser_session",
        action: "expire",
        sessionId: "sess-browser",
        reason: "expire invalid session",
        cwd: "/repo",
        approvalFn,
      });

      expect(pause).toMatchObject({ success: true, state: "verified" });
      expect(reset).toMatchObject({ success: true, state: "verified" });
      expect(expire).toMatchObject({ success: true, state: "verified" });
      await expect(guardrailStore.loadBreaker("browser::mail.example.com")).resolves.toMatchObject({
        state: "closed",
        failure_count: 0,
      });
      await expect(browserSessionStore.load("sess-browser")).resolves.toMatchObject({ state: "expired" });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("routes typed pause, resume, and cancel through the selected run goal bridge", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-service-run-");
    try {
      const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
      const executor = vi.fn().mockResolvedValue({
        ok: true,
        state: "running",
        message: "typed run control sent",
      });
      const evidenceLedger = { append: vi.fn().mockResolvedValue([]) };
      const service = new RuntimeControlService({
        operationStore,
        executor,
        evidenceLedger,
        sessionRegistry: {
          snapshot: vi.fn().mockResolvedValue(snapshotWithRuns([makeRun()])),
        },
      });

      const pause = await service.pauseRun({
        runId: "run:coreloop:active",
        reason: "pause this run",
        cwd: "/repo",
        approvalFn: vi.fn().mockResolvedValue(true),
      });
      const resume = await service.resumeRun({
        runId: "run:coreloop:active",
        reason: "resume this run",
        cwd: "/repo",
        approvalFn: vi.fn().mockResolvedValue(true),
      });
      const cancel = await service.cancelRun({
        runId: "run:coreloop:active",
        reason: "cancel this run",
        cwd: "/repo",
        approvalFn: vi.fn().mockResolvedValue(true),
      });

      expect(pause).toMatchObject({ success: true, message: "typed run control sent", state: "running" });
      expect(resume).toMatchObject({ success: true, message: "typed run control sent", state: "running" });
      expect(cancel).toMatchObject({ success: true, message: "typed run control sent", state: "running" });
      expect(executor).toHaveBeenCalledTimes(3);
      expect(executor.mock.calls[0][0]).toMatchObject({
        kind: "pause_run",
        target: { run_id: "run:coreloop:active", goal_id: "goal-1" },
      });
      expect(executor.mock.calls[1][0]).toMatchObject({
        kind: "resume_run",
        target: { run_id: "run:coreloop:active", goal_id: "goal-1" },
      });
      expect(executor.mock.calls[2][0]).toMatchObject({
        kind: "cancel_run",
        target: { run_id: "run:coreloop:active", goal_id: "goal-1" },
      });
      expect(evidenceLedger.append).toHaveBeenCalled();
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("emits RuntimeEvent facts and recomputes CompanionState from the production run-control path", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-companion-boundary-");
    try {
      const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
      let nowTick = 0;
      const service = new RuntimeControlService({
        operationStore,
        executor: vi.fn().mockResolvedValue({
          ok: true,
          state: "running",
          message: "typed run control sent",
        }),
        sessionRegistry: {
          snapshot: vi.fn().mockResolvedValue(snapshotWithRuns([makeRun()])),
        },
        now: () => new Date(Date.UTC(2026, 4, 8, 0, 0, nowTick++)),
      });

      const result = await service.pauseRun({
        runId: "run:coreloop:active",
        reason: "pause this run",
        cwd: "/repo",
        approvalFn: vi.fn().mockResolvedValue(true),
      });

      expect(result).toMatchObject({ success: true, state: "running" });
      const events = await operationStore.listRuntimeEvents();
      expect(events).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event_type: "waiting",
          item_ref: expect.stringMatching(/^runtime-control:/),
          posture_before: null,
          posture_after: "waiting",
          source: "runtime-operation-store",
        }),
        expect.objectContaining({
          event_type: "working",
          item_ref: expect.stringMatching(/^runtime-control:/),
          posture_before: "waiting",
          posture_after: "working",
        }),
      ]));
      expect(events[0]?.authority_delta.changed_fields).toContain("approval_scope");

      const missingBoundary = await service.recomputeCompanionState({
        currentTime: "2026-05-08T00:01:00.000Z",
      });
      expect(missingBoundary.input.runtime_items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          item_id: expect.stringMatching(/^runtime-control:/),
          type: "run",
          posture: "working",
        }),
        expect.objectContaining({
          item_id: "background-run:run:coreloop:active",
          source: "runtime-session-registry",
        }),
      ]));
      expect(missingBoundary.input.recent_runtime_events[0]).toMatchObject({
        schema_version: "runtime-event-v1",
        event_type: "waiting",
      });
      expect(missingBoundary.snapshot.mode).toBe("needs_user");
      expect(missingBoundary.snapshot.blocked_refs).toContain("global_controls");
      expect(missingBoundary.snapshot.stale_surface_refs).toContain("active_surface_ref");

      const invalidatedSurface = await service.recomputeCompanionState({
        activeSurfaceRef: "surface:current",
        surfaceInvalidationEvents: ["surface:current"],
        globalControlStateRef: "global-control-state:1",
        globalControls: [{
          control: "inspect_companion_state",
          state: "inactive",
          source_ref: "global-control:inactive",
          updated_at: "2026-05-08T00:01:00.000Z",
          reason: "baseline clear global controls",
        }],
        currentTime: "2026-05-08T00:01:00.000Z",
      });
      expect(invalidatedSurface.snapshot.mode).toBe("holding_back");
      expect(invalidatedSurface.snapshot.invalidated_surface_refs).toContain("surface:current");
      expect(invalidatedSurface.snapshot.derivation_trace.reason).toBe("stale_or_invalid_surface_holds_runtime_state");
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("fails closed when a production run-control operation is blocked by a runtime boundary", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-companion-blocked-run-");
    try {
      const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
      const service = new RuntimeControlService({
        operationStore,
        executor: vi.fn(),
        sessionRegistry: {
          snapshot: vi.fn().mockResolvedValue(snapshotWithRuns([
            makeRun({
              id: "run:process:abc",
              kind: "process_run",
              goal_id: null,
              child_session_id: null,
              process_session_id: "proc-1",
            }),
          ])),
        },
        now: () => new Date("2026-05-08T00:00:00.000Z"),
      });

      const result = await service.pauseRun({
        runId: "run:process:abc",
        reason: "pause process",
        cwd: "/repo",
        approvalFn: vi.fn().mockResolvedValue(true),
      });
      const recomputed = await service.recomputeCompanionState({
        activeSurfaceRef: "surface:current",
        globalControlStateRef: "global-control-state:1",
        globalControls: [{
          control: "inspect_companion_state",
          state: "inactive",
          source_ref: "global-control:inactive",
          updated_at: "2026-05-08T00:00:00.000Z",
          reason: "baseline clear global controls",
        }],
        currentTime: "2026-05-08T00:00:00.000Z",
      });

      expect(result).toMatchObject({ success: false, state: "blocked" });
      expect(recomputed.input.runtime_items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          item_id: expect.stringMatching(/^runtime-control:/),
          type: "run",
          posture: "blocked_by_boundary",
        }),
      ]));
      expect(recomputed.snapshot.mode).toBe("overloaded");
      expect(recomputed.snapshot.derivation_trace.reason).toBe("runtime_boundary_blocker_fail_closed");
      expect(recomputed.snapshot.blocked_by_boundary_refs).toEqual(expect.arrayContaining([
        expect.stringMatching(/^runtime-control:/),
      ]));
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("assembles auth handoffs browser sessions guardrails and backpressure as RuntimeItems", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-safety-runtime-items-");
    try {
      const runtimeRoot = path.join(tmpDir, "runtime");
      const authHandoffStore = new RuntimeAuthHandoffStore(runtimeRoot);
      const browserSessionStore = new BrowserSessionStore(runtimeRoot);
      const guardrailStore = new GuardrailStore(runtimeRoot);
      await browserSessionStore.recordAuthenticated({
        sessionId: "sess-expired",
        providerId: "browser",
        serviceKey: "mail.example.com",
        workspace: "/repo",
        actorKey: "chat-1",
        expiresAt: "2000-01-01T00:00:00.000Z",
      });
      const handoff = await authHandoffStore.createPending({
        providerId: "browser",
        serviceKey: "mail.example.com",
        workspace: "/repo",
        actorKey: "chat-1",
        browserSessionId: "sess-expired",
        expiresAt: "2000-01-01T00:00:00.000Z",
        taskSummary: "Open mail",
      });
      await guardrailStore.saveBreaker({
        key: "browser::mail.example.com",
        provider_id: "browser",
        service_key: "mail.example.com",
        state: "open",
        failure_count: 2,
        last_failure_code: "rate_limited",
        last_failure_message: "too many requests",
        last_failure_at: "2026-05-08T00:00:00.000Z",
        opened_at: "2026-05-08T00:00:00.000Z",
        cooldown_until: "2026-05-08T00:05:00.000Z",
        updated_at: "2026-05-08T00:00:00.000Z",
      });
      await guardrailStore.saveBackpressureSnapshot({
        updated_at: "2026-05-08T00:00:00.000Z",
        active: [{
          provider_id: "browser",
          service_key: "mail.example.com",
          run_key: "run:coreloop:active",
          acquired_at: "2026-05-08T00:00:00.000Z",
        }],
        throttled: [{
          provider_id: "browser",
          service_key: "mail.example.com",
          reason: "service concurrency limit reached",
          at: "2026-05-08T00:00:10.000Z",
        }],
      });
      const service = new RuntimeControlService({
        runtimeRoot,
        authHandoffStore,
        browserSessionStore,
        guardrailStore,
      });

      const recomputed = await service.recomputeCompanionState({
        activeSurfaceRef: "surface:current",
        globalControlStateRef: "global-control-state:1",
        globalControls: [{
          control: "inspect_companion_state",
          state: "inactive",
          source_ref: "global-control:inactive",
          updated_at: "2026-05-08T00:01:00.000Z",
          reason: "baseline clear global controls",
        }],
        currentTime: "2026-05-08T00:01:00.000Z",
      });

      expect(recomputed.input.runtime_items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          item_id: `auth-handoff:${handoff.handoff_id}`,
          type: "auth_handoff",
          posture: "needs_user",
        }),
        expect.objectContaining({
          item_id: "browser-session:sess-expired",
          type: "browser_session",
          posture: "stale",
          authority: expect.objectContaining({ resumable: false }),
          staleness: expect.objectContaining({
            browser_session: expect.objectContaining({ outcome: "not_resumable" }),
          }),
        }),
        expect.objectContaining({
          item_id: "guardrail:browser::mail.example.com",
          type: "guardrail_state",
          posture: "blocked_by_boundary",
        }),
        expect.objectContaining({
          item_id: "backpressure:active:browser:mail.example.com:run:coreloop:active",
          type: "backpressure_state",
        }),
        expect.objectContaining({
          item_id: "backpressure:throttled:browser:mail.example.com:2026-05-08T00_3A00_3A10.000Z",
          posture: "blocked_by_boundary",
        }),
      ]));
      expect(recomputed.snapshot.mode).toBe("overloaded");
      expect(recomputed.snapshot.blocked_by_boundary_refs).toEqual(expect.arrayContaining([
        "guardrail:browser::mail.example.com",
        "backpressure:throttled:browser:mail.example.com:2026-05-08T00_3A00_3A10.000Z",
      ]));
      expect(recomputed.snapshot.blocked_by_boundary_refs).not.toContain(
        "backpressure:active:browser:mail.example.com:run:coreloop:active",
      );
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("does not keep CompanionState overloaded for recovered guardrails or normal backpressure leases", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-recovered-safety-items-");
    try {
      const runtimeRoot = path.join(tmpDir, "runtime");
      const guardrailStore = new GuardrailStore(runtimeRoot);
      await guardrailStore.saveBreaker({
        key: "browser::mail.example.com",
        provider_id: "browser",
        service_key: "mail.example.com",
        state: "closed",
        failure_count: 0,
        last_failure_code: null,
        last_failure_message: null,
        last_failure_at: null,
        opened_at: null,
        cooldown_until: null,
        updated_at: "2026-05-08T00:00:00.000Z",
      });
      await guardrailStore.saveBackpressureSnapshot({
        updated_at: "2026-05-08T00:00:00.000Z",
        active: [{
          provider_id: "browser",
          service_key: "mail.example.com",
          run_key: "run:coreloop:active",
          acquired_at: "2026-05-08T00:00:00.000Z",
        }],
        throttled: [],
      });
      const service = new RuntimeControlService({ runtimeRoot, guardrailStore });

      const recomputed = await service.recomputeCompanionState({
        activeSurfaceRef: "surface:current",
        globalControlStateRef: "global-control-state:1",
        globalControls: [{
          control: "inspect_companion_state",
          state: "inactive",
          source_ref: "global-control:inactive",
          updated_at: "2026-05-08T00:01:00.000Z",
          reason: "baseline clear global controls",
        }],
        currentTime: "2026-05-08T00:01:00.000Z",
      });

      expect(recomputed.input.runtime_items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          item_id: "guardrail:browser::mail.example.com",
          type: "guardrail_state",
          status: "active",
          posture: "watching",
        }),
        expect.objectContaining({
          item_id: "backpressure:active:browser:mail.example.com:run:coreloop:active",
          type: "backpressure_state",
          status: "active",
          posture: "watching",
        }),
      ]));
      expect(recomputed.snapshot.mode).toBe("watching");
      expect(recomputed.snapshot.blocked_by_boundary_refs).toEqual([]);
      expect(recomputed.snapshot.derivation_trace.reason).toBe("companion_state_reducer_skeleton_selected_mode");
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("uses the CompanionState boundary clock for auth handoff and browser-session expiry", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-boundary-clock-");
    try {
      const runtimeRoot = path.join(tmpDir, "runtime");
      const authHandoffStore = new RuntimeAuthHandoffStore(runtimeRoot);
      const browserSessionStore = new BrowserSessionStore(runtimeRoot);
      await browserSessionStore.recordAuthenticated({
        sessionId: "sess-boundary-clock",
        providerId: "browser",
        serviceKey: "mail.example.com",
        workspace: "/repo",
        actorKey: "chat-1",
        expiresAt: "2030-01-01T00:00:00.000Z",
      });
      const handoff = await authHandoffStore.createPending({
        providerId: "browser",
        serviceKey: "mail.example.com",
        workspace: "/repo",
        actorKey: "chat-1",
        browserSessionId: "sess-boundary-clock",
        expiresAt: "2030-01-01T00:00:00.000Z",
        taskSummary: "Open mail",
      });
      const service = new RuntimeControlService({
        runtimeRoot,
        authHandoffStore,
        browserSessionStore,
        now: () => new Date("2026-05-08T00:00:00.000Z"),
      });

      const beforeExpiry = await service.recomputeCompanionState({
        activeSurfaceRef: "surface:current",
        globalControlStateRef: "global-control-state:1",
        globalControls: [{
          control: "inspect_companion_state",
          state: "inactive",
          source_ref: "global-control:inactive",
          updated_at: "2026-05-08T00:00:00.000Z",
          reason: "baseline clear global controls",
        }],
        currentTime: "2029-12-31T23:59:59.000Z",
      });
      const afterExpiry = await service.recomputeCompanionState({
        activeSurfaceRef: "surface:current",
        globalControlStateRef: "global-control-state:1",
        globalControls: [{
          control: "inspect_companion_state",
          state: "inactive",
          source_ref: "global-control:inactive",
          updated_at: "2030-01-01T00:00:01.000Z",
          reason: "baseline clear global controls",
        }],
        currentTime: "2030-01-01T00:00:01.000Z",
      });

      expect(beforeExpiry.input.runtime_items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          item_id: `auth-handoff:${handoff.handoff_id}`,
          staleness: expect.objectContaining({
            auth_handoff: expect.objectContaining({ outcome: "current" }),
          }),
        }),
        expect.objectContaining({
          item_id: "browser-session:sess-boundary-clock",
          posture: "watching",
          staleness: expect.objectContaining({
            browser_session: expect.objectContaining({ outcome: "current" }),
          }),
        }),
      ]));
      expect(afterExpiry.input.runtime_items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          item_id: `auth-handoff:${handoff.handoff_id}`,
          staleness: expect.objectContaining({
            auth_handoff: expect.objectContaining({ outcome: "not_resumable" }),
          }),
        }),
        expect.objectContaining({
          item_id: "browser-session:sess-boundary-clock",
          posture: "stale",
          staleness: expect.objectContaining({
            browser_session: expect.objectContaining({ outcome: "not_resumable" }),
          }),
        }),
      ]));
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("fails closed for blocked browser sessions instead of treating them as passive watches", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-blocked-browser-session-");
    try {
      const runtimeRoot = path.join(tmpDir, "runtime");
      const browserSessionStore = new BrowserSessionStore(runtimeRoot);
      await browserSessionStore.upsert({
        session_id: "sess-blocked",
        provider_id: "browser",
        service_key: "mail.example.com",
        workspace: "/repo",
        actor_key: "chat-1",
        state: "blocked",
        created_at: "2026-05-08T00:00:00.000Z",
        updated_at: "2026-05-08T00:00:00.000Z",
        last_auth_at: null,
        expires_at: null,
        last_failure_code: "provider_blocked",
        last_failure_message: "provider is blocked",
      });
      const service = new RuntimeControlService({
        runtimeRoot,
        browserSessionStore,
      });

      const recomputed = await service.recomputeCompanionState({
        activeSurfaceRef: "surface:current",
        globalControlStateRef: "global-control-state:1",
        globalControls: [{
          control: "inspect_companion_state",
          state: "inactive",
          source_ref: "global-control:inactive",
          updated_at: "2026-05-08T00:01:00.000Z",
          reason: "baseline clear global controls",
        }],
        currentTime: "2026-05-08T00:01:00.000Z",
      });

      expect(recomputed.input.runtime_items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          item_id: "browser-session:sess-blocked",
          type: "browser_session",
          status: "blocked",
          posture: "blocked_by_boundary",
          staleness: expect.objectContaining({
            browser_session: expect.objectContaining({ outcome: "not_actionable" }),
          }),
        }),
      ]));
      expect(recomputed.snapshot.mode).toBe("overloaded");
      expect(recomputed.snapshot.blocked_by_boundary_refs).toContain("browser-session:sess-blocked");
      expect(recomputed.snapshot.derivation_trace.reason).toBe("runtime_boundary_blocker_fail_closed");
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("returns a typed blocked reason when a selected run has no supported goal bridge", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-service-run-blocked-");
    try {
      const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
      const executor = vi.fn();
      const service = new RuntimeControlService({
        operationStore,
        executor,
        sessionRegistry: {
          snapshot: vi.fn().mockResolvedValue(snapshotWithRuns([
            makeRun({ kind: "process_run", id: "run:process:abc", goal_id: null, child_session_id: null, process_session_id: "proc-1" }),
          ])),
        },
      });

      const result = await service.pauseRun({
        runId: "run:process:abc",
        reason: "pause process",
        cwd: "/repo",
        approvalFn: vi.fn().mockResolvedValue(true),
      });

      expect(result).toMatchObject({
        success: false,
        state: "blocked",
        message: expect.stringContaining("no typed goal/runtime bridge"),
      });
      expect(executor).not.toHaveBeenCalled();
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("does not recover runtime-control goal targets from display titles", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-service-title-target-");
    try {
      const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
      const executor = vi.fn();
      const service = new RuntimeControlService({
        operationStore,
        executor,
        sessionRegistry: {
          snapshot: vi.fn().mockResolvedValue(snapshotWithRuns([
            makeRun({ goal_id: null, title: "DurableLoop goal goal-from-title" }),
          ])),
        },
      });

      const result = await service.pauseRun({
        runId: "run:coreloop:active",
        reason: "pause this run",
        cwd: "/repo",
        approvalFn: vi.fn().mockResolvedValue(true),
      });

      expect(result).toMatchObject({
        success: false,
        state: "blocked",
        message: expect.stringContaining("no typed goal/runtime bridge"),
      });
      expect(executor).not.toHaveBeenCalled();
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("asks for clarification instead of guessing among multiple active or attention runs", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-service-run-ambiguous-");
    try {
      const service = new RuntimeControlService({
        operationStore: new RuntimeOperationStore(path.join(tmpDir, "runtime")),
        sessionRegistry: {
          snapshot: vi.fn().mockResolvedValue(snapshotWithRuns([
            makeRun({ id: "run:coreloop:a", goal_id: "goal-a" }),
            makeRun({ id: "run:coreloop:b", goal_id: "goal-b" }),
          ])),
        },
      });

      const result = await service.pauseRun({
        reason: "pause this run",
        cwd: "/repo",
      });

      expect(result).toMatchObject({
        success: false,
        state: "blocked",
        message: expect.stringContaining("Multiple runtime runs match this request"),
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("blocks latest run control when only another conversation has selectable runs", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-service-latest-other-conversation-");
    try {
      const executor = vi.fn();
      const service = new RuntimeControlService({
        operationStore: new RuntimeOperationStore(path.join(tmpDir, "runtime")),
        executor,
        sessionRegistry: {
          snapshot: vi.fn().mockResolvedValue(snapshotWithRuns([
            makeRun({
              id: "run:coreloop:other",
              parent_session_id: "session:conversation:other",
              goal_id: "goal-other",
            }),
          ])),
        },
      });

      const result = await service.request({
        intent: {
          kind: "pause_run",
          reason: "pause latest run",
          targetSelector: { scope: "run", reference: "latest", sourceText: "latest run" },
        },
        cwd: "/repo",
        requestedBy: { surface: "chat", conversation_id: "chat-1" },
      });

      expect(result).toMatchObject({
        success: false,
        state: "blocked",
        message: expect.stringContaining("refusing to reuse another conversation"),
      });
      expect(executor).not.toHaveBeenCalled();
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("blocks session-scoped run control when only sessionless runs are selectable", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-service-session-scope-");
    try {
      const executor = vi.fn();
      const service = new RuntimeControlService({
        operationStore: new RuntimeOperationStore(path.join(tmpDir, "runtime")),
        executor,
        sessionRegistry: {
          snapshot: vi.fn().mockResolvedValue(snapshotWithRuns([
            makeRun({
              id: "run:process:sessionless",
              kind: "process_run",
              child_session_id: null,
              goal_id: null,
            }),
          ])),
        },
      });

      const result = await service.request({
        intent: {
          kind: "pause_run",
          reason: "pause the latest session",
          targetSelector: { scope: "session", reference: "latest", sourceText: "latest session" },
        },
        cwd: "/repo",
        requestedBy: { surface: "chat", conversation_id: "chat-1" },
      });

      expect(result).toMatchObject({
        success: false,
        state: "blocked",
        message: expect.stringContaining("no session-scoped runtime runs"),
      });
      expect(executor).not.toHaveBeenCalled();
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("rejects stale terminal runs for control operations", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-service-run-stale-");
    try {
      const service = new RuntimeControlService({
        operationStore: new RuntimeOperationStore(path.join(tmpDir, "runtime")),
        sessionRegistry: {
          snapshot: vi.fn().mockResolvedValue(snapshotWithRuns([
            makeRun({ id: "run:coreloop:old", status: "succeeded", goal_id: "goal-old" }),
          ])),
        },
      });

      const result = await service.pauseRun({
        runId: "run:coreloop:old",
        reason: "pause old run",
        cwd: "/repo",
      });

      expect(result).toMatchObject({
        success: false,
        state: "blocked",
        message: expect.stringContaining("stale or terminal"),
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("records approval-gated finalize proposals without executing external actions", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-service-finalize-");
    try {
      const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
      const executor = vi.fn();
      const operatorHandoffStore = { create: vi.fn().mockResolvedValue({ handoff_id: "handoff-1" }) };
      const service = new RuntimeControlService({
        operationStore,
        executor,
        operatorHandoffStore,
        sessionRegistry: {
          snapshot: vi.fn().mockResolvedValue(snapshotWithRuns([makeRun()])),
        },
      });

      const result = await service.finalizeRun({
        runId: "run:coreloop:active",
        reason: "finalize but do not submit externally",
        externalActions: ["submit"],
        cwd: "/repo",
        approvalFn: vi.fn().mockResolvedValue(true),
      });

      expect(result).toMatchObject({
        success: true,
        state: "blocked",
        message: expect.stringContaining("No external submit/publish/secret/production/destructive action was executed"),
      });
      expect(operatorHandoffStore.create).toHaveBeenCalledWith(expect.objectContaining({
        run_id: "run:coreloop:active",
        triggers: expect.arrayContaining(["finalization", "external_action"]),
      }));
      expect(executor).not.toHaveBeenCalled();
    } finally {
      cleanupTempDir(tmpDir);
    }
  });
});
