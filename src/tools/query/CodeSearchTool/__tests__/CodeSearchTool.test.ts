import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConcurrencyController } from "../../../concurrency.js";
import { ToolExecutor } from "../../../executor.js";
import { toToolDefinition } from "../../../tool-definition-adapter.js";
import { ToolPermissionManager } from "../../../permission.js";
import { ToolRegistry } from "../../../registry.js";
import { clearCodeSearchSessionsForTests } from "../../../../platform/code-search/session-store.js";
import { CodeReadContextInputSchema, CodeReadContextTool } from "../../CodeReadContextTool/CodeReadContextTool.js";
import { CodeSearchRepairTool } from "../../CodeSearchRepairTool/CodeSearchRepairTool.js";
import { CodeSearchInputSchema, CodeSearchTool } from "../CodeSearchTool.js";
import { MAX_OUTPUT_CHARS } from "../constants.js";
import { MAX_OUTPUT_CHARS as READ_CONTEXT_MAX_OUTPUT_CHARS } from "../../CodeReadContextTool/constants.js";
import type { ToolCallContext } from "../../../types.js";

describe("code search tools", () => {
  let root: string;
  let context: ToolCallContext;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-code-search-tool-"));
    await fsp.mkdir(path.join(root, "src"), { recursive: true });
    await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture" }));
    await fsp.writeFile(path.join(root, "src", "alpha.ts"), "export function alphaValue() { return 1; }\n");
    context = {
      cwd: root,
      goalId: "goal-1",
      trustBalance: 0,
      preApproved: true,
      approvalFn: async () => true,
    };
  });

  function makeFullCandidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: "candidate-1",
      file: "src/alpha.ts",
      range: { startLine: 1, endLine: 1, startByte: 0, endByte: 41 },
      preview: "export function alphaValue() { return 1; }",
      signals: { lexicalMatch: 1 },
      ranks: { retrieverRanks: { lexical: 1 }, finalRank: 1 },
      penalties: { generated: 0 },
      reasons: ["fixture"],
      sourceRetrievers: ["lexical"],
      indexVersion: "test",
      indexedAt: Date.parse("2026-05-09T00:00:00.000Z"),
      fileHashAtIndex: "hash",
      rrfScore: 0.5,
      rerankScore: 1,
      confidence: "high",
      readRecommendation: "read_now",
      ...overrides,
    };
  }

  afterEach(async () => {
    clearCodeSearchSessionsForTests();
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("bounds code_search budget overrides at runtime and in exported schemas", () => {
    expect(CodeSearchInputSchema.safeParse({
      task: "find alphaValue",
      budget: {
        maxFiles: 5_000,
        maxCandidatesPerRetriever: 500,
        maxFusionCandidates: 1_000,
        maxRerankCandidates: 500,
      },
    }).success).toBe(true);

    for (const budget of [
      { maxFiles: 0 },
      { maxFiles: 5_001 },
      { maxFiles: 9007199254740993 },
      { maxCandidatesPerRetriever: 501 },
      { maxFusionCandidates: 1_001 },
      { maxRerankCandidates: 501 },
    ]) {
      expect(CodeSearchInputSchema.safeParse({ task: "find alphaValue", budget }).success).toBe(false);
    }

    const parameters = toToolDefinition(new CodeSearchTool()).function.parameters as {
      properties?: { budget?: { properties?: Record<string, unknown> } };
    };
    expect(parameters.properties?.budget?.properties?.maxFiles).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 5_000,
    });
    expect(parameters.properties?.budget?.properties?.maxCandidatesPerRetriever).toMatchObject({
      type: "integer",
      maximum: 500,
    });
    expect(parameters.properties?.budget?.properties?.maxFusionCandidates).toMatchObject({
      type: "integer",
      maximum: 1_000,
    });
    expect(parameters.properties?.budget?.properties?.maxRerankCandidates).toMatchObject({
      type: "integer",
      maximum: 500,
    });
  });

  it("bounds code_read_context read controls at runtime and in exported schemas", () => {
    expect(CodeReadContextInputSchema.safeParse({
      maxReadRanges: 50,
      maxReadTokens: 20_000,
    }).success).toBe(true);

    for (const input of [
      { maxReadRanges: 0 },
      { maxReadRanges: 51 },
      { maxReadRanges: 9007199254740993 },
      { maxReadTokens: 0 },
      { maxReadTokens: 20_001 },
      { maxReadTokens: 9007199254740993 },
    ]) {
      expect(CodeReadContextInputSchema.safeParse(input).success).toBe(false);
    }

    const parameters = toToolDefinition(new CodeReadContextTool()).function.parameters as {
      properties?: Record<string, unknown>;
    };
    expect(parameters.properties?.maxReadRanges).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 50,
    });
    expect(parameters.properties?.maxReadTokens).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: 20_000,
    });
  });

  it("rejects unsafe full candidate numeric fields at runtime and in exported schemas", async () => {
    expect(CodeReadContextInputSchema.safeParse({
      candidates: [makeFullCandidate()],
      maxReadRanges: 1,
    }).success).toBe(true);

    for (const candidate of [
      makeFullCandidate({ range: { startLine: Infinity, endLine: 1 } }),
      makeFullCandidate({ range: { startLine: 3, endLine: 2 } }),
      makeFullCandidate({ range: { startLine: 1, endLine: 1, startByte: Number.MAX_SAFE_INTEGER + 1 } }),
      makeFullCandidate({ signals: { lexicalMatch: Infinity } }),
      makeFullCandidate({ ranks: { retrieverRanks: { lexical: 1.5 } } }),
      makeFullCandidate({ indexedAt: Number.MAX_SAFE_INTEGER + 1 }),
      makeFullCandidate({ rrfScore: Infinity }),
    ]) {
      expect(CodeReadContextInputSchema.safeParse({ candidates: [candidate] }).success).toBe(false);
    }

    const registry = new ToolRegistry();
    registry.register(new CodeReadContextTool());
    const executor = new ToolExecutor({
      registry,
      permissionManager: new ToolPermissionManager({}),
      concurrency: new ConcurrencyController(),
    });
    const result = await executor.execute("code_read_context", {
      candidates: [
        makeFullCandidate({ range: { startLine: Infinity, endLine: 1 } }),
      ],
    }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain("Input validation failed");
    expect(result.error).toContain("candidates.0.range.startLine");

    const parameters = toToolDefinition(new CodeReadContextTool()).function.parameters as {
      properties?: {
        candidates?: {
          items?: {
            properties?: {
              range?: { properties?: Record<string, unknown> };
              ranks?: { properties?: { retrieverRanks?: { additionalProperties?: unknown } } };
            };
          };
        };
      };
    };
    expect(parameters.properties?.candidates?.items?.properties?.range?.properties?.startLine).toMatchObject({
      type: "integer",
      minimum: 1,
      maximum: Number.MAX_SAFE_INTEGER,
    });
    expect(parameters.properties?.candidates?.items?.properties?.range?.properties?.startByte).toMatchObject({
      type: "integer",
      minimum: 0,
      maximum: Number.MAX_SAFE_INTEGER,
    });
    const retrieverRankSchema = parameters.properties
      ?.candidates?.items?.properties?.ranks?.properties?.retrieverRanks?.additionalProperties as Record<string, unknown> | undefined;
    if (retrieverRankSchema && "$ref" in retrieverRankSchema) {
      expect(retrieverRankSchema).toEqual({
        $ref: "#/properties/candidates/items/properties/range/properties/startLine",
      });
    } else {
      expect(retrieverRankSchema).toMatchObject({
        type: "integer",
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
      });
    }
  });

  it("code_search and code_read_context provide structured context through queryId handles", async () => {
    const search = await new CodeSearchTool().call({ task: "find alphaValue", intent: "explain" }, context);
    expect(search.success).toBe(true);
    const data = search.data as { queryId: string; candidateIds: string[]; candidates: Array<{ id: string; file: string }> };
    expect(data.candidates.length).toBeGreaterThan(0);
    expect(JSON.stringify(data.candidates[0])).not.toContain("signals");

    const read = await new CodeReadContextTool().call({
      candidates: [],
      queryId: data.queryId,
      candidateIds: data.candidateIds.slice(0, 1),
      phase: "locate",
      maxReadRanges: 1,
    }, context);
    expect(read.success).toBe(true);
    expect(JSON.stringify(read.data)).toContain("alphaValue");
  });

  it("keeps ToolExecutor output below truncation while code_read_context resolves full candidates by queryId", async () => {
    for (let i = 0; i < 120; i += 1) {
      await fsp.writeFile(path.join(root, "src", `alpha-${i}.ts`), `export function alphaValue${i}() { return ${i}; }\n`);
    }
    const registry = new ToolRegistry();
    registry.register(new CodeSearchTool());
    registry.register(new CodeReadContextTool());
    const executor = new ToolExecutor({
      registry,
      permissionManager: new ToolPermissionManager({}),
      concurrency: new ConcurrencyController(),
    });

    const search = await executor.execute("code_search", {
      task: "find alphaValue route selection",
      intent: "explain",
      queryTerms: ["alphaValue"],
      outputLimit: 40,
    }, context);

    expect(search.success).toBe(true);
    expect(search.truncated).toBeUndefined();
    expect(typeof search.data).toBe("object");
    expect(JSON.stringify(search.data).length).toBeLessThan(MAX_OUTPUT_CHARS);
    const data = search.data as { queryId: string; candidateIds: string[]; totalCandidates: number };
    expect(data.totalCandidates).toBeGreaterThan(40);

    const read = await executor.execute("code_read_context", {
      queryId: data.queryId,
      candidateIds: data.candidateIds.slice(0, 2),
      phase: "locate",
      maxReadRanges: 2,
    }, context);
    expect(read.success).toBe(true);
    expect(read.truncated).toBeUndefined();
    expect(JSON.stringify(read.data).length).toBeLessThan(READ_CONTEXT_MAX_OUTPUT_CHARS);
    expect(JSON.stringify(read.data)).toContain("alphaValue");
  });

  it("uses the saved search root for queryId reads from scoped paths", async () => {
    await fsp.mkdir(path.join(root, "pkg", "src"), { recursive: true });
    await fsp.writeFile(path.join(root, "pkg", "src", "alpha.ts"), "export function scopedAlphaValue() { return 2; }\n");
    const registry = new ToolRegistry();
    registry.register(new CodeSearchTool());
    registry.register(new CodeReadContextTool());
    const executor = new ToolExecutor({
      registry,
      permissionManager: new ToolPermissionManager({}),
      concurrency: new ConcurrencyController(),
    });

    const search = await executor.execute("code_search", {
      task: "find scopedAlphaValue",
      intent: "explain",
      path: "pkg",
    }, context);
    expect(search.success).toBe(true);
    const data = search.data as { queryId: string; candidateIds: string[] };

    const read = await executor.execute("code_read_context", {
      queryId: data.queryId,
      candidateIds: data.candidateIds.slice(0, 1),
      phase: "locate",
      maxReadRanges: 1,
    }, context);

    expect(read.success).toBe(true);
    expect(JSON.stringify(read.data)).toContain("scopedAlphaValue");
    expect((read.data as { ranges: Array<{ file: string }> }).ranges[0].file).toBe("src/alpha.ts");
  });

  it("refuses to default-search the home directory", async () => {
    const result = await new CodeSearchTool().call(
      { task: "find alphaValue", intent: "explain" },
      { ...context, cwd: os.homedir() },
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("refused broad root");
  });

  it("refuses explicit broad paths before permission approval can allow them", async () => {
    const tool = new CodeSearchTool();
    const permission = await tool.checkPermissions(
      { task: "find alphaValue", intent: "explain", path: os.homedir() },
      context,
    );
    expect(permission).toMatchObject({ status: "denied" });

    const registry = new ToolRegistry();
    registry.register(tool);
    const executor = new ToolExecutor({
      registry,
      permissionManager: new ToolPermissionManager({}),
      concurrency: new ConcurrencyController(),
    });

    const result = await executor.execute("code_search", {
      task: "find alphaValue",
      intent: "explain",
      path: os.homedir(),
    }, context);

    expect(result.success).toBe(false);
    expect(result.error).toContain("refused broad explicit path");
  });

  it("allows searching the active workspace when self-protection protects the workspace root", async () => {
    const tool = new CodeSearchTool();
    const permission = await tool.checkPermissions(
      { task: "find alphaValue", intent: "explain", path: root },
      {
        ...context,
        executionPolicy: {
          executionProfile: "consumer",
          sandboxMode: "workspace_write",
          approvalPolicy: "on_request",
          networkAccess: false,
          workspaceRoot: root,
          protectedPaths: [root],
          trustProjectInstructions: true,
        },
      },
    );

    expect(permission.status).toBe("allowed");
  });

  it("defaults nested package searches to the project root", async () => {
    const nested = path.join(root, "src");
    const result = await new CodeSearchTool().call(
      { task: "find alphaValue", intent: "explain" },
      { ...context, cwd: nested },
    );

    expect(result.success).toBe(true);
    const data = result.data as { candidates: Array<{ file: string }> };
    expect(data.candidates[0]?.file).toBe("src/alpha.ts");
  });

  it("code_search_repair parses verification output and suggests candidates", async () => {
    const result = await new CodeSearchRepairTool().call({
      priorTask: { task: "fix alphaValue", intent: "bugfix" },
      verificationOutput: "ReferenceError: alphaValue is not defined\n    at src/alpha.ts:1:1",
    }, context);

    expect(result.success).toBe(true);
    expect((result.data as { signal: { kind: string }; candidates: unknown[] }).signal.kind).toBe("undefined_symbol");
    expect((result.data as { candidates: unknown[] }).candidates.length).toBeGreaterThan(0);
  });

  it("code_search_repair refuses broad explicit and implicit roots through the executor", async () => {
    const repair = new CodeSearchRepairTool();
    const permission = await repair.checkPermissions({
      priorTask: { task: "fix alphaValue", intent: "bugfix" },
      verificationOutput: "ReferenceError: alphaValue is not defined\n    at src/alpha.ts:1:1",
      path: os.homedir(),
    }, context);
    expect(permission).toMatchObject({ status: "denied" });

    const registry = new ToolRegistry();
    registry.register(repair);
    const executor = new ToolExecutor({
      registry,
      permissionManager: new ToolPermissionManager({}),
      concurrency: new ConcurrencyController(),
    });

    const explicit = await executor.execute("code_search_repair", {
      priorTask: { task: "fix alphaValue", intent: "bugfix" },
      verificationOutput: "ReferenceError: alphaValue is not defined\n    at src/alpha.ts:1:1",
      path: os.homedir(),
    }, context);
    expect(explicit.success).toBe(false);
    expect(explicit.error).toContain("refused broad explicit path");

    const implicit = await repair.call({
      priorTask: { task: "fix alphaValue", intent: "bugfix" },
      verificationOutput: "ReferenceError: alphaValue is not defined\n    at src/alpha.ts:1:1",
    }, { ...context, cwd: os.homedir() });
    expect(implicit.success).toBe(false);
    expect(implicit.error).toContain("refused broad root");
  });
});
