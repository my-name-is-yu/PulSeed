import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertReplayResult, runReplayFixture } from "../harness/replay-runner.js";
import type { ReplayFixture } from "../harness/types.js";

const fixturesPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "p0", "fixtures.json");
const fixtures = JSON.parse(readFileSync(fixturesPath, "utf8")) as ReplayFixture[];

describe("P0 replay fixture catalog", () => {
  it("covers migration, approval, schedule, queue, attention, daemon, and chat-session replay", () => {
    expect(fixtures.map((fixture) => fixture.domain).sort()).toEqual([
      "approval",
      "attention",
      "chat-session",
      "daemon",
      "queue",
      "schedule",
      "state",
    ]);
  });

  it("keeps replay fixtures fail-closed and provider-free", () => {
    for (const fixture of fixtures) {
      expect(fixture.input.allow_network).not.toBe(true);
      expect(fixture.input.allow_real_llm).not.toBe(true);
      expect(fixture.expected.audit.length).toBeGreaterThan(0);
      expect(JSON.stringify(fixture.expected.audit)).toMatch(/blocked|restored|idempotent|reclaimed|pending_real_runner/);
    }
  });
});

describe.each(fixtures)("P0 replay fixture: $contract_name", (fixture) => {
  it("preserves the same visible state after restart/replay", async () => {
    const result = await runReplayFixture(fixture);
    assertReplayResult(fixture, result);
    const runner = result.fresh_state.runner as { status?: string } | undefined;
    expect(["real_production_path", "pending_real_runner"]).toContain(runner?.status);
    expect(result.fresh_state).toEqual(result.restarted_state);
  });
});
