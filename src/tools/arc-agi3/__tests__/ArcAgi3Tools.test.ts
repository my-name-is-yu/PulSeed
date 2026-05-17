import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolCallContext } from "../../types.js";
import { ArcAgi3ArtifactStore } from "../artifacts.js";
import { ArcAgi3HttpClient, type ArcAgi3RestClient } from "../client.js";
import {
  ArcAgi3ActInputSchema,
  ArcAgi3ActTool,
  ArcAgi3FinishTool,
  ArcAgi3ListGamesTool,
  ArcAgi3StartTool,
  type ArcAgi3Snapshot,
} from "../index.js";

const baseSnapshot: ArcAgi3Snapshot = {
  game_id: "ls20-016295f7601e",
  guid: "guid-1",
  frame: [[[0]]],
  state: "NOT_FINISHED",
  levels_completed: 0,
  win_levels: 254,
  action_input: { id: 0, data: {} },
  available_actions: [1, 2, 3, 4, 6],
};

function makeContext(): ToolCallContext {
  return {
    cwd: process.cwd(),
    goalId: "goal-arc",
    trustBalance: 100,
    preApproved: true,
    approvalFn: async () => true,
  };
}

function makeMockClient(): ArcAgi3RestClient & {
  calls: Array<{ method: string; input?: unknown }>;
} {
  const calls: Array<{ method: string; input?: unknown }> = [];
  return {
    calls,
    async listGames() {
      calls.push({ method: "listGames" });
      return [{ game_id: "ls20-016295f7601e", title: "LS20" }];
    },
    async openScorecard(input) {
      calls.push({ method: "openScorecard", input });
      return { card_id: "card-1" };
    },
    async reset(input) {
      calls.push({ method: "reset", input });
      return { ...baseSnapshot, guid: input.guid ?? "guid-1", action_input: { id: 0, data: {} } };
    },
    async action(input) {
      calls.push({ method: "action", input });
      return {
        ...baseSnapshot,
        levels_completed: 1,
        action_input: {
          id: input.action === "ACTION6" ? 6 : Number(input.action.replace("ACTION", "")),
          data: input.action === "ACTION6" ? { x: input.x, y: input.y } : {},
        },
        available_actions: [1, 2, 3, 4],
      };
    },
    async retrieveScorecard(cardId) {
      calls.push({ method: "retrieveScorecard", input: { cardId } });
      return { card_id: cardId, score: 7, total_actions: 1, environments: [] };
    },
    async retrieveScorecardForGame(cardId, gameId) {
      calls.push({ method: "retrieveScorecardForGame", input: { cardId, gameId } });
      return { card_id: cardId, score: 7, total_actions: 1, environments: [] };
    },
    async closeScorecard(cardId) {
      calls.push({ method: "closeScorecard", input: { cardId } });
      return { card_id: cardId, score: 7, total_actions: 1, environments: [] };
    },
  };
}

describe("ARC-AGI-3 tools", () => {
  let tmpDir: string;
  let artifactStore: ArcAgi3ArtifactStore;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-arc-agi3-tools-"));
    artifactStore = new ArcAgi3ArtifactStore(path.join(tmpDir, "runs"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("validates the official action interface before execution", () => {
    expect(ArcAgi3ActInputSchema.safeParse({ run_id: "run-1", action: "ACTION1" }).success).toBe(true);
    expect(ArcAgi3ActInputSchema.safeParse({ run_id: "run-1", action: "RESET" }).success).toBe(true);
    expect(ArcAgi3ActInputSchema.safeParse({ run_id: "run-1", action: "ACTION6", x: 0, y: 63 }).success).toBe(true);
    expect(ArcAgi3ActInputSchema.safeParse({ run_id: "run-1", action: "ACTION6", x: 64, y: 0 }).success).toBe(false);
    expect(ArcAgi3ActInputSchema.safeParse({ run_id: "run-1", action: "ACTION6", x: 0 }).success).toBe(false);
    expect(ArcAgi3ActInputSchema.safeParse({ run_id: "run-1", action: "ACTION1", x: 0, y: 0 }).success).toBe(false);
    expect(ArcAgi3ActInputSchema.safeParse({ run_id: "run-1", action: "JUMP" }).success).toBe(false);
  });

  it("runs list/start/act/finish against a mocked ARC client and writes non-verified community artifacts", async () => {
    const client = makeMockClient();
    const deps = { client, artifactStore, pulseedCommit: "commit-1" };
    const context = makeContext();

    const list = await new ArcAgi3ListGamesTool(deps).call({}, context);
    expect(list.success).toBe(true);
    expect(list.summary).toContain("1 ARC-AGI-3 game");

    const start = await new ArcAgi3StartTool(deps).call({
      game_id: "ls20-016295f7601e",
      run_id: "run-1",
      model_provider: "openai",
      model_id: "gpt-5.5",
    }, context);
    expect(start.success).toBe(true);
    expect(start.data).toMatchObject({
      run_id: "run-1",
      card_id: "card-1",
      guid: "guid-1",
      claim_mode: "community_online_scorecard",
    });

    const act = await new ArcAgi3ActTool(deps).call({
      run_id: "run-1",
      action: "ACTION6",
      x: 63,
      y: 0,
      reasoning: { confidence: 0.5 },
    }, context);
    expect(act.success).toBe(true);
    expect(client.calls).toContainEqual({
      method: "action",
      input: expect.objectContaining({ action: "ACTION6", x: 63, y: 0 }),
    });

    const finish = await new ArcAgi3FinishTool(deps).call({ run_id: "run-1", close_scorecard: true }, context);
    expect(finish.success).toBe(true);
    expect(finish.data).toMatchObject({
      run_id: "run-1",
      card_id: "card-1",
      official_score: 7,
      claim_mode: "community_online_scorecard",
    });

    const artifactText = fs.readFileSync(artifactStore.runPath("run-1"), "utf8");
    expect(artifactText).not.toContain("secret");
    expect(artifactText).not.toContain("Verified");
    expect(artifactText).not.toContain("Kaggle-compatible");
    const artifact = JSON.parse(artifactText);
    expect(artifact).toMatchObject({
      schema_version: "pulseed.arc_agi_3.run/v1",
      claim_mode: "community_online_scorecard",
      mode: "online_api",
      game_id: "ls20-016295f7601e",
      action_count: 1,
      reset_count: 1,
      official_scorecard_id: "card-1",
      official_score: 7,
      model_provider: "openai",
      model_id: "gpt-5.5",
    });
    expect(artifact.submitted_action_log.map((entry: { action: string }) => entry.action)).toEqual(["RESET", "ACTION6"]);
    expect(fs.readFileSync(path.join(tmpDir, "runs", "run-1", "actions.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
    expect(fs.existsSync(artifactStore.scorecardPath("run-1"))).toBe(true);
  });
});

describe("ArcAgi3HttpClient", () => {
  it("uses host-owned API key and preserves ARC session cookies", async () => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        headers: init?.headers as Record<string, string>,
      });
      if (String(url).endsWith("/api/games")) {
        return new Response(JSON.stringify([{ game_id: "ls20-016295f7601e", title: "LS20" }]), {
          status: 200,
          headers: { "set-cookie": "AWSALB=session-1; Path=/; HttpOnly" },
        });
      }
      return new Response(JSON.stringify({ card_id: "card-1" }), { status: 200 });
    });

    const client = new ArcAgi3HttpClient({
      apiKey: "arc-secret-key",
      baseUrl: "https://three.arcprize.org",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.listGames();
    await client.openScorecard({});

    expect(requests[0]?.headers["X-API-Key"]).toBe("arc-secret-key");
    expect(requests[1]?.headers["Cookie"]).toBe("AWSALB=session-1");
    expect(requests.map((request) => request.url).join("\n")).not.toContain("arc-secret-key");
  });
});
