// ─── MCP Server Tool Tests ───

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { StateManager } from "../../../base/state/state-manager.js";
import {
  toolGoalList,
  toolGoalStatus,
  toolGoalCreate,
  toolObserve,
  toolTaskList,
  toolKnowledgeSearch,
  toolTrigger,
  type MCPServerDeps,
} from "../tools.js";

// ─── Helpers ───

async function makeTempDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-mcp-test-"));
}

function parseMCPText(result: { content: [{ type: string; text: string }] }): unknown {
  return JSON.parse(result.content[0].text);
}

function makeDeps(baseDir: string): MCPServerDeps {
  const stateManager = new StateManager(baseDir);
  return { stateManager, baseDir };
}

async function createGoal(stateManager: StateManager, id: string, overrides: Record<string, unknown> = {}): Promise<void> {
  const now = new Date().toISOString();
  const goal = {
    id,
    parent_id: null,
    node_type: "goal",
    title: `Test Goal ${id}`,
    description: "A test goal",
    status: "active",
    dimensions: [],
    gap_aggregation: "max",
    dimension_mapping: null,
    constraints: [],
    children_ids: [],
    target_date: null,
    origin: "manual",
    pace_snapshot: null,
    deadline: null,
    confidence_flag: null,
    user_override: false,
    feasibility_note: null,
    uncertainty_weight: 1.0,
    decomposition_depth: 0,
    specificity_score: null,
    loop_status: "idle",
    created_at: now,
    updated_at: now,
    ...overrides,
  };
  await stateManager.writeRaw(`goals/${id}/goal.json`, goal);
}

// ─── Tests ───

describe("pulseed_goal_list", () => {
  let tmpDir: string;
  let deps: MCPServerDeps;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    deps = makeDeps(tmpDir);
    await deps.stateManager.init();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty list when no goals", async () => {
    const result = await toolGoalList(deps);
    const data = parseMCPText(result) as unknown[];
    expect(Array.isArray(data)).toBe(true);
    expect(data).toHaveLength(0);
  });

  it("returns goals with correct fields", async () => {
    await createGoal(deps.stateManager, "goal-1");
    await createGoal(deps.stateManager, "goal-2");

    const result = await toolGoalList(deps);
    const data = parseMCPText(result) as Array<{ id: string; title: string; status: string; loop_status: string }>;

    expect(data).toHaveLength(2);
    const ids = data.map((g) => g.id).sort();
    expect(ids).toEqual(["goal-1", "goal-2"]);
    for (const g of data) {
      expect(g.title).toBeDefined();
      expect(g.status).toBeDefined();
      expect(g.loop_status).toBeDefined();
    }
  });
});

describe("pulseed_goal_status", () => {
  let tmpDir: string;
  let deps: MCPServerDeps;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    deps = makeDeps(tmpDir);
    await deps.stateManager.init();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns error for unknown goal", async () => {
    const result = await toolGoalStatus(deps, { goal_id: "nonexistent" });
    const data = parseMCPText(result) as { error: string };
    expect(data.error).toContain("nonexistent");
  });

  it("returns goal and gap for valid goal_id", async () => {
    await createGoal(deps.stateManager, "goal-abc");

    const result = await toolGoalStatus(deps, { goal_id: "goal-abc" });
    const data = parseMCPText(result) as { goal: { id: string }; latest_gap: unknown };
    expect(data.goal.id).toBe("goal-abc");
    expect(data.latest_gap).toBeNull();
  });

  it("records concrete Capability Plane admission before reading local goal state", async () => {
    await createGoal(deps.stateManager, "goal-admitted");
    const order: string[] = [];
    const traces: unknown[] = [];
    const recordTrace = vi.fn(async (trace: unknown) => {
      traces.push(trace);
      order.push("trace");
      return {} as never;
    });
    const originalLoadGoal = deps.stateManager.loadGoal.bind(deps.stateManager);
    vi.spyOn(deps.stateManager, "loadGoal").mockImplementation(async (goalId: string) => {
      order.push("read");
      return originalLoadGoal(goalId);
    });

    const result = await toolGoalStatus(
      { ...deps, personalAgentRuntime: { recordTrace } },
      { goal_id: "goal-admitted" },
    );

    const data = parseMCPText(result) as { goal: { id: string } };
    expect(data.goal.id).toBe("goal-admitted");
    expect(order.slice(0, 2)).toEqual(["trace", "read"]);
    expect(traces[0]).toEqual(expect.objectContaining({
      capability_decisions: [
        expect.objectContaining({
          decision: "available",
          capability_refs: expect.arrayContaining([
            expect.objectContaining({
              kind: "capability_admission",
              ref: expect.stringMatching(/^capability-admission:/),
            }),
            expect.objectContaining({
              kind: "capability_fingerprint",
              ref: expect.any(String),
            }),
          ]),
        }),
      ],
    }));
  });
});

describe("pulseed_goal_create", () => {
  let tmpDir: string;
  let deps: MCPServerDeps;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    deps = makeDeps(tmpDir);
    await deps.stateManager.init();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("requires approval before a verified built-in MCP capability creates a goal", async () => {
    const result = await toolGoalCreate(deps, { title: "My Goal", description: "Do something" });
    const data = parseMCPText(result) as { error: string };

    expect(data.error).toContain("capability:mcp_server:pulseed:pulseed_goal_create requires approval before mutate");
    await expect(deps.stateManager.listGoalIds()).resolves.toEqual([]);
  });
});

describe("pulseed_knowledge_search", () => {
  let tmpDir: string;
  let deps: MCPServerDeps;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    deps = makeDeps(tmpDir);
    await deps.stateManager.init();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty results when knowledge base is empty", async () => {
    const result = await toolKnowledgeSearch(deps, { query: "anything" });
    const data = parseMCPText(result) as { query: string; results: unknown[] };
    expect(data.query).toBe("anything");
    expect(data.results).toHaveLength(0);
  });
});

describe("pulseed_trigger", () => {
  let tmpDir: string;
  let deps: MCPServerDeps;

  beforeEach(async () => {
    tmpDir = await makeTempDir();
    deps = makeDeps(tmpDir);
    await deps.stateManager.init();
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("requires approval before a verified built-in MCP capability writes a trigger event", async () => {
    const result = await toolTrigger(deps, {
      source: "test",
      event_type: "test.event",
      data: { key: "value" },
    });
    const data = parseMCPText(result) as { error: string };

    expect(data.error).toContain("capability:mcp_server:pulseed:pulseed_trigger requires approval before mutate");
    const eventEntries = await fsp.readdir(path.join(tmpDir, "events"));
    expect(eventEntries.some((entry) => entry.startsWith("mcp_trigger_"))).toBe(false);
  });
});
