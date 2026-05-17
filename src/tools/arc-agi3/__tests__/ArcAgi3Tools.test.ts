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
  ArcAgi3StartInputSchema,
  ArcAgi3StartTool,
  createArcAgi3Tools,
  type ArcAgi3Scorecard,
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
function makeSensitiveScorecard(cardId: string): ArcAgi3Scorecard {
  return {
    card_id: cardId,
    score: 7,
    total_actions: 1,
    environments: [{
      score: 7,
      email: "operator@example.com",
      public_value: "kept",
    }],
    api_key: "arc-secret-key",
    user_id: "operator-1",
    nested: {
      token: "nested-secret-token",
      public_value: "kept",
    },
  } as ArcAgi3Scorecard;
}
const providerEnvKeys = [
  "PULSEED_PROVIDER",
  "PULSEED_LLM_PROVIDER",
  "PULSEED_ADAPTER",
  "PULSEED_DEFAULT_ADAPTER",
  "PULSEED_MODEL",
  "OPENAI_MODEL",
  "ANTHROPIC_MODEL",
  "OLLAMA_MODEL",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
] as const;

function makeContext(providerConfigBaseDir?: string): ToolCallContext {
  return {
    cwd: process.cwd(),
    goalId: "goal-arc",
    trustBalance: 100,
    preApproved: true,
    approvalFn: async () => true,
    ...(providerConfigBaseDir ? { providerConfigBaseDir } : {}),
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
      return makeSensitiveScorecard(cardId);
    },
    async retrieveScorecardForGame(cardId, gameId) {
      calls.push({ method: "retrieveScorecardForGame", input: { cardId, gameId } });
      return makeSensitiveScorecard(cardId);
    },
    async closeScorecard(cardId) {
      calls.push({ method: "closeScorecard", input: { cardId } });
      return makeSensitiveScorecard(cardId);
    },
  };
}

describe("ARC-AGI-3 tools", () => {
  let tmpDir: string;
  let artifactStore: ArcAgi3ArtifactStore;
  let previousEnv: Record<typeof providerEnvKeys[number], string | undefined>;

  beforeEach(async () => {
    previousEnv = Object.fromEntries(providerEnvKeys.map((key) => [key, process.env[key]])) as Record<
      typeof providerEnvKeys[number],
      string | undefined
    >;
    for (const key of providerEnvKeys) {
      delete process.env[key];
    }
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-arc-agi3-tools-"));
    artifactStore = new ArcAgi3ArtifactStore(path.join(tmpDir, "runs"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    for (const key of providerEnvKeys) {
      const previous = previousEnv[key];
      if (previous === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous;
      }
    }
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
    const deps = {
      client,
      artifactStore,
      pulseedCommit: "commit-1",
      providerConfigLoader: async () => ({
        provider: "openai" as const,
        model: "gpt-5.4",
        adapter: "openai_codex_cli" as const,
      }),
    };
    const context = makeContext();

    const list = await new ArcAgi3ListGamesTool(deps).call({}, context);
    expect(list.success).toBe(true);
    expect(list.summary).toContain("1 ARC-AGI-3 game");

    const start = await new ArcAgi3StartTool(deps).call({
      game_id: "ls20-016295f7601e",
      run_id: "run-1",
    }, context);
    expect(start.success).toBe(true);
    expect(start.data).toMatchObject({
      run_id: "run-1",
      card_id: "card-1",
      guid: "guid-1",
      claim_mode: "community_online_scorecard",
      model_provider: "openai",
      model_id: "gpt-5.4",
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
    expect(JSON.stringify(finish.data)).not.toContain("arc-secret-key");
    expect(JSON.stringify(finish.data)).not.toContain("operator@example.com");
    expect(JSON.stringify(finish.data)).not.toContain("nested-secret-token");

    const artifactText = fs.readFileSync(artifactStore.runPath("run-1"), "utf8");
    expect(artifactText).not.toContain("secret");
    expect(artifactText).not.toContain("operator@example.com");
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
      model_id: "gpt-5.4",
    });
    expect(artifact.scorecard.nested.public_value).toBe("kept");
    expect(artifact.scorecard.environments[0].public_value).toBe("kept");
    expect(artifact.submitted_action_log.map((entry: { action: string }) => entry.action)).toEqual(["RESET", "ACTION6"]);
    expect(fs.readFileSync(path.join(tmpDir, "runs", "run-1", "actions.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
    expect(fs.existsSync(artifactStore.scorecardPath("run-1"))).toBe(true);
  });

  it("resolves model identity from host provider config instead of model input", async () => {
    await fsp.writeFile(path.join(tmpDir, "provider.json"), JSON.stringify({
      provider: "anthropic",
      model: "claude-opus-arc",
      adapter: "claude_api",
      api_key: "anthropic-secret",
    }), "utf8");
    const client = makeMockClient();
    const deps = { client, artifactStore, pulseedCommit: "commit-1" };

    const parsed = ArcAgi3StartInputSchema.safeParse({
      game_id: "ls20-016295f7601e",
      run_id: "run-provider",
      model_provider: "openai",
      model_id: "gpt-5.5",
    });
    expect(parsed.success).toBe(false);

    const start = await new ArcAgi3StartTool(deps).call({
      game_id: "ls20-016295f7601e",
      run_id: "run-provider",
    }, makeContext(tmpDir));

    expect(start.success).toBe(true);
    expect(start.data).toMatchObject({
      model_provider: "anthropic",
      model_id: "claude-opus-arc",
    });
    expect(client.calls).toContainEqual({
      method: "openScorecard",
      input: expect.objectContaining({
        opaque: expect.objectContaining({
          model_provider: "anthropic",
          model_id: "claude-opus-arc",
        }),
      }),
    });

    const artifactText = fs.readFileSync(artifactStore.runPath("run-provider"), "utf8");
    expect(artifactText).not.toContain("anthropic-secret");
    expect(artifactText).not.toContain("gpt-5.5");
    expect(JSON.parse(artifactText)).toMatchObject({
      model_provider: "anthropic",
      model_id: "claude-opus-arc",
    });
  });

  it("shares one ARC REST client across the first-party tool set for sticky ARC sessions", async () => {
    const clients: ReturnType<typeof makeMockClient>[] = [];
    const tools = createArcAgi3Tools({
      artifactStore,
      pulseedCommit: "commit-1",
      clientFactory: () => {
        const client = makeMockClient();
        clients.push(client);
        return client;
      },
      providerConfigLoader: async () => ({
        provider: "openai" as const,
        model: "gpt-5.4",
        adapter: "openai_codex_cli" as const,
      }),
    });
    expect(clients).toHaveLength(0);
    const findTool = (name: string) => {
      const tool = tools.find((candidate) => candidate.metadata.name === name);
      if (!tool) throw new Error(`missing tool ${name}`);
      return tool;
    };

    await findTool("arc_agi3_start").call({
      game_id: "ls20-016295f7601e",
      run_id: "run-shared-client",
    }, makeContext());
    await findTool("arc_agi3_act").call({
      run_id: "run-shared-client",
      action: "ACTION1",
    }, makeContext());
    await findTool("arc_agi3_finish").call({
      run_id: "run-shared-client",
      close_scorecard: true,
    }, makeContext());

    expect(clients).toHaveLength(1);
    expect(clients[0]?.calls.map((call) => call.method)).toEqual([
      "openScorecard",
      "reset",
      "action",
      "closeScorecard",
    ]);
  });

  it("does not require ARC API credentials while merely registering ARC tools", () => {
    expect(() => createArcAgi3Tools()).not.toThrow();
  });

  it("keeps the ARC game-list tool directly visible inside the ARC-only tool policy", () => {
    const listGames = createArcAgi3Tools({ artifactStore }).find((tool) => tool.metadata.name === "arc_agi3_list_games");
    expect(listGames?.metadata.shouldDefer).toBe(false);
  });

  it("closes an opened scorecard when start fails before artifact creation", async () => {
    const calls: Array<{ method: string; input?: unknown }> = [];
    const client: ArcAgi3RestClient = {
      async listGames() {
        calls.push({ method: "listGames" });
        return [];
      },
      async openScorecard(input) {
        calls.push({ method: "openScorecard", input });
        return { card_id: "card-reset-fails" };
      },
      async reset(input) {
        calls.push({ method: "reset", input });
        throw new Error("reset failed");
      },
      async action(input) {
        calls.push({ method: "action", input });
        return baseSnapshot;
      },
      async retrieveScorecard(cardId) {
        calls.push({ method: "retrieveScorecard", input: { cardId } });
        return { card_id: cardId };
      },
      async retrieveScorecardForGame(cardId, gameId) {
        calls.push({ method: "retrieveScorecardForGame", input: { cardId, gameId } });
        return { card_id: cardId };
      },
      async closeScorecard(cardId) {
        calls.push({ method: "closeScorecard", input: { cardId } });
        return { card_id: cardId };
      },
    };
    const result = await new ArcAgi3StartTool({
      client,
      artifactStore,
      providerConfigLoader: async () => ({
        provider: "openai" as const,
        model: "gpt-5.4",
        adapter: "openai_codex_cli" as const,
      }),
    }).call({
      game_id: "ls20-016295f7601e",
      run_id: "run-reset-fails",
    }, makeContext());

    expect(result.success).toBe(false);
    expect(calls.map((call) => call.method)).toEqual(["openScorecard", "reset", "closeScorecard"]);
    expect(await artifactStore.exists("run-reset-fails")).toBe(false);
  });

  it("rejects duplicate run ids without mixing action logs or mutating prior artifacts", async () => {
    const firstClient = makeMockClient();
    const deps = {
      client: firstClient,
      artifactStore,
      pulseedCommit: "commit-1",
      providerConfigLoader: async () => ({
        provider: "openai" as const,
        model: "gpt-5.4",
        adapter: "openai_codex_cli" as const,
      }),
    };
    const first = await new ArcAgi3StartTool(deps).call({
      game_id: "ls20-016295f7601e",
      run_id: "run-duplicate",
    }, makeContext());
    expect(first.success).toBe(true);

    const secondClient = makeMockClient();
    const second = await new ArcAgi3StartTool({
      ...deps,
      client: secondClient,
    }).call({
      game_id: "ls20-016295f7601e",
      run_id: "run-duplicate",
    }, makeContext());

    expect(second.success).toBe(false);
    expect(second.summary).toContain("already exists");
    expect(secondClient.calls).toEqual([]);
    const artifact = JSON.parse(fs.readFileSync(artifactStore.runPath("run-duplicate"), "utf8"));
    expect(artifact.failure_reason).toBeNull();
    expect(artifact.submitted_action_log.map((entry: { action: string }) => entry.action)).toEqual(["RESET"]);
    expect(fs.readFileSync(path.join(tmpDir, "runs", "run-duplicate", "actions.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("does not mark a winning artifact failed when duplicate run id appears during create", async () => {
    const firstClient = makeMockClient();
    const deps = {
      client: firstClient,
      artifactStore,
      pulseedCommit: "commit-1",
      providerConfigLoader: async () => ({
        provider: "openai" as const,
        model: "gpt-5.4",
        adapter: "openai_codex_cli" as const,
      }),
    };
    const first = await new ArcAgi3StartTool(deps).call({
      game_id: "ls20-016295f7601e",
      run_id: "run-race",
    }, makeContext());
    expect(first.success).toBe(true);

    class RacingArtifactStore extends ArcAgi3ArtifactStore {
      private availabilityChecks = 0;

      override async assertRunIdAvailable(runId: string): Promise<void> {
        this.availabilityChecks += 1;
        if (this.availabilityChecks === 1) return;
        await super.assertRunIdAvailable(runId);
      }
    }

    const racingStore = new RacingArtifactStore(path.join(tmpDir, "runs"));
    const secondClient = makeMockClient();
    secondClient.openScorecard = async (input) => {
      secondClient.calls.push({ method: "openScorecard", input });
      return { card_id: "card-2" };
    };
    const second = await new ArcAgi3StartTool({
      ...deps,
      client: secondClient,
      artifactStore: racingStore,
    }).call({
      game_id: "ls20-016295f7601e",
      run_id: "run-race",
    }, makeContext());

    expect(second.success).toBe(false);
    expect(secondClient.calls.map((call) => call.method)).toEqual(["openScorecard", "reset", "closeScorecard"]);
    expect(secondClient.calls.at(-1)).toEqual({ method: "closeScorecard", input: { cardId: "card-2" } });
    const artifact = JSON.parse(fs.readFileSync(artifactStore.runPath("run-race"), "utf8"));
    expect(artifact.card_id).toBe("card-1");
    expect(artifact.failure_reason).toBeNull();
    expect(artifact.submitted_action_log.map((entry: { action: string }) => entry.action)).toEqual(["RESET"]);
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
