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
          user_id: "U999",
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
