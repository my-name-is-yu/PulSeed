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
import type { RuntimeItem } from "../../types/companion-state.js";
import { EventServer } from "../../event/server.js";
import { NotificationDispatcher } from "../../notification-dispatcher.js";
import { OutboxStore } from "../../store/outbox-store.js";
import { AttentionStateStore } from "../../store/attention-state-store.js";
import {
  buildSignalContextFromAttentionInputs,
  createAttentionInput,
  createUrgeCandidate,
  mergeUrgesIntoAgenda,
  ref,
} from "../../attention/index.js";

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

function makeSession(input: Partial<RuntimeSessionRegistrySnapshot["sessions"][number]> = {}): RuntimeSessionRegistrySnapshot["sessions"][number] {
  return {
    schema_version: "runtime-session-v1",
    id: "session:conversation:old",
    kind: "conversation",
    parent_session_id: null,
    title: "Old planning session",
    workspace: "/repo",
    status: "ended",
    created_at: "2026-05-01T00:00:00.000Z",
    updated_at: "2026-05-01T00:30:00.000Z",
    last_event_at: "2026-05-01T00:30:00.000Z",
    transcript_ref: null,
    state_ref: null,
    reply_target: null,
    resumable: false,
    attachable: false,
    source_refs: [],
    ...input,
  };
}

function makeInactiveInspectControl(updatedAt: string) {
  return {
    control: "inspect_companion_state" as const,
    state: "inactive" as const,
    source_ref: "global-control:inactive",
    updated_at: updatedAt,
    reason: "baseline clear global controls",
    changed_by: null,
    affected_runtime_refs: [],
    audit_refs: [],
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

const ATTENTION_RUNTIME_CONTROL_NOW = "2026-05-08T00:00:00.000Z";

function makeRuntimeControlAttentionCycle() {
  const attentionInput = createAttentionInput({
    source_kind: "resident_curiosity",
    source_id: "resident:attention-runtime-control",
    source_epoch: "resident:epoch:1",
    high_watermark: "resident:watermark:1",
    emitted_at: ATTENTION_RUNTIME_CONTROL_NOW,
    payload_class: "resident.curiosity.runtime_control_test",
    summary: "Resident curiosity created a durable agenda item for runtime-control inspection.",
    current_goal_refs: [ref("goal", "goal:runtime-control-attention")],
  });
  const signalContext = buildSignalContextFromAttentionInputs({
    signal_context_id: "signal:runtime-control-attention",
    assembled_at: ATTENTION_RUNTIME_CONTROL_NOW,
    inputs: [attentionInput],
    current_goal_refs: [ref("goal", "goal:runtime-control-attention")],
  });
  const urge = createUrgeCandidate({
    urge_id: "urge:runtime-control-attention",
    signal_context: signalContext,
    origin: "curiosity",
    target: ref("goal", "goal:runtime-control-attention"),
    feeling: "curiosity",
    subject: "Keep a quiet resident follow-up visible only to runtime-control inspection.",
    strength: 0.8,
    confidence: 0.86,
    expected_user_benefit: "The operator can inspect or suppress the agenda without it speaking.",
    maturation_state: "mature",
  });
  const [agendaItem] = mergeUrgesIntoAgenda({
    now: ATTENTION_RUNTIME_CONTROL_NOW,
    urges: [urge],
  });
  if (!agendaItem) throw new Error("expected runtime-control attention agenda item");
  return { attentionInput, signalContext, urge, agendaItem };
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
        intent: { kind: "restart_gateway", reason: "restart the gateway" },
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
        intent: { kind: "reload_config", reason: "reload runtime configuration" },
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
        intent: { kind: "restart_daemon", reason: "restart PulSeed" },
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

  it("rejects superseded auth handoff completion before reusing the linked browser session", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-auth-superseded-");
    try {
      const runtimeRoot = path.join(tmpDir, "runtime");
      const authHandoffStore = new RuntimeAuthHandoffStore(runtimeRoot);
      const browserSessionStore = new BrowserSessionStore(runtimeRoot);
      await browserSessionStore.recordAuthRequired({
        sessionId: "sess-superseded",
        providerId: "browser",
        serviceKey: "mail.example.com",
        workspace: "/repo",
        actorKey: "chat-1",
        failureCode: "auth_required",
        failureMessage: "login required",
      });
      const first = await authHandoffStore.createPending({
        providerId: "browser",
        serviceKey: "mail.example.com",
        workspace: "/repo",
        actorKey: "chat-1",
        browserSessionId: "sess-superseded",
        resumableSessionId: "sess-superseded",
        taskSummary: "Open mail",
      });
      await authHandoffStore.createPending({
        providerId: "browser",
        serviceKey: "mail.example.com",
        workspace: "/repo",
        actorKey: "chat-1",
        browserSessionId: "sess-current",
        resumableSessionId: "sess-current",
        taskSummary: "Open mail again",
      });
      const service = new RuntimeControlService({
        runtimeRoot,
        authHandoffStore,
        browserSessionStore,
      });

      const result = await service.controlAutomation({
        domain: "auth_handoff",
        action: "complete",
        handoffId: first.handoff_id,
        reason: "complete superseded login",
        cwd: "/repo",
        approvalFn: vi.fn().mockResolvedValue(true),
      });

      expect(result).toMatchObject({ success: false, state: "blocked" });
      expect(result.message).toContain("terminal: superseded");
      await expect(authHandoffStore.load(first.handoff_id)).resolves.toMatchObject({ state: "superseded" });
      await expect(browserSessionStore.load("sess-superseded")).resolves.toMatchObject({ state: "auth_required" });
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
        runtimeRoot: path.join(tmpDir, "runtime"),
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

  it("emits RuntimeEvent facts without treating event creation as user notification dispatch", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-companion-boundary-");
    try {
      const runtimeRoot = path.join(tmpDir, "runtime");
      const externalEventsDir = path.join(tmpDir, "events");
      const operationStore = new RuntimeOperationStore(runtimeRoot);
      const outboxStore = new OutboxStore(runtimeRoot);
      const eventServer = new EventServer({ writeEvent: vi.fn().mockResolvedValue(undefined) } as never, {
        eventsDir: externalEventsDir,
        runtimeRoot,
        outboxStore,
      });
      const notificationDispatcher = new NotificationDispatcher({ channels: [] });
      notificationDispatcher.setRealtimeSink((report) => eventServer.broadcast("notification_report", report));
      let nowTick = 0;
      const service = new RuntimeControlService({
        runtimeRoot: path.join(tmpDir, "runtime"),
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
      expect(await outboxStore.list()).toEqual([]);

      await notificationDispatcher.dispatch({
        id: "report-runtime-control-boundary",
        report_type: "execution_summary",
        goal_id: "goal-1",
        title: "Runtime control boundary check",
        content: "A real notification dispatch should appear in the EventServer outbox.",
        verbosity: "minimal",
        generated_at: "2026-05-08T00:00:00.000Z",
        delivered_at: null,
        read: false,
      });
      expect(await outboxStore.list()).toEqual([
        expect.objectContaining({
          event_type: "notification_report",
          payload: expect.objectContaining({
            id: "report-runtime-control-boundary",
            report_type: "execution_summary",
          }),
        }),
      ]);

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
        globalControls: [makeInactiveInspectControl("2026-05-08T00:01:00.000Z")],
        currentTime: "2026-05-08T00:01:00.000Z",
      });
      expect(invalidatedSurface.snapshot.mode).toBe("holding_back");
      expect(invalidatedSurface.snapshot.invalidated_surface_refs).toContain("surface:current");
      expect(invalidatedSurface.snapshot.derivation_trace.reason).toBe("stale_or_invalid_surface_holds_runtime_state");
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("persists companion-wide controls as shared global state with affected runtime refs", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-companion-global-");
    try {
      const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
      const service = new RuntimeControlService({
        runtimeRoot: path.join(tmpDir, "runtime"),
        operationStore,
        sessionRegistry: {
          snapshot: vi.fn().mockResolvedValue(snapshotWithRuns([makeRun()])),
        },
        now: () => new Date("2026-05-08T00:00:00.000Z"),
      });

      const suspended = await service.setCompanionControl({
        control: "suspend_companion",
        reason: "user requested companion suspend",
        cwd: "/repo",
        requestedBy: { surface: "chat", user_id: "operator-1" },
      });
      const recomputed = await service.recomputeCompanionState({
        activeSurfaceRef: "surface:current",
        currentTime: "2026-05-08T00:01:00.000Z",
      });
      const projectedRun = recomputed.input.runtime_items.find((item) => item.item_id === "background-run:run:coreloop:active");

      expect(suspended).toMatchObject({ success: true, state: "verified" });
      expect(recomputed.input.global_control_state_ref).toMatch(/^global-control-state:/);
      expect(recomputed.input.global_controls).toContainEqual(expect.objectContaining({
        control: "suspend_companion",
        state: "active",
        changed_by: expect.objectContaining({ surface: "chat", user_id: "operator-1" }),
        affected_runtime_refs: expect.arrayContaining(["background-run:run:coreloop:active"]),
        audit_refs: expect.arrayContaining([expect.stringMatching(/^runtime-control-operation:/)]),
      }));
      expect(projectedRun).toMatchObject({
        companion_control_state: expect.objectContaining({
          held_by_controls: expect.arrayContaining(["suspend_companion"]),
          rejected_by_controls: expect.arrayContaining(["suspend_companion"]),
        }),
        control_policy: expect.objectContaining({
          forbidden_controls: expect.arrayContaining(["resume_item"]),
        }),
      });
      expect(recomputed.snapshot.mode).toBe("suspended");
      expect(recomputed.snapshot.active_refs).toEqual([]);
      expect(recomputed.snapshot.held_runtime_refs).toContain("background-run:run:coreloop:active");
      expect(recomputed.input.global_controls[0]?.affected_runtime_refs).not.toEqual(expect.arrayContaining([
        expect.stringMatching(/^runtime-control:/),
      ]));
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("inspects durable attention agenda through the runtime-control boundary", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-attention-inspect-");
    try {
      const runtimeRoot = path.join(tmpDir, "runtime");
      const operationStore = new RuntimeOperationStore(runtimeRoot);
      const attentionStore = new AttentionStateStore(runtimeRoot);
      const cycle = makeRuntimeControlAttentionCycle();
      await attentionStore.saveCycle({
        attentionInputs: [cycle.attentionInput],
        signalContext: cycle.signalContext,
        urgeCandidates: [cycle.urge],
        agendaItems: [cycle.agendaItem],
        recordedAt: ATTENTION_RUNTIME_CONTROL_NOW,
      });
      const service = new RuntimeControlService({
        runtimeRoot,
        operationStore,
        attentionStore,
        now: () => new Date(ATTENTION_RUNTIME_CONTROL_NOW),
      });

      const inspected = await service.inspectCompanionState({
        reason: "inspect durable attention agenda",
        cwd: "/repo",
        requestedBy: { surface: "chat", user_id: "operator-1" },
      });
      const attentionItem = inspected.companionStateInspection?.runtime_items.find((item) =>
        item.ref === cycle.agendaItem.agenda_item_id
      );

      expect(inspected).toMatchObject({ success: true, state: "verified" });
      expect(inspected.message).toContain("hidden_items=");
      expect(attentionItem).toMatchObject({
        type: "agent_agenda_item",
        status: "mature",
        posture: "proposed",
        visibility_display: "hidden",
        authority_scope: "inspect_only",
        authority: expect.objectContaining({
          actionable: false,
          speakable: false,
          can_create_urge: false,
          can_update_surface: false,
          can_write_memory: false,
          can_delegate_work: false,
          requires_confirmation: true,
        }),
        allowed_controls: ["inspect_item"],
        repair_options: [],
      });
      const [runtimeProjection] = await attentionStore.listRuntimeItems(ATTENTION_RUNTIME_CONTROL_NOW);
      expect(runtimeProjection?.control_policy.allowed_controls.some((control) =>
        runtimeProjection.control_policy.forbidden_controls.includes(control)
      )).toBe(false);
      expect(runtimeProjection?.control_policy.repair_options.some((control) =>
        runtimeProjection.control_policy.forbidden_controls.includes(control)
      )).toBe(false);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("suppresses durable resident agenda without flushing it after companion resume", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-attention-suppress-");
    try {
      const runtimeRoot = path.join(tmpDir, "runtime");
      const operationStore = new RuntimeOperationStore(runtimeRoot);
      const attentionStore = new AttentionStateStore(runtimeRoot);
      const cycle = makeRuntimeControlAttentionCycle();
      await attentionStore.saveCycle({
        attentionInputs: [cycle.attentionInput],
        signalContext: cycle.signalContext,
        urgeCandidates: [cycle.urge],
        agendaItems: [cycle.agendaItem],
        recordedAt: ATTENTION_RUNTIME_CONTROL_NOW,
      });
      let tick = 0;
      const service = new RuntimeControlService({
        runtimeRoot,
        operationStore,
        attentionStore,
        now: () => new Date(Date.UTC(2026, 4, 8, 0, 0, tick++)),
      });

      const suppressed = await service.setCompanionControl({
        control: "suppress_nonessential_agenda",
        reason: "operator wants quiet resident agenda",
        cwd: "/repo",
        requestedBy: { surface: "chat", user_id: "operator-1" },
      });
      await service.setCompanionControl({
        control: "resume_companion",
        reason: "resume should not flush held agenda",
        cwd: "/repo",
        requestedBy: { surface: "chat", user_id: "operator-1" },
      });
      const recomputed = await service.recomputeCompanionState({
        activeSurfaceRef: "surface:current",
        currentTime: "2026-05-08T00:05:00.000Z",
      });
      const durableAgenda = await attentionStore.listAgendaItems({ includeSuppressed: true });
      const runtimeItem = recomputed.input.runtime_items.find((item) => item.item_id === cycle.agendaItem.agenda_item_id);

      expect(suppressed).toMatchObject({
        success: true,
        state: "verified",
        message: expect.stringContaining("Durable attention agenda suppressed 1 item(s); held items will not flush automatically."),
      });
      expect(durableAgenda).toHaveLength(1);
      expect(durableAgenda[0]).toMatchObject({
        current_posture: "suppressed",
        control_state: "suppressed",
        maturation: expect.objectContaining({ state: "suppressed" }),
        revisit_condition: expect.objectContaining({ kind: "manual_review" }),
      });
      await expect(attentionStore.listAgendaItems()).resolves.toEqual([]);
      expect(runtimeItem).toMatchObject({
        type: "agent_agenda_item",
        status: "blocked",
        posture: "suppressed",
        authority: expect.objectContaining({
          actionable: false,
          speakable: false,
        }),
      });
      expect(recomputed.input.global_controls).toContainEqual(expect.objectContaining({
        control: "suppress_nonessential_agenda",
        state: "active",
        affected_runtime_refs: [cycle.agendaItem.agenda_item_id],
      }));
      expect(recomputed.input.global_controls).toContainEqual(expect.objectContaining({
        control: "resume_companion",
        state: "inactive",
      }));
      expect(recomputed.snapshot.active_refs).not.toContain(cycle.agendaItem.agenda_item_id);
      expect(recomputed.snapshot.held_runtime_refs).toContain(cycle.agendaItem.agenda_item_id);

      const reopenedAttentionStore = new AttentionStateStore(runtimeRoot);
      const afterRestartService = new RuntimeControlService({
        runtimeRoot,
        operationStore,
        attentionStore: reopenedAttentionStore,
        now: () => new Date("2026-05-08T00:06:00.000Z"),
      });
      const afterRestart = await afterRestartService.recomputeCompanionState({
        activeSurfaceRef: "surface:current",
        currentTime: "2026-05-08T00:06:00.000Z",
        globalControls: [],
      });
      expect(afterRestart.snapshot.active_refs).not.toContain(cycle.agendaItem.agenda_item_id);
      expect(afterRestart.snapshot.held_runtime_refs).toContain(cycle.agendaItem.agenda_item_id);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("sends typed pause requests for active quiet runs when stopping all quiet work", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-companion-stop-quiet-");
    try {
      const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
      const executor = vi.fn().mockResolvedValue({
        ok: true,
        state: "running",
        message: "safe pause sent through daemon",
      });
      const approvalFn = vi.fn().mockResolvedValue(true);
      const service = new RuntimeControlService({
        runtimeRoot: path.join(tmpDir, "runtime"),
        operationStore,
        executor,
        sessionRegistry: {
          snapshot: vi.fn().mockResolvedValue(snapshotWithRuns([makeRun()])),
        },
        now: () => new Date("2026-05-08T00:00:00.000Z"),
      });

      const stopped = await service.setCompanionControl({
        control: "stop_all_quiet_work",
        reason: "stop quiet work now",
        cwd: "/repo",
        requestedBy: { surface: "chat", user_id: "operator-1" },
        approvalFn,
      });
      const pauseOperation = executor.mock.calls[0]?.[0];
      const recomputed = await service.recomputeCompanionState({
        activeSurfaceRef: "surface:current",
        currentTime: "2026-05-08T00:01:00.000Z",
      });
      const stopControl = recomputed.input.global_controls.find((entry) => entry.control === "stop_all_quiet_work");
      const pauseItem = recomputed.input.runtime_items.find((item) => item.item_id === `runtime-control:${pauseOperation.operation_id}`);

      expect(stopped).toMatchObject({
        success: true,
        state: "verified",
        message: expect.stringContaining("Typed pause request sent for 1 active quiet run(s)."),
      });
      expect(approvalFn).toHaveBeenCalledWith(expect.stringContaining("Runtime control pause_run for run:coreloop:active"));
      expect(executor).toHaveBeenCalledTimes(1);
      expect(pauseOperation).toMatchObject({
        kind: "pause_run",
        target: {
          run_id: "run:coreloop:active",
          session_id: "session:coreloop:worker-1",
          goal_id: "goal-1",
        },
        reason: expect.stringContaining("Parent stop_all_quiet_work"),
      });
      expect(stopControl).toMatchObject({
        state: "active",
        affected_runtime_refs: ["background-run:run:coreloop:active"],
      });
      expect(stopControl?.affected_runtime_refs).not.toEqual(expect.arrayContaining([
        expect.stringMatching(/^runtime-control:/),
      ]));
      expect(pauseItem?.companion_control_state.held_by_controls).not.toContain("stop_all_quiet_work");
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("records typed non-execution state when quiet work cannot be interrupted", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-companion-stop-quiet-blocked-");
    try {
      const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
      const approvalFn = vi.fn().mockResolvedValue(true);
      const service = new RuntimeControlService({
        runtimeRoot: path.join(tmpDir, "runtime"),
        operationStore,
        sessionRegistry: {
          snapshot: vi.fn().mockResolvedValue(snapshotWithRuns([makeRun()])),
        },
        now: () => new Date("2026-05-08T00:00:00.000Z"),
      });

      const stopped = await service.setCompanionControl({
        control: "stop_all_quiet_work",
        reason: "stop quiet work without executor",
        cwd: "/repo",
        approvalFn,
      });
      const completed = await operationStore.listCompleted();
      const blockedPause = completed.find((operation) => operation.kind === "pause_run");

      expect(stopped).toMatchObject({
        success: false,
        state: "verified",
        message: expect.stringContaining("typed non-execution state"),
      });
      expect(blockedPause).toMatchObject({
        kind: "pause_run",
        state: "blocked",
        target: {
          run_id: "run:coreloop:active",
          goal_id: "goal-1",
        },
        result: {
          ok: false,
          message: expect.stringContaining("no runtime control executor is configured"),
        },
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("persists structured companion-state inspection for hidden non-execution runtime facts", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-companion-inspect-non-execution-");
    try {
      const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
      const service = new RuntimeControlService({
        runtimeRoot: path.join(tmpDir, "runtime"),
        operationStore,
        sessionRegistry: {
          snapshot: vi.fn().mockResolvedValue(snapshotWithRuns([makeRun()])),
        },
        now: () => new Date("2026-05-08T00:00:00.000Z"),
      });

      await service.setCompanionControl({
        control: "stop_all_quiet_work",
        reason: "stop quiet work without executor",
        cwd: "/repo",
        approvalFn: vi.fn().mockResolvedValue(true),
      });

      const inspected = await service.inspectCompanionState({
        reason: "inspect internal state",
        cwd: "/repo",
      });
      const inspection = inspected.companionStateInspection;
      const blockedPauseItem = inspection?.runtime_items.find((item) => (
        item.ref.startsWith("runtime-control:")
        && item.status === "blocked"
      ));

      expect(inspected).toMatchObject({
        success: true,
        state: "verified",
      });
      expect(inspected.message).toContain("hidden_items=");
      expect(inspected.message).toContain("non_executable_items=");
      expect(inspection).toMatchObject({
        inspected_at: "2026-05-08T00:00:00.000Z",
        hidden_refs: expect.arrayContaining([expect.stringMatching(/^runtime-control:/)]),
        non_executable_refs: expect.arrayContaining([expect.stringMatching(/^runtime-control:/)]),
      });
      expect(blockedPauseItem).toMatchObject({
        type: "run",
        posture: "blocked_by_boundary",
        visibility_display: "hidden",
        authority_scope: "inspect_only",
        authority: {
          actionable: false,
          resumable: false,
          requires_confirmation: true,
        },
        staleness_outcomes: expect.objectContaining({
          project: "not_actionable",
          session: "needs_review",
        }),
        allowed_controls: expect.arrayContaining(["inspect_item", "require_confirmation"]),
        repair_options: expect.arrayContaining(["reground_item", "require_confirmation"]),
      });
      expect(JSON.stringify(inspection)).not.toContain("no runtime control executor is configured");

      const completed = await operationStore.listCompleted();
      const inspectOperation = completed.find((operation) => operation.kind === "inspect_companion_state");
      expect(inspectOperation?.result?.companion_state_inspection).toEqual(inspection);
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("does not expose hidden runtime facts without authority to inspect", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-companion-inspect-authority-");
    try {
      const hiddenNoAuthorityItem: RuntimeItem = {
        schema_version: "runtime-item-v1",
        item_id: "runtime:no-inspect-authority",
        type: "guardrail_state",
        status: "blocked",
        posture: "blocked_by_boundary",
        source: "test-runtime-item",
        created_at: "2026-05-08T00:00:00.000Z",
        updated_at: "2026-05-08T00:00:00.000Z",
        related_goal_refs: [],
        related_task_refs: [],
        related_session_refs: [],
        related_memory_refs: [],
        related_surface_refs: [],
        related_agenda_refs: [],
        companion_state_refs: [],
        companion_control_state: {
          active_controls: [],
          global_control_refs: [],
          held_by_controls: [],
          rejected_by_controls: [],
          reason: "test item is not inspectable by authority",
        },
        authority: {
          inspectable: false,
          resumable: false,
          actionable: false,
          speakable: false,
          can_create_urge: false,
          can_update_surface: false,
          can_write_memory: false,
          can_delegate_work: false,
          requires_confirmation: true,
          approval_scope: "none",
          authority_reason: "inspection authority denied",
        },
        staleness: {
          temporal: { outcome: "current", reason: "test" },
          world: { outcome: "current", reason: "test" },
          project: { outcome: "not_actionable", reason: "test" },
          permission: { outcome: "current", reason: "test" },
          relationship: { outcome: "current", reason: "test" },
          surface: { outcome: "current", reason: "test" },
          goal: { outcome: "current", reason: "test" },
          assumption: { outcome: "current", reason: "test" },
          session: { outcome: "current", reason: "test" },
          browser_session: { outcome: "current", reason: "test" },
          auth_handoff: { outcome: "current", reason: "test" },
        },
        visibility_policy: {
          display: "hidden",
          inspectable: true,
          auditable: true,
          policy_ref: null,
          reason: "visibility alone is not inspection authority",
        },
        visibility_policy_ref: null,
        control_policy: {
          allowed_controls: [],
          forbidden_controls: ["inspect_item"],
          required_confirmation: [],
          repair_options: [],
          reason: "authority denied inspection",
        },
        audit_trace_refs: ["audit:no-inspect-authority"],
      };
      class OperationStoreWithExtraItem extends RuntimeOperationStore {
        override async listRuntimeItems(): Promise<RuntimeItem[]> {
          return [...await super.listRuntimeItems(), hiddenNoAuthorityItem];
        }
      }
      const operationStore = new OperationStoreWithExtraItem(path.join(tmpDir, "runtime"));
      const service = new RuntimeControlService({
        runtimeRoot: path.join(tmpDir, "runtime"),
        operationStore,
        now: () => new Date("2026-05-08T00:00:00.000Z"),
      });

      const inspected = await service.inspectCompanionState({
        reason: "inspect internal state",
        cwd: "/repo",
      });

      expect(inspected).toMatchObject({ success: true, state: "verified" });
      expect(JSON.stringify(inspected.companionStateInspection)).not.toContain("runtime:no-inspect-authority");
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("does not execute quiet-work pause children when approval is denied", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-companion-stop-quiet-denied-");
    try {
      const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
      const executor = vi.fn();
      const approvalFn = vi.fn().mockResolvedValue(false);
      const service = new RuntimeControlService({
        runtimeRoot: path.join(tmpDir, "runtime"),
        operationStore,
        executor,
        sessionRegistry: {
          snapshot: vi.fn().mockResolvedValue(snapshotWithRuns([makeRun()])),
        },
        now: () => new Date("2026-05-08T00:00:00.000Z"),
      });

      const stopped = await service.setCompanionControl({
        control: "stop_all_quiet_work",
        reason: "stop quiet work denied",
        cwd: "/repo",
        approvalFn,
      });
      const completed = await operationStore.listCompleted();
      const cancelledPause = completed.find((operation) => operation.kind === "pause_run");

      expect(stopped).toMatchObject({
        success: false,
        state: "verified",
        message: expect.stringContaining("typed non-execution state"),
      });
      expect(approvalFn).toHaveBeenCalledWith(expect.stringContaining("Runtime control pause_run for run:coreloop:active"));
      expect(executor).not.toHaveBeenCalled();
      expect(cancelledPause).toMatchObject({
        kind: "pause_run",
        state: "cancelled",
        target: {
          run_id: "run:coreloop:active",
          goal_id: "goal-1",
        },
        result: {
          ok: false,
          message: "Runtime control operation was not approved.",
        },
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("lifts companion controls without flushing held runtime items", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-companion-lift-");
    try {
      const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
      let nowTick = 0;
      const service = new RuntimeControlService({
        runtimeRoot: path.join(tmpDir, "runtime"),
        operationStore,
        sessionRegistry: {
          snapshot: vi.fn().mockResolvedValue(snapshotWithRuns([makeRun()])),
        },
        now: () => new Date(Date.UTC(2026, 4, 8, 0, 0, nowTick++)),
      });

      await service.setCompanionControl({
        control: "suspend_companion",
        reason: "suspend companion",
        cwd: "/repo",
      });
      await service.setCompanionControl({
        control: "resume_companion",
        reason: "lift companion suspend",
        cwd: "/repo",
      });
      const recomputed = await service.recomputeCompanionState({
        activeSurfaceRef: "surface:current",
        currentTime: "2026-05-08T00:01:00.000Z",
      });
      const projectedRun = recomputed.input.runtime_items.find((item) => item.item_id === "background-run:run:coreloop:active");

      expect(recomputed.input.global_controls).toContainEqual(expect.objectContaining({
        control: "suspend_companion",
        state: "inactive",
        affected_runtime_refs: expect.arrayContaining(["background-run:run:coreloop:active"]),
      }));
      expect(recomputed.input.global_controls).toContainEqual(expect.objectContaining({
        control: "resume_companion",
        state: "inactive",
      }));
      expect(recomputed.snapshot.control_overlays).not.toContain("suspend_companion");
      expect(recomputed.snapshot.active_refs).not.toContain("background-run:run:coreloop:active");
      expect(recomputed.snapshot.held_runtime_refs).toContain("background-run:run:coreloop:active");
      expect(projectedRun?.companion_control_state.held_by_controls).toContain("suspend_companion");
      expect(projectedRun?.control_policy.forbidden_controls).toContain("resume_item");
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("fails closed when a production run-control operation is blocked by a runtime boundary", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-companion-blocked-run-");
    try {
      const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
      const service = new RuntimeControlService({
        runtimeRoot: path.join(tmpDir, "runtime"),
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
        globalControls: [makeInactiveInspectControl("2026-05-08T00:00:00.000Z")],
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
        globalControls: [makeInactiveInspectControl("2026-05-08T00:01:00.000Z")],
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
        globalControls: [makeInactiveInspectControl("2026-05-08T00:01:00.000Z")],
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
        globalControls: [makeInactiveInspectControl("2026-05-08T00:00:00.000Z")],
        currentTime: "2029-12-31T23:59:59.000Z",
      });
      const afterExpiry = await service.recomputeCompanionState({
        activeSurfaceRef: "surface:current",
        globalControlStateRef: "global-control-state:1",
        globalControls: [makeInactiveInspectControl("2030-01-01T00:00:01.000Z")],
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
        globalControls: [makeInactiveInspectControl("2026-05-08T00:01:00.000Z")],
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
        runtimeRoot: path.join(tmpDir, "runtime"),
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
        runtimeRoot: path.join(tmpDir, "runtime"),
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
        runtimeRoot: path.join(tmpDir, "runtime"),
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
        runtimeRoot: path.join(tmpDir, "runtime"),
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
        runtimeRoot: path.join(tmpDir, "runtime"),
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
        runtimeRoot: path.join(tmpDir, "runtime"),
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

  it("blocks resume_run through CompanionState control policy while suspended", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-service-resume-suspended-");
    try {
      const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
      const executor = vi.fn();
      const service = new RuntimeControlService({
        runtimeRoot: path.join(tmpDir, "runtime"),
        operationStore,
        executor,
        sessionRegistry: {
          snapshot: vi.fn().mockResolvedValue(snapshotWithRuns([makeRun()])),
        },
        now: () => new Date("2026-05-08T00:00:00.000Z"),
      });
      await service.setCompanionControl({
        control: "suspend_companion",
        reason: "suspend companion",
        cwd: "/repo",
      });

      const result = await service.resumeRun({
        runId: "run:coreloop:active",
        reason: "resume while suspended",
        cwd: "/repo",
        approvalFn: vi.fn().mockResolvedValue(true),
      });

      expect(result).toMatchObject({
        success: false,
        state: "blocked",
        resumeOutcome: "resume_rejected_safety",
        message: expect.stringContaining("companion suspend state"),
      });
      expect(executor).not.toHaveBeenCalled();
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("blocks resume_run after resume_companion until the held run is re-admitted", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-service-resume-after-lift-");
    try {
      const operationStore = new RuntimeOperationStore(path.join(tmpDir, "runtime"));
      const executor = vi.fn();
      let nowTick = 0;
      const service = new RuntimeControlService({
        runtimeRoot: path.join(tmpDir, "runtime"),
        operationStore,
        executor,
        sessionRegistry: {
          snapshot: vi.fn().mockResolvedValue(snapshotWithRuns([makeRun()])),
        },
        now: () => new Date(Date.UTC(2026, 4, 8, 0, 0, nowTick++)),
      });
      await service.setCompanionControl({
        control: "suspend_companion",
        reason: "suspend companion",
        cwd: "/repo",
      });
      await service.setCompanionControl({
        control: "resume_companion",
        reason: "resume companion without flushing work",
        cwd: "/repo",
      });

      const result = await service.resumeRun({
        runId: "run:coreloop:active",
        reason: "resume held run",
        cwd: "/repo",
        approvalFn: vi.fn().mockResolvedValue(true),
      });

      expect(result).toMatchObject({
        success: false,
        state: "blocked",
        resumeOutcome: "resume_rejected_safety",
        message: expect.stringContaining("companion suspend state"),
      });
      expect(executor).not.toHaveBeenCalled();
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("requires re-grounding before resuming remembered attention runs", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-service-resume-reground-");
    try {
      const executor = vi.fn();
      const service = new RuntimeControlService({
        runtimeRoot: path.join(tmpDir, "runtime"),
        operationStore: new RuntimeOperationStore(path.join(tmpDir, "runtime")),
        executor,
        sessionRegistry: {
          snapshot: vi.fn().mockResolvedValue(snapshotWithRuns([
            makeRun({ id: "run:coreloop:failed", status: "failed", goal_id: "goal-failed" }),
          ])),
        },
      });

      const result = await service.resumeRun({
        runId: "run:coreloop:failed",
        reason: "resume failed run",
        cwd: "/repo",
        approvalFn: vi.fn().mockResolvedValue(true),
      });

      expect(result).toMatchObject({
        success: false,
        state: "blocked",
        resumeOutcome: "resume_requires_regrounding",
        message: expect.stringContaining("requires explicit re-grounding"),
      });
      expect(executor).not.toHaveBeenCalled();
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("separates session inspection and summary from resume authority", async () => {
    const tmpDir = makeTempDir("pulseed-runtime-control-service-session-inspect-");
    try {
      const snapshot: RuntimeSessionRegistrySnapshot = {
        schema_version: "runtime-session-registry-v1",
        generated_at: "2026-05-08T00:00:00.000Z",
        sessions: [makeSession()],
        background_runs: [],
        warnings: [],
      };
      const service = new RuntimeControlService({
        runtimeRoot: path.join(tmpDir, "runtime"),
        operationStore: new RuntimeOperationStore(path.join(tmpDir, "runtime")),
        sessionRegistry: { snapshot: vi.fn().mockResolvedValue(snapshot) },
      });

      const inspected = await service.inspectSession({
        sessionId: "session:conversation:old",
        reason: "inspect old session",
        cwd: "/repo",
      });
      const summarized = await service.summarizeSessionWithoutResuming({
        sessionId: "session:conversation:old",
        reason: "summarize old session",
        cwd: "/repo",
      });
      const missing = await service.inspectSession({
        sessionId: "session:conversation:missing",
        reason: "inspect missing session",
        cwd: "/repo",
      });

      expect(inspected).toMatchObject({
        success: true,
        state: "verified",
        resumeOutcome: "inspect_only",
        message: expect.stringContaining("Inspectable: true"),
      });
      expect(summarized).toMatchObject({
        success: true,
        state: "verified",
        resumeOutcome: "summary_only",
        message: expect.stringContaining("No action, speech, memory write, Surface refresh, or side-effect authority was granted."),
      });
      expect(missing).toMatchObject({
        success: false,
        state: "blocked",
        resumeOutcome: "resume_rejected_stale",
        message: expect.stringContaining("refusing to fall back to latest session"),
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
        runtimeRoot: path.join(tmpDir, "runtime"),
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
