import { describe, expect, it } from "vitest";
import {
  createSeedyTurnPresence,
  createUserVisibleSeedyTurnPresence,
  type SeedyTurnPresencePhase,
} from "../seedy-turn-presence.js";
import { renderSeedyPresenceViewModel } from "../seedy-presence-view-model.js";

const NOW = "2026-05-10T06:40:00.000Z";

describe("Seedy presence view model", () => {
  it("renders every turn presence phase into a deterministic GUI body state", () => {
    const cases: Array<[SeedyTurnPresencePhase, string, string]> = [
      ["received", "attending", "none"],
      ["orienting", "attending", "none"],
      ["thinking", "thinking", "none"],
      ["acting", "acting", "tool"],
      ["waiting", "waiting", "progress"],
      ["blocked", "needs_user", "approval"],
      ["finalizing", "speaking", "none"],
      ["complete", "idle", "none"],
    ];

    for (const [phase, bodyState, surfaceHint] of cases) {
      const viewModel = renderSeedyPresenceViewModel(createUserVisibleSeedyTurnPresence({
        turn_id: `turn-${phase}`,
        phase,
        started_at: NOW,
      }));

      expect(viewModel).toMatchObject({
        schema_version: "seedy-presence-view-model-v1",
        turnId: `turn-${phase}`,
        bodyState,
        surfaceHint,
        startedAt: NOW,
        updatedAt: NOW,
        userVisible: true,
      });
      expect(viewModel.compactStatus).toMatch(/^[a-z_]+$/);
    }
  });

  it("maps action required and approval expectations to needs-user approval surfaces", () => {
    const actionRequired = renderSeedyPresenceViewModel(createUserVisibleSeedyTurnPresence({
      turn_id: "turn-approval",
      phase: "waiting",
      importance: "action_required",
      expected_next: "user_input",
      started_at: NOW,
    }));
    const approvalExpected = renderSeedyPresenceViewModel(createUserVisibleSeedyTurnPresence({
      turn_id: "turn-expected-approval",
      phase: "thinking",
      expected_next: "approval",
      started_at: NOW,
    }));

    expect(actionRequired).toMatchObject({
      bodyState: "needs_user",
      compactStatus: "needs_user",
      surfaceHint: "approval",
    });
    expect(approvalExpected).toMatchObject({
      bodyState: "thinking",
      surfaceHint: "approval",
    });
  });

  it("lets blocked importance override otherwise passive phases", () => {
    const blockedThinking = renderSeedyPresenceViewModel(createUserVisibleSeedyTurnPresence({
      turn_id: "turn-blocked-thinking",
      phase: "thinking",
      importance: "blocked",
      started_at: NOW,
    }));
    const blockedWaiting = renderSeedyPresenceViewModel(createUserVisibleSeedyTurnPresence({
      turn_id: "turn-blocked-waiting",
      phase: "waiting",
      importance: "blocked",
      expected_next: "progress",
      started_at: NOW,
    }));

    for (const viewModel of [blockedThinking, blockedWaiting]) {
      expect(viewModel).toMatchObject({
        bodyState: "needs_user",
        compactStatus: "needs_user",
        surfaceHint: "approval",
      });
    }
  });

  it("projects diagnostic presence as non-user-visible diagnostic surface without raw runtime detail", () => {
    const viewModel = renderSeedyPresenceViewModel(createSeedyTurnPresence({
      turn_id: "turn-diagnostic",
      audience: "diagnostic",
      phase: "acting",
      importance: "status",
      subject: "model gpt-example with tool shell_command",
      reason: "trace provider raw command output",
      diagnostic_ref: "trace:abc123",
      started_at: NOW,
      updated_at: NOW,
    }));

    expect(viewModel).toMatchObject({
      turnId: "turn-diagnostic",
      bodyState: "acting",
      compactStatus: "acting",
      surfaceHint: "diagnostic",
      userVisible: false,
    });
    expect(JSON.stringify(viewModel)).not.toContain("gpt-example");
    expect(JSON.stringify(viewModel)).not.toContain("shell_command");
    expect(JSON.stringify(viewModel)).not.toContain("trace:abc123");
  });

  it("uses typed state only and does not expose arbitrary subject text as compact GUI status", () => {
    const viewModel = renderSeedyPresenceViewModel(createUserVisibleSeedyTurnPresence({
      turn_id: "turn-subject",
      phase: "acting",
      subject: "Running /very/internal/path with provider debug details",
      reason: "model trace said to show this raw detail",
      started_at: NOW,
    }));

    expect(viewModel.compactStatus).toBe("acting");
    expect(JSON.stringify(viewModel)).not.toContain("/very/internal/path");
    expect(JSON.stringify(viewModel)).not.toContain("provider debug");
  });
});
