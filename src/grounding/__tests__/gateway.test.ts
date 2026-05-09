import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StateManager } from "../../base/state/state-manager.js";
import { SqliteSoilRepository } from "../../platform/soil/sqlite-repository.js";
import {
  retractRelationshipProfileItem,
  upsertRelationshipProfileItem,
} from "../../platform/profile/relationship-profile.js";
import { buildStaticSystemPrompt } from "../../interface/chat/grounding.js";
import { createGroundingGateway } from "../gateway.js";

function makeStateManager(overrides: Partial<StateManager> = {}): StateManager {
  return {
    listGoalIds: vi.fn().mockResolvedValue(["goal-1"]),
    loadGoal: vi.fn().mockResolvedValue({
      title: "Ship grounding",
      status: "active",
      loop_status: "running",
    }),
    readRaw: vi.fn().mockResolvedValue(null),
    loadGapHistory: vi.fn().mockResolvedValue([]),
    getBaseDir: vi.fn().mockReturnValue(path.join(os.tmpdir(), "pulseed-grounding-home")),
    ...overrides,
  } as unknown as StateManager;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GroundingGateway", () => {
  it("keeps history out of chat/general_turn but includes it for chat/handoff", async () => {
    const gateway = createGroundingGateway({ stateManager: makeStateManager() });
    const common = {
      workspaceRoot: "/repo",
      recentMessages: [
        { role: "user" as const, content: "First" },
        { role: "assistant" as const, content: "Second" },
      ],
    };

    const general = await gateway.build({
      surface: "chat",
      purpose: "general_turn",
      ...common,
    });
    const handoff = await gateway.build({
      surface: "chat",
      purpose: "handoff",
      ...common,
    });

    expect(general.dynamicSections.some((section) => section.key === "session_history")).toBe(false);
    expect(handoff.dynamicSections.some((section) => section.key === "session_history")).toBe(true);
  });

  it("trust-gates AGENTS files from untrusted paths and records the rejection", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-grounding-agents-"));
    const homeDir = path.join(tmpRoot, "home");
    const repoDir = path.join(tmpRoot, "repo");
    const nestedDir = path.join(repoDir, "node_modules", "pkg");
    fs.mkdirSync(path.join(homeDir, ".pulseed"), { recursive: true });
    fs.mkdirSync(path.join(repoDir, ".git"), { recursive: true });
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(homeDir, ".pulseed", "AGENTS.md"), "Home instruction");
    fs.writeFileSync(path.join(repoDir, "AGENTS.md"), "Repo instruction");
    fs.writeFileSync(path.join(nestedDir, "AGENTS.md"), "Node modules instruction");
    vi.stubEnv("HOME", homeDir);

    const gateway = createGroundingGateway({ stateManager: makeStateManager() });
    const bundle = await gateway.build({
      surface: "agent_loop",
      purpose: "task_execution",
      workspaceRoot: nestedDir,
      userMessage: "Implement the change safely",
      query: "Implement the change safely",
    });

    const repoInstructions = bundle.dynamicSections.find((section) => section.key === "repo_instructions");
    expect(repoInstructions?.content).toContain("Repo instruction");
    expect(repoInstructions?.content).not.toContain("Node modules instruction");
    expect(bundle.warnings.some((warning) => warning.includes("Rejected repo instructions"))).toBe(true);
    expect(bundle.traces.source.some((source) => source.path?.endsWith("node_modules/pkg/AGENTS.md") && source.accepted === false)).toBe(true);
  });

  it("keeps raw USER.md out of agent-loop identity grounding while preserving chat identity", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-grounding-user-md-"));
    const homeDir = path.join(tmpRoot, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    fs.writeFileSync(path.join(homeDir, "SEED.md"), "# Seedy\n\nAgent seed.", "utf-8");
    fs.writeFileSync(path.join(homeDir, "ROOT.md"), "# Root\n\nRoot policy.", "utf-8");
    fs.writeFileSync(path.join(homeDir, "USER.md"), "# About You\n\nPrefer verbose status reports.", "utf-8");

    const gateway = createGroundingGateway({ stateManager: makeStateManager() });
    const agentLoop = await gateway.build({
      surface: "agent_loop",
      purpose: "task_execution",
      homeDir,
      workspaceRoot: "/repo",
    });
    const chat = await gateway.build({
      surface: "chat",
      purpose: "general_turn",
      homeDir,
      workspaceRoot: "/repo",
    });

    const agentIdentity = agentLoop.staticSections.find((section) => section.key === "identity")?.content ?? "";
    const chatIdentity = chat.staticSections.find((section) => section.key === "identity")?.content ?? "";
    expect(agentIdentity).not.toContain("Prefer verbose status reports.");
    expect(chatIdentity).toContain("Prefer verbose status reports.");
  });

  it("keeps raw USER.md out of fallback static system prompt", () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-static-user-md-"));
    fs.writeFileSync(path.join(tmpRoot, "SEED.md"), "# Seedy\n\nAgent seed.", "utf-8");
    fs.writeFileSync(path.join(tmpRoot, "ROOT.md"), "# Root\n\nRoot policy.", "utf-8");
    fs.writeFileSync(path.join(tmpRoot, "USER.md"), "# About You\n\nPrefer verbose status reports.", "utf-8");

    const prompt = buildStaticSystemPrompt(tmpRoot);

    expect(prompt).toContain("Agent seed.");
    expect(prompt).not.toContain("Prefer verbose status reports.");
  });

  it("prefers Soil knowledge over broader knowledge results when Soil hits exist", async () => {
    const gateway = createGroundingGateway({ stateManager: makeStateManager() });
    const knowledgeQuery = vi.fn().mockResolvedValue({
      retrievalId: "knowledge:test",
      items: [{ id: "k1", content: "Fallback knowledge", source: "test" }],
    });

    const bundle = await gateway.build({
      surface: "agent_loop",
      purpose: "task_execution",
      workspaceRoot: "/repo",
      userMessage: "Implement the grounding gateway",
      query: "Implement the grounding gateway",
      soilQuery: async () => ({
        retrievalSource: "prefetch",
        warnings: [],
        hits: [{ soilId: "soil:1", title: "Grounding plan", summary: "Use Soil first" }],
      }),
      knowledgeQuery,
    });

    expect(bundle.dynamicSections.some((section) => section.key === "soil_knowledge")).toBe(true);
    expect(bundle.dynamicSections.some((section) => section.key === "knowledge_query")).toBe(false);
    expect(knowledgeQuery).not.toHaveBeenCalled();
  });

  it("passes active memory-retrieval relationship profile context to production knowledge grounding", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-grounding-profile-memory-"));
    const homeDir = path.join(tmpRoot, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    await upsertRelationshipProfileItem(homeDir, {
      stableKey: "user.preference.status",
      kind: "preference",
      value: "Prefer detailed status reports.",
      source: "cli_update",
      allowedScopes: ["memory_retrieval", "user_facing_review"],
      now: "2026-05-03T00:00:00.000Z",
    });
    await upsertRelationshipProfileItem(homeDir, {
      stableKey: "user.preference.status",
      kind: "preference",
      value: "Prefer concise status reports.",
      source: "cli_update",
      allowedScopes: ["memory_retrieval", "user_facing_review"],
      now: "2026-05-03T00:01:00.000Z",
    });
    const knowledgeQuery = vi.fn().mockResolvedValue({
      retrievalId: "knowledge:profile-context",
      items: [{ id: "k1", content: "Knowledge result", source: "test" }],
    });

    const gateway = createGroundingGateway({ stateManager: makeStateManager({ getBaseDir: vi.fn().mockReturnValue(homeDir) }) });
    await gateway.build({
      surface: "agent_loop",
      purpose: "task_execution",
      homeDir,
      workspaceRoot: "/repo",
      userMessage: "Find relevant memory",
      query: "Find relevant memory",
      knowledgeQuery,
    });

    expect(knowledgeQuery).toHaveBeenCalledTimes(1);
    const profileContext = knowledgeQuery.mock.calls[0]?.[0]?.relationshipProfileContext;
    expect(profileContext).toMatchObject({
      scope: "memory_retrieval",
      includeSensitive: false,
    });
    expect((profileContext?.items as Array<{ value: string }> | undefined)?.map((item) => item.value)).toEqual(["Prefer concise status reports."]);
    expect((profileContext?.items as Array<{ status: string }> | undefined)?.map((item) => item.status)).toEqual(["active"]);
    expect(knowledgeQuery.mock.calls[0]?.[0]?.relationshipProfilePromptContext).toContain(
      "Relationship profile retrieval context Surface"
    );
    expect(knowledgeQuery.mock.calls[0]?.[0]?.relationshipProfilePromptContext).not.toContain(
      "Relationship profile retrieval context (scope=memory_retrieval; include_sensitive=false)"
    );

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("attaches typed relationship profile context to prefetched knowledge grounding", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-grounding-prefetched-profile-"));
    const homeDir = path.join(tmpRoot, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    await upsertRelationshipProfileItem(homeDir, {
      stableKey: "user.preference.status",
      kind: "preference",
      value: "Prefer concise status reports.",
      source: "cli_update",
      allowedScopes: ["memory_retrieval", "user_facing_review"],
      now: "2026-05-03T00:00:00.000Z",
    });

    const gateway = createGroundingGateway({ stateManager: makeStateManager({ getBaseDir: vi.fn().mockReturnValue(homeDir) }) });
    const bundle = await gateway.build({
      surface: "agent_loop",
      purpose: "task_execution",
      homeDir,
      workspaceRoot: "/repo",
      userMessage: "Find relevant memory",
      query: "Find relevant memory",
      knowledgeContext: "Prefetched knowledge",
    });

    const knowledgeSource = bundle.traces.source.find((source) => source.sectionKey === "knowledge_query");
    const profileContext = knowledgeSource?.metadata?.["relationshipProfileContext"] as {
      itemCount?: number;
      items?: Array<{ stable_key: string; value?: string }>;
    } | undefined;
    expect(profileContext).toMatchObject({
      itemCount: 1,
      items: [expect.objectContaining({ stable_key: "user.preference.status" })],
    });
    expect(JSON.stringify(profileContext)).not.toContain("Prefer concise status reports.");
    expect(profileContext?.items?.[0]).not.toHaveProperty("value");
    const profileSurface = knowledgeSource?.metadata?.["relationshipProfileSurface"] as {
      inspection?: { included_summaries?: unknown[]; prompt_dump?: unknown };
    } | undefined;
    expect(profileSurface?.inspection?.included_summaries).toHaveLength(1);
    expect(profileSurface).not.toHaveProperty("prompt_dump");
    const knowledgeSection = bundle.dynamicSections.find((section) => section.key === "knowledge_query");
    expect(knowledgeSection?.content).toContain("Relationship profile retrieval context");
    expect(knowledgeSection?.content).toContain("Prefer concise status reports.");

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("does not let caller-supplied out-of-scope profile context bypass Surface admission", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-grounding-profile-out-of-scope-"));
    const homeDir = path.join(tmpRoot, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    const { item } = await upsertRelationshipProfileItem(homeDir, {
      stableKey: "user.preference.local-only",
      kind: "preference",
      value: "Use this only for local planning.",
      source: "cli_update",
      allowedScopes: ["local_planning"],
      now: "2026-05-03T00:00:00.000Z",
    });
    const knowledgeQuery = vi.fn().mockResolvedValue({
      retrievalId: "knowledge:profile-out-of-scope",
      items: [{ id: "k1", content: "Knowledge result", source: "test" }],
    });
    const gateway = createGroundingGateway({ stateManager: makeStateManager({ getBaseDir: vi.fn().mockReturnValue(homeDir) }) });

    const bundle = await gateway.build({
      surface: "agent_loop",
      purpose: "task_execution",
      homeDir,
      workspaceRoot: "/repo",
      userMessage: "Find relevant memory",
      query: "Find relevant memory",
      relationshipProfileContext: {
        scope: "memory_retrieval",
        includeSensitive: false,
        items: [item],
      },
      knowledgeQuery,
    });

    expect(knowledgeQuery.mock.calls[0]?.[0]?.relationshipProfileContext?.items).toEqual([]);
    expect(knowledgeQuery.mock.calls[0]?.[0]?.relationshipProfilePromptContext).toBe("");
    const knowledgeSource = bundle.traces.source.find((source) => source.sectionKey === "knowledge_query");
    const profileSurface = knowledgeSource?.metadata?.["relationshipProfileSurface"] as {
      inspection?: { excluded_summaries?: unknown[] };
    } | undefined;
    expect(profileSurface?.inspection?.excluded_summaries).toHaveLength(1);
    expect(JSON.stringify(knowledgeSource?.metadata)).not.toContain("Use this only for local planning.");
    const knowledgeSection = bundle.dynamicSections.find((section) => section.key === "knowledge_query");
    expect(knowledgeSection?.content).not.toContain("Use this only for local planning.");

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("excludes retracted and sensitive relationship profile items from lower-trust memory retrieval", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-grounding-profile-sensitive-"));
    const homeDir = path.join(tmpRoot, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    await upsertRelationshipProfileItem(homeDir, {
      stableKey: "user.preference.editor",
      kind: "preference",
      value: "Prefer VS Code.",
      source: "cli_update",
      allowedScopes: ["memory_retrieval", "user_facing_review"],
      now: "2026-05-03T00:00:00.000Z",
    });
    await retractRelationshipProfileItem(homeDir, {
      stableKey: "user.preference.editor",
      reason: "No longer current.",
      now: "2026-05-03T00:01:00.000Z",
    });
    await upsertRelationshipProfileItem(homeDir, {
      stableKey: "user.boundary.health",
      kind: "boundary",
      value: "Do not retrieve health context unless explicitly allowed.",
      source: "cli_update",
      sensitivity: "sensitive",
      allowedScopes: ["memory_retrieval", "user_facing_review"],
      now: "2026-05-03T00:02:00.000Z",
    });
    const knowledgeQuery = vi.fn().mockResolvedValue({
      retrievalId: "knowledge:profile-context",
      items: [{ id: "k1", content: "Knowledge result", source: "test" }],
    });
    const gateway = createGroundingGateway({ stateManager: makeStateManager({ getBaseDir: vi.fn().mockReturnValue(homeDir) }) });

    await gateway.build({
      surface: "agent_loop",
      purpose: "task_execution",
      homeDir,
      workspaceRoot: "/repo",
      userMessage: "Find relevant memory",
      query: "Find relevant memory",
      knowledgeQuery,
    });
    const sensitiveBundle = await gateway.build({
      surface: "agent_loop",
      purpose: "task_execution",
      homeDir,
      workspaceRoot: "/repo",
      userMessage: "Find relevant memory",
      query: "Find relevant memory",
      relationshipProfileRetrieval: { includeSensitive: true },
      knowledgeQuery,
    });

    expect(knowledgeQuery.mock.calls[0]?.[0]?.relationshipProfileContext?.items).toEqual([]);
    expect(knowledgeQuery.mock.calls[1]?.[0]?.relationshipProfileContext).toMatchObject({
      includeSensitive: true,
    });
    expect(knowledgeQuery.mock.calls[1]?.[0]?.relationshipProfileContext?.items).toEqual([]);
    const sensitiveKnowledgeSource = sensitiveBundle.traces.source.find((source) => source.sectionKey === "knowledge_query");
    const sensitiveSurface = sensitiveKnowledgeSource?.metadata?.["relationshipProfileSurface"] as {
      inspection?: { excluded_summaries?: unknown[] };
    } | undefined;
    expect(sensitiveSurface?.inspection?.excluded_summaries).toHaveLength(1);
    expect(JSON.stringify(sensitiveKnowledgeSource?.metadata)).not.toContain("Do not retrieve health context unless explicitly allowed.");

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("uses the latest active boundary and excludes sensitive boundary details in memory retrieval context", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-grounding-boundary-policy-"));
    const homeDir = path.join(tmpRoot, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    await upsertRelationshipProfileItem(homeDir, {
      stableKey: "user.boundary.notifications",
      kind: "boundary",
      value: "Notify freely.",
      source: "cli_update",
      allowedScopes: ["memory_retrieval", "user_facing_review"],
      now: "2026-05-03T00:00:00.000Z",
    });
    await upsertRelationshipProfileItem(homeDir, {
      stableKey: "user.boundary.notifications",
      kind: "boundary",
      value: "Ask before non-urgent notifications.",
      source: "user_correction",
      allowedScopes: ["memory_retrieval", "user_facing_review"],
      now: "2026-05-03T00:01:00.000Z",
    });
    await upsertRelationshipProfileItem(homeDir, {
      stableKey: "user.boundary.health",
      kind: "boundary",
      value: "Do not use health context outside explicit review.",
      source: "cli_update",
      sensitivity: "sensitive",
      allowedScopes: ["memory_retrieval", "user_facing_review"],
      now: "2026-05-03T00:02:00.000Z",
    });

    const knowledgeQuery = vi.fn().mockResolvedValue({
      retrievalId: "knowledge:profile-boundary",
      items: [{ id: "k1", content: "Knowledge result", source: "test" }],
    });
    const gateway = createGroundingGateway({ stateManager: makeStateManager({ getBaseDir: vi.fn().mockReturnValue(homeDir) }) });
    await gateway.build({
      surface: "agent_loop",
      purpose: "task_execution",
      homeDir,
      workspaceRoot: "/repo",
      userMessage: "Find relevant memory",
      query: "Find relevant memory",
      knowledgeQuery,
    });

    const profileContext = knowledgeQuery.mock.calls[0]?.[0]?.relationshipProfileContext;
    expect((profileContext?.items as Array<{ value: string }> | undefined)?.map((item) => item.value)).toEqual([
      "Ask before non-urgent notifications.",
    ]);

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("records usage for admitted SQLite Soil grounding hits and preserves usage stats in context", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-grounding-soil-"));
    const homeDir = path.join(tmpRoot, "home");
    const rootDir = path.join(homeDir, "soil");
    vi.stubEnv("OPENAI_API_KEY", "");
    const repository = await SqliteSoilRepository.create({ rootDir });
    try {
      await repository.applyMutation({
        records: [{
          record_id: "rec-grounding",
          record_key: "fact.grounding",
          version: 1,
          record_type: "fact",
          soil_id: "knowledge/grounding",
          title: "Grounding fact",
          summary: "Grounding search target",
          canonical_text: "Grounding search target comes from SQLite Soil.",
          goal_id: null,
          task_id: null,
          status: "active",
          confidence: 0.9,
          importance: 0.7,
          source_reliability: 0.8,
          valid_from: null,
          valid_to: null,
          supersedes_record_id: null,
          is_active: true,
          source_type: "test",
          source_id: "grounding-source",
          metadata_json: {},
          created_at: "2026-05-02T00:00:00.000Z",
          updated_at: "2026-05-02T00:00:00.000Z",
        }],
        chunks: [{
          chunk_id: "chunk-grounding",
          record_id: "rec-grounding",
          soil_id: "knowledge/grounding",
          chunk_index: 0,
          chunk_kind: "paragraph",
          heading_path_json: ["Knowledge"],
          chunk_text: "Grounding search target comes from SQLite Soil.",
          token_count: 7,
          checksum: "grounding-chunk",
          created_at: "2026-05-02T00:00:00.000Z",
        }],
      });
      await repository.recordOutcome(["rec-grounding"], {
        outcome: "validated",
        occurred_at: "2026-05-02T00:01:00.000Z",
      });
      await repository.recordOutcome(["rec-grounding"], {
        outcome: "negative",
        occurred_at: "2026-05-02T00:02:00.000Z",
      });
    } finally {
      repository.close();
    }

    const gateway = createGroundingGateway({ stateManager: makeStateManager() });
    const bundle = await gateway.build({
      surface: "agent_loop",
      purpose: "task_execution",
      homeDir,
      workspaceRoot: "/repo",
      userMessage: "Use the grounding search target",
      query: "Grounding search target",
      knowledgeQuery: vi.fn(),
    });
    const soilSection = bundle.dynamicSections.find((section) => section.key === "soil_knowledge");
    expect(soilSection?.content).toContain("usage used=0 validated=1 negative=1");

    const updatedRepository = await SqliteSoilRepository.create({ rootDir });
    try {
      const [record] = await updatedRepository.loadRecords({ record_ids: ["rec-grounding"] });
      expect(record?.use_count).toBe(1);
      expect(record?.last_used_at).not.toBeNull();
    } finally {
      updatedRepository.close();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("does not reuse cached identity sections across runtime homes", async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-grounding-identity-"));
    const homeA = path.join(tmpRoot, "a");
    const homeB = path.join(tmpRoot, "b");
    fs.mkdirSync(homeA, { recursive: true });
    fs.mkdirSync(homeB, { recursive: true });
    fs.writeFileSync(path.join(homeA, "SEED.md"), "# SeedA\n\nA identity.", "utf-8");
    fs.writeFileSync(path.join(homeB, "SEED.md"), "# SeedB\n\nB identity.", "utf-8");

    try {
      const gateway = createGroundingGateway({ stateManager: makeStateManager() });
      const first = await gateway.build({
        surface: "chat",
        purpose: "general_turn",
        homeDir: homeA,
      });
      const second = await gateway.build({
        surface: "chat",
        purpose: "general_turn",
        homeDir: homeB,
      });

      const firstIdentity = first.staticSections.find((section) => section.key === "identity")?.content ?? "";
      const secondIdentity = second.staticSections.find((section) => section.key === "identity")?.content ?? "";
      expect(firstIdentity).toContain("SeedA");
      expect(firstIdentity).not.toContain("SeedB");
      expect(secondIdentity).toContain("SeedB");
      expect(secondIdentity).not.toContain("SeedA");
      expect(second.metrics.cacheHits).toBe(0);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
