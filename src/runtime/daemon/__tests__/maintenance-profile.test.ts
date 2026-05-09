import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DaemonConfigSchema, DaemonStateSchema } from "../../types/daemon.js";
import {
  retractRelationshipProfileItem,
  upsertRelationshipProfileItem,
} from "../../../platform/profile/relationship-profile.js";
import { runProactiveMaintenance } from "../maintenance.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-proactive-profile-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("runProactiveMaintenance relationship profile context", () => {
  it("uses only active resident-behavior profile items", async () => {
    const baseDir = makeTempDir();
    await upsertRelationshipProfileItem(baseDir, {
      stableKey: "user.intervention.nudge",
      kind: "intervention_policy",
      value: "Suggest only when the next action is clearly reversible.",
      source: "cli_update",
      allowedScopes: ["resident_behavior"],
      now: "2026-05-02T00:00:00.000Z",
    });
    await upsertRelationshipProfileItem(baseDir, {
      stableKey: "user.preference.planning",
      kind: "preference",
      value: "Use detailed weekly planning notes.",
      source: "cli_update",
      allowedScopes: ["local_planning"],
      now: "2026-05-02T00:00:00.000Z",
    });

    const sendMessage = vi.fn().mockResolvedValue({ content: JSON.stringify({ action: "sleep", details: {} }) });
    const llmClient = {
      sendMessage,
      parseJSON: vi.fn().mockImplementation((content: string, schema: { parse(value: unknown): unknown }) =>
        schema.parse(JSON.parse(content))
      ),
    };

    const result = await runProactiveMaintenance({
      baseDir,
      config: DaemonConfigSchema.parse({
        proactive_mode: true,
        proactive_interval_ms: 1,
        runtime_root: path.join(baseDir, "runtime"),
      }),
      llmClient: llmClient as never,
      state: DaemonStateSchema.parse({
        pid: 123,
        started_at: "2026-05-02T00:00:00.000Z",
        last_loop_at: null,
        loop_count: 0,
        active_goals: [],
        status: "idle",
      }),
      lastProactiveTickAt: 0,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });

    const prompt = sendMessage.mock.calls[0]?.[0]?.[0]?.content ?? "";
    expect(prompt).toContain("Suggest only when the next action is clearly reversible.");
    expect(prompt).toContain("Proactive maintenance relationship profile Surface");
    expect(prompt).toContain("requested_use=proactive_action_candidate");
    expect(prompt).toContain("Use only Surface-included relationship context below.");
    expect(prompt).not.toContain("Relationship Profile (active items only; consent scope: resident_behavior)");
    expect(prompt).not.toContain("Use detailed weekly planning notes.");
    expect(result.surface).toEqual(expect.objectContaining({
      surface_id: expect.stringContaining("surface:relationship-profile:daemon:proactive-maintenance"),
      surface_included_count: 1,
      surface_excluded_count: 0,
      surface_inspection: expect.objectContaining({
        target: "daemon",
        inspection: expect.objectContaining({
          surface_id: result.surface?.surface_id,
          included_summaries: [expect.objectContaining({
            record_kind: "intervention_policy",
            use_class: "proactive_action_candidate",
          })],
          excluded_summaries: [],
        }),
      }),
    }));
    expect(JSON.stringify(result.surface?.surface_inspection)).not.toContain(
      "Suggest only when the next action is clearly reversible."
    );
  });

  it("uses the latest active intervention policy and ignores stale or sensitive policies", async () => {
    const baseDir = makeTempDir();
    await upsertRelationshipProfileItem(baseDir, {
      stableKey: "user.intervention.nudge",
      kind: "intervention_policy",
      value: "Proactively notify for any minor observation.",
      source: "cli_update",
      allowedScopes: ["resident_behavior", "user_facing_review"],
      now: "2026-05-02T00:00:00.000Z",
    });
    await upsertRelationshipProfileItem(baseDir, {
      stableKey: "user.intervention.nudge",
      kind: "intervention_policy",
      value: "Ask for confirmation before non-urgent proactive suggestions.",
      source: "user_correction",
      allowedScopes: ["resident_behavior", "user_facing_review"],
      now: "2026-05-02T00:01:00.000Z",
    });
    await upsertRelationshipProfileItem(baseDir, {
      stableKey: "user.intervention.weekend",
      kind: "intervention_policy",
      value: "Send proactive weekend nudges without asking.",
      source: "cli_update",
      allowedScopes: ["resident_behavior", "user_facing_review"],
      now: "2026-05-02T00:02:00.000Z",
    });
    await retractRelationshipProfileItem(baseDir, {
      stableKey: "user.intervention.weekend",
      reason: "No weekend nudges without explicit approval.",
      source: "user_correction",
      now: "2026-05-02T00:03:00.000Z",
    });
    await upsertRelationshipProfileItem(baseDir, {
      stableKey: "user.intervention.health",
      kind: "intervention_policy",
      value: "Use sensitive health context to decide proactive timing.",
      source: "cli_update",
      sensitivity: "sensitive",
      allowedScopes: ["resident_behavior", "user_facing_review"],
      now: "2026-05-02T00:04:00.000Z",
    });

    const sendMessage = vi.fn().mockResolvedValue({ content: JSON.stringify({ action: "sleep", details: {} }) });
    const llmClient = {
      sendMessage,
      parseJSON: vi.fn().mockImplementation((content: string, schema: { parse(value: unknown): unknown }) =>
        schema.parse(JSON.parse(content))
      ),
    };

    await runProactiveMaintenance({
      baseDir,
      config: DaemonConfigSchema.parse({
        proactive_mode: true,
        proactive_interval_ms: 1,
        runtime_root: path.join(baseDir, "runtime"),
      }),
      llmClient: llmClient as never,
      state: DaemonStateSchema.parse({
        pid: 123,
        started_at: "2026-05-02T00:00:00.000Z",
        last_loop_at: null,
        loop_count: 0,
        active_goals: [],
        status: "idle",
      }),
      lastProactiveTickAt: 0,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });

    const prompt = sendMessage.mock.calls[0]?.[0]?.[0]?.content ?? "";
    expect(prompt).toContain("Ask for confirmation before non-urgent proactive suggestions.");
    expect(prompt).toContain("Proactive maintenance relationship profile Surface");
    expect(prompt).toContain("requested_use=proactive_action_candidate");
    expect(prompt).not.toContain("Relationship Profile (active items only; consent scope: resident_behavior)");
    expect(prompt).not.toContain("status=active; version=2");
    expect(prompt).toContain("sensitivity=private");
    expect(prompt).not.toContain("Proactively notify for any minor observation.");
    expect(prompt).not.toContain("Send proactive weekend nudges without asking.");
    expect(prompt).not.toContain("sensitive health context");
  });

  it("uses latest active resident boundary and excludes sensitive boundary details", async () => {
    const baseDir = makeTempDir();
    await upsertRelationshipProfileItem(baseDir, {
      stableKey: "user.boundary.notifications",
      kind: "boundary",
      value: "Notify freely.",
      source: "cli_update",
      allowedScopes: ["resident_behavior", "user_facing_review"],
      now: "2026-05-02T00:00:00.000Z",
    });
    await upsertRelationshipProfileItem(baseDir, {
      stableKey: "user.boundary.notifications",
      kind: "boundary",
      value: "Ask before non-urgent notifications.",
      source: "user_correction",
      allowedScopes: ["resident_behavior", "user_facing_review"],
      now: "2026-05-02T00:01:00.000Z",
    });
    await upsertRelationshipProfileItem(baseDir, {
      stableKey: "user.boundary.health",
      kind: "boundary",
      value: "Do not use health context outside explicit review.",
      source: "cli_update",
      sensitivity: "sensitive",
      allowedScopes: ["resident_behavior", "user_facing_review"],
      now: "2026-05-02T00:02:00.000Z",
    });

    const sendMessage = vi.fn().mockResolvedValue({ content: JSON.stringify({ action: "sleep", details: {} }) });
    const llmClient = {
      sendMessage,
      parseJSON: vi.fn().mockImplementation((content: string, schema: { parse(value: unknown): unknown }) =>
        schema.parse(JSON.parse(content))
      ),
    };

    await runProactiveMaintenance({
      baseDir,
      config: DaemonConfigSchema.parse({
        proactive_mode: true,
        proactive_interval_ms: 1,
        runtime_root: path.join(baseDir, "runtime"),
      }),
      llmClient: llmClient as never,
      state: DaemonStateSchema.parse({
        pid: 123,
        started_at: "2026-05-02T00:00:00.000Z",
        last_loop_at: null,
        loop_count: 0,
        active_goals: [],
        status: "idle",
      }),
      lastProactiveTickAt: 0,
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });

    const prompt = sendMessage.mock.calls[0]?.[0]?.[0]?.content ?? "";
    expect(prompt).toContain("Ask before non-urgent notifications.");
    expect(prompt).toContain("Proactive maintenance relationship profile Surface");
    expect(prompt).toContain("requested_use=proactive_action_candidate");
    expect(prompt).not.toContain("Relationship Profile (active items only; consent scope: resident_behavior)");
    expect(prompt).not.toContain("Notify freely.");
    expect(prompt).not.toContain("health context");
  });
});
