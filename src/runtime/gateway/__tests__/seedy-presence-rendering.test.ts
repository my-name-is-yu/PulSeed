import { afterEach, describe, expect, it, vi } from "vitest";

import { createSeedyTurnPresence, createUserVisibleSeedyTurnPresence } from "../../../interface/chat/seedy-turn-presence.js";
import {
  renderSeedyPresenceFallbackAck,
  renderSeedyPresenceStatusText,
} from "../seedy-presence-rendering.js";

describe("seedy presence rendering", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders compact status without leaking runtime internals from presence metadata", () => {
    const presence = createSeedyTurnPresence({
      turn_id: "turn-raw-metadata",
      phase: "acting",
      audience: "user",
      importance: "status",
      subject: "Calling model openai/gpt-5.5 with tool catalog",
      reason: "Raw command output, trace id trace-123, and compaction details are available.",
      last_activity_label: "model_request: openai/gpt-5.5",
      diagnostic_ref: "trace:trace-123",
      started_at: "2026-05-10T00:00:00.000Z",
      updated_at: "2026-05-10T00:00:00.000Z",
    });

    const status = renderSeedyPresenceStatusText(presence);

    expect(status).toBe("I'm working on it.");
    expect(status).not.toMatch(/openai|gpt|model|tool catalog|command output|trace|compaction/i);
  });

  it("uses renderer-owned fallback acknowledgement text instead of raw presence fields", () => {
    const presence = createSeedyTurnPresence({
      turn_id: "turn-fallback",
      phase: "thinking",
      audience: "user",
      importance: "ephemeral",
      subject: "Provider request queued for model_request",
      reason: "Trace buffer contains raw tool output.",
      diagnostic_ref: "trace:model-request",
      started_at: "2026-05-10T00:00:00.000Z",
      updated_at: "2026-05-10T00:00:00.000Z",
    });

    const fallback = renderSeedyPresenceFallbackAck(presence);

    expect(fallback).toBe("I'm checking this.");
    expect(fallback).not.toMatch(/provider|model_request|trace|tool output/i);
  });

  it("suppresses diagnostic and internal presence on default gateway surfaces", () => {
    const now = "2026-05-10T00:00:00.000Z";
    const diagnostic = createSeedyTurnPresence({
      turn_id: "turn-diagnostic",
      phase: "waiting",
      audience: "diagnostic",
      importance: "status",
      subject: "Provider trace is still pending",
      started_at: now,
      updated_at: now,
    });
    const internal = createSeedyTurnPresence({
      turn_id: "turn-internal",
      phase: "acting",
      audience: "internal",
      importance: "status",
      subject: "Internal runtime planning state",
      started_at: now,
      updated_at: now,
    });

    expect(renderSeedyPresenceStatusText(diagnostic)).toBeNull();
    expect(renderSeedyPresenceFallbackAck(diagnostic)).toBeNull();
    expect(renderSeedyPresenceStatusText(internal)).toBeNull();
    expect(renderSeedyPresenceFallbackAck(internal)).toBeNull();
  });

  it("renders action-required waiting as a user input request", () => {
    const presence = createUserVisibleSeedyTurnPresence({
      turn_id: "turn-approval",
      phase: "waiting",
      importance: "action_required",
      expected_next: "approval",
    });

    expect(renderSeedyPresenceStatusText(presence)).toBe("I need your input to continue.");
  });

  it("renders waiting status from typed activity metadata", () => {
    const presence = createUserVisibleSeedyTurnPresence({
      turn_id: "turn-waiting",
      phase: "waiting",
      importance: "status",
      subject: "Checking the project state",
      last_activity_at: "2026-05-10T00:00:00.000Z",
      last_activity_label: "Checking the project state",
      expected_next: "progress",
    });

    expect(renderSeedyPresenceStatusText(presence, {
      now: "2026-05-10T00:00:35.000Z",
    })).toBe("I'm still working on it. Last visible activity: checking the project state about 35 seconds ago.");
  });

  it("uses a concise honest fallback when waiting activity is unavailable", () => {
    const presence = createSeedyTurnPresence({
      turn_id: "turn-unsafe-waiting",
      phase: "waiting",
      audience: "user",
      importance: "status",
      subject: "Calling model openai/gpt-5.5 with tool catalog",
      reason: "Raw command output is still running.",
      last_activity_label: "model_request: openai/gpt-5.5",
      started_at: "2026-05-10T00:00:00.000Z",
      updated_at: "2026-05-10T00:00:00.000Z",
      last_activity_at: "2026-05-10T00:00:00.000Z",
      expected_next: "progress",
    });

    const status = renderSeedyPresenceStatusText(presence, {
      now: "2026-05-10T00:00:35.000Z",
    });

    expect(status).toBe("I'm still checking this. I don't have a more specific visible update yet.");
    expect(status).not.toMatch(/openai|gpt|model|tool catalog|command output/i);
  });

  it("does not render command-shaped activity labels", () => {
    const presence = createUserVisibleSeedyTurnPresence({
      turn_id: "turn-command-label",
      phase: "waiting",
      importance: "status",
      subject: "Running command npm test -- --grep auth",
      last_activity_at: "2026-05-10T00:00:00.000Z",
      last_activity_label: "aws ssm get-parameter --with-decryption /prod/secret",
      expected_next: "progress",
    });

    const status = renderSeedyPresenceStatusText(presence, {
      now: "2026-05-10T00:00:35.000Z",
    });

    expect(status).toBe("I'm still checking this. I don't have a more specific visible update yet.");
    expect(status).not.toMatch(/npm test|aws ssm|with-decryption|prod\/secret/i);
  });

  it("filters uppercase command-shaped labels with locale-stable matching", () => {
    const presence = createUserVisibleSeedyTurnPresence({
      turn_id: "turn-uppercase-command",
      phase: "waiting",
      importance: "status",
      subject: "PIP install private-package",
      last_activity_at: "2026-05-10T00:00:00.000Z",
      last_activity_label: "PIP install private-package",
      expected_next: "progress",
    });

    const status = renderSeedyPresenceStatusText(presence, {
      now: "2026-05-10T00:00:35.000Z",
    });

    expect(status).toBe("I'm still checking this. I don't have a more specific visible update yet.");
    expect(status).not.toMatch(/PIP install|private-package/i);
  });

  it("falls back to safe subject when the activity label is unsafe", () => {
    const presence = createUserVisibleSeedyTurnPresence({
      turn_id: "turn-safe-subject",
      phase: "waiting",
      importance: "status",
      subject: "Checking the project state",
      last_activity_at: "2026-05-10T00:00:00.000Z",
      last_activity_label: "npm test -- --grep auth",
      expected_next: "progress",
    });

    expect(renderSeedyPresenceStatusText(presence, {
      now: "2026-05-10T00:00:35.000Z",
    })).toBe("I'm still working on it. Last visible activity: checking the project state about 35 seconds ago.");
  });

  it("uses the current clock for elapsed context when no explicit clock is provided", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-10T00:00:35.000Z"));
    const presence = createUserVisibleSeedyTurnPresence({
      turn_id: "turn-real-clock",
      phase: "waiting",
      importance: "status",
      subject: "Checking the project state",
      last_activity_at: "2026-05-10T00:00:00.000Z",
      last_activity_label: "Checking the project state",
      expected_next: "progress",
    });

    expect(renderSeedyPresenceStatusText(presence))
      .toBe("I'm still working on it. Last visible activity: checking the project state about 35 seconds ago.");
  });

  it("filters uppercase internal provider labels with locale-stable matching", () => {
    const presence = createUserVisibleSeedyTurnPresence({
      turn_id: "turn-uppercase-provider",
      phase: "waiting",
      importance: "status",
      subject: "OPENAI provider request",
      last_activity_at: "2026-05-10T00:00:00.000Z",
      last_activity_label: "API KEY check for OPENAI",
      expected_next: "progress",
    });

    const status = renderSeedyPresenceStatusText(presence, {
      now: "2026-05-10T00:00:35.000Z",
    });

    expect(status).toBe("I'm still checking this. I don't have a more specific visible update yet.");
    expect(status).not.toMatch(/OPENAI|API KEY/i);
  });
});
