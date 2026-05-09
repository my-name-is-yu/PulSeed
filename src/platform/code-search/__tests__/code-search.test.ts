import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SearchOrchestrator } from "../orchestrator.js";
import { ProgressiveReader } from "../progressive-reader.js";
import { rerankCandidates } from "../reranker.js";
import { normalizeCandidates } from "../candidate-normalizer.js";
import { buildFileIndex } from "../indexes/file-index.js";
import { getCodeSearchIndexes } from "../indexes/index-store.js";
import { planCodeSearchTask } from "../query-planner.js";
import { parseVerificationSignal } from "../verification-retrieval.js";
import type { FusedCandidate } from "../fusion.js";
import { DEFAULT_CANDIDATE_PENALTIES, DEFAULT_CANDIDATE_SIGNALS, type CodeCandidate } from "../contracts.js";

describe("code search platform", () => {
  let root: string;

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-code-search-"));
    await fsp.mkdir(path.join(root, "src", "__tests__"), { recursive: true });
    await fsp.mkdir(path.join(root, "dist"), { recursive: true });
    await fsp.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", dependencies: { zod: "^3.0.0" } }));
    await fsp.writeFile(path.join(root, "src", "service.ts"), [
      "export interface SearchRequest { term: string }",
      "export function findWidget(req: SearchRequest): string {",
      "  return `widget:${req.term}`;",
      "}",
    ].join("\n"));
    await fsp.writeFile(path.join(root, "src", "__tests__", "service.test.ts"), [
      "import { findWidget } from '../service.js';",
      "describe('findWidget', () => {",
      "  it('returns a widget label', () => {",
      "    expect(findWidget({ term: 'a' })).toBe('widget:a');",
      "  });",
      "});",
    ].join("\n"));
    await fsp.writeFile(path.join(root, "dist", "service.generated.js"), "export function findWidget() {}\n");
  });

  afterEach(async () => {
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("returns ranked symbol and related test candidates instead of raw grep text", async () => {
    const candidates = await new SearchOrchestrator(root).search({
      task: "fix findWidget behavior and related tests",
      intent: "bugfix",
      cwd: root,
    });

    expect(candidates.some((candidate) => candidate.file === "src/service.ts" && candidate.symbol?.name === "findWidget")).toBe(true);
    expect(candidates.some((candidate) => candidate.file.includes("service.test.ts"))).toBe(true);
    expect(candidates[0]).toHaveProperty("reasons");
    expect(candidates[0]).toHaveProperty("signals");
    expect(candidates[0]).toHaveProperty("penalties");
  });

  it("does not advertise semantic retrieval when no embedding-backed index is configured", async () => {
    const result = await new SearchOrchestrator(root).searchWithState({
      task: "explain findWidget",
      intent: "explain",
      cwd: root,
    });

    expect(result.trace.retrieversUsed).not.toContain("semantic");
    expect(result.trace.candidatesReturnedByRetriever).not.toHaveProperty("semantic");
    expect(result.trace.warnings).toContain("semantic retrieval disabled: no embedding-backed code-search index configured");
    expect(result.candidates.every((candidate) => !candidate.reasons.some((reason) => reason.includes("semantic")))).toBe(true);
  });

  it("ignores semantic similarity during reranking when semantic retrieval is disabled", () => {
    const makeCandidate = (id: string, lexicalMatch: number, semanticSimilarity: number): FusedCandidate => ({
      id,
      file: `src/${id}.ts`,
      range: { startLine: 1, endLine: 1 },
      preview: id,
      signals: {
        ...DEFAULT_CANDIDATE_SIGNALS,
        lexicalMatch,
        semanticSimilarity,
      },
      ranks: { retrieverRanks: { lexical: 1 } },
      penalties: DEFAULT_CANDIDATE_PENALTIES,
      reasons: [],
      sourceRetrievers: ["lexical"],
      indexVersion: "test",
      indexedAt: 1,
      fileHashAtIndex: id,
      rrfScore: 0,
    });
    const candidates = [
      makeCandidate("lexical", 1, 0),
      makeCandidate("semantic-only", 0, 1),
    ];

    const ranked = rerankCandidates(candidates, "explain", 2, { semanticRetrieval: "disabled" });

    expect(ranked.map((candidate) => candidate.id)).toEqual(["lexical", "semantic-only"]);
    expect(ranked[1]!.rerankScore).toBe(0);
  });

  it("does not synthesize invalid byte offsets when merging candidates without byte offsets", () => {
    const makeCandidate = (id: string, startLine: number, endLine: number): CodeCandidate => ({
      id,
      file: "src/service.ts",
      range: { startLine, endLine },
      preview: id,
      signals: DEFAULT_CANDIDATE_SIGNALS,
      ranks: { retrieverRanks: { lexical: 1 } },
      penalties: DEFAULT_CANDIDATE_PENALTIES,
      reasons: [id],
      sourceRetrievers: ["lexical"],
      indexVersion: "test",
      indexedAt: 1,
      fileHashAtIndex: id,
    });

    const [merged] = normalizeCandidates([
      makeCandidate("first", 1, 2),
      makeCandidate("second", 3, 4),
    ]);

    expect(merged).toBeDefined();
    expect(merged!.range).toEqual({ startLine: 1, endLine: 4 });
  });

  it("reads bounded context ranges with budget and trace state", async () => {
    const candidates = await new SearchOrchestrator(root).search({
      task: "explain findWidget",
      intent: "explain",
      cwd: root,
    });
    const indexes = await getCodeSearchIndexes(root);
    const bundle = await new ProgressiveReader(root, indexes).read(candidates, {
      phase: "understand",
      maxReadRanges: 2,
      maxReadTokens: 2000,
    });

    expect(bundle.ranges.length).toBeGreaterThan(0);
    expect(bundle.ranges[0].content).toContain("findWidget");
    expect(bundle.state.budget.usedReadRanges).toBe(bundle.ranges.length);
    expect(bundle.trace.readCandidates).toEqual(bundle.ranges.map((range) => range.candidateId));
  });

  it("turns verification output into a repair search", async () => {
    const signal = parseVerificationSignal("src/service.ts:2:10 - error TS2304: Cannot find name 'MissingType'.");
    expect(signal.kind).toBe("undefined_symbol");

    const orchestrator = new SearchOrchestrator(root);
    const prior = await orchestrator.searchWithState({ task: "fix service type error", intent: "test_failure", cwd: root });
    const candidates = await orchestrator.searchFromVerification(signal, prior);

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.some((candidate) => candidate.reasons.some((reason) => reason.includes("verification:")))).toBe(true);
  });

  it("does not classify freeform task intent from keywords without caller intent", () => {
    const planned = planCodeSearchTask({
      task: "Investigate and add explanatory comments to security-ish config names",
      cwd: root,
    });

    expect(planned.intent).toBe("unknown");
    expect(planned.task).toContain("security-ish");
  });

  it("keeps unsafe stacktrace positions out of structured code-search context", () => {
    const planned = planCodeSearchTask({
      task: "fix rounded stacktrace position",
      stacktrace: "at run (src/service.ts:9007199254740993:12)",
      cwd: root,
    });

    expect(planned.stackFrames).toEqual([{
      file: "src/service.ts",
      line: undefined,
      column: 12,
      symbol: "run",
    }]);
  });

  it("keeps unsafe verification line positions out of structured diagnostics", () => {
    const signal = parseVerificationSignal(
      "src/service.ts:9007199254740993:10 - error TS2322: Type 'string' is not assignable to type 'number'."
    );

    expect(signal).toMatchObject({
      kind: "type_error",
      file: "src/service.ts",
      line: undefined,
    });
  });

  it("excludes hidden worktree directories before applying the file cap", async () => {
    await fsp.mkdir(path.join(root, ".claude", "worktrees", "old", "src"), { recursive: true });
    for (let i = 0; i < 40; i += 1) {
      await fsp.writeFile(path.join(root, ".claude", "worktrees", "old", "src", `stale-${i}.ts`), `export const stale${i} = ${i};\n`);
    }

    const files = await buildFileIndex(root, 10);

    expect(files.some((file) => file.path.startsWith(".claude/"))).toBe(false);
    expect(files.some((file) => file.path === "src/service.ts")).toBe(true);
  });

  it("excludes build-output prefixes before indexing declaration artifacts", async () => {
    await fsp.mkdir(path.join(root, "dist-tui-test", "interface", "tui"), { recursive: true });
    await fsp.mkdir(path.join(root, "coverage-c8", "src"), { recursive: true });
    await fsp.writeFile(path.join(root, "dist-tui-test", "interface", "tui", "chat.d.ts"), "export declare const staleChat: string;\n");
    await fsp.writeFile(path.join(root, "coverage-c8", "src", "chat.ts"), "export const staleCoverage = true;\n");

    const files = await buildFileIndex(root, 50);

    expect(files.some((file) => file.path.startsWith("dist-tui-test/"))).toBe(false);
    expect(files.some((file) => file.path.startsWith("coverage-c8/"))).toBe(false);
    expect(files.some((file) => file.path === "src/service.ts")).toBe(true);
  });
});
