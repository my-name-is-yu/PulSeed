import { describe, expect, it } from "vitest";
import {
  assembleCompanionDecisionFrame,
} from "../index.js";

const NOW = "2026-05-13T00:00:00.000Z";

describe("companion cognition assembly", () => {
  it("assembles a neutral chat frame with typed rejected stale target refs", () => {
    const frame = assembleCompanionDecisionFrame({
      frameId: "frame:chat",
      assembledAt: NOW,
      source: {
        kind: "chat_turn",
        source_ref: "chat:ingress:1",
        received_at: NOW,
        surface_ref: "surface:telegram:chat-1",
        session_ref: "identity:user-1",
        channel: "plugin_gateway",
      },
      trigger: {
        kind: "chat_message",
        ref: "message:current",
        role: "trigger",
        freshness: "current",
      },
      inputRefs: [
        {
          kind: "session",
          ref: "identity:user-1",
          role: "context",
          freshness: "current",
        },
        {
          kind: "run",
          ref: "run:previous",
          role: "target",
          freshness: "rejected_stale",
          reason: "Caller-supplied run target differs from current ingress.",
        },
      ],
      policyRefs: [{
        kind: "runtime_control",
        ref: "runtime-control:interactive:allowed",
        result: "interactive",
      }],
      activeTargetRef: {
        kind: "session",
        id: "identity:user-1",
      },
      activeSurfaceRef: "surface:telegram:chat-1",
      companionStateRef: "companion-runtime-contract:identity:user-1",
    });

    expect(frame.source.kind).toBe("chat_turn");
    expect(frame.input_refs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "run", ref: "run:previous", freshness: "rejected_stale" }),
    ]));
    expect(frame.active_target_ref).toMatchObject({ kind: "session", id: "identity:user-1" });
  });

  it("assembles a task frame from typed grounding and policy refs", () => {
    const frame = assembleCompanionDecisionFrame({
      frameId: "frame:task",
      assembledAt: NOW,
      source: {
        kind: "task_execution",
        source_ref: "task:task-1",
        received_at: NOW,
        caller_path: "task_agent_loop",
        goal_ref: "goal-1",
        task_ref: "task-1",
      },
      trigger: {
        kind: "task",
        ref: "task-1",
        role: "trigger",
        freshness: "current",
      },
      inputRefs: [
        {
          kind: "grounding_bundle",
          ref: "grounding:bundle:agent_loop/task_execution:goal-1:task-1",
          role: "context",
          freshness: "current",
        },
        {
          kind: "grounding_section",
          ref: "grounding:section:agent_loop/task_execution:repo_instructions",
          role: "context",
          freshness: "current",
        },
      ],
      evidenceRefs: [{
        evidence_ref: "grounding:source:/repo/AGENTS.md",
        source: "grounding",
        visibility: "audit_only",
        summary: "Repo instructions",
      }],
      policyRefs: [
        {
          kind: "approval_gate",
          ref: "task-approval:task-1",
          result: "not_required",
        },
        {
          kind: "safety_boundary",
          ref: "task-reversibility:task-1",
          result: "reversible",
        },
      ],
      activeTargetRef: {
        kind: "task",
        id: "task-1",
      },
      groundingBundleRef: "grounding:bundle:agent_loop/task_execution:goal-1:task-1",
    });

    expect(frame.source.caller_path).toBe("task_agent_loop");
    expect(frame.input_refs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "grounding_bundle" }),
      expect.objectContaining({ kind: "grounding_section" }),
    ]));
    expect(frame.evidence_refs).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "grounding" }),
    ]));
    expect(frame.policy_refs).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "approval_gate" }),
      expect.objectContaining({ kind: "safety_boundary" }),
    ]));
  });
});
