import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SearchOrchestrator } from "../orchestrator.js";
import { ProgressiveReader } from "../progressive-reader.js";
import { buildFileIndex } from "../indexes/file-index.js";
import { getCodeSearchIndexes } from "../indexes/index-store.js";
import { parseVerificationSignal } from "../verification-retrieval.js";

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
