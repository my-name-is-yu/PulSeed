import * as path from "node:path";
import type { CodeSearchTask, Intent, SearchBudget, SearchRequest, StackFrame, VerificationSignal } from "./contracts.js";

const DEFAULT_BUDGET: SearchBudget = {
  maxFiles: 1_500,
  maxCandidatesPerRetriever: 100,
  maxFusionCandidates: 400,
  maxRerankCandidates: 200,
};

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "into", "when", "then", "have",
  "has", "was", "were", "are", "can", "will", "should", "must", "not", "but", "fix",
  "add", "use", "using", "make", "して", "する", "これ", "実装", "修正",
]);

const PATH_RE = /(?:^|[\s"'`(])((?:\.{1,2}\/)?[\w@./-]+\.(?:ts|tsx|js|jsx|json|md|yaml|yml|mjs|cjs))/g;
const STACK_FRAME_RE = /(?:at\s+(?<symbol>[^\s(]+)\s+\()?((?<file>(?:\/|\.{1,2}\/)?[\w@./-]+\.(?:ts|tsx|js|jsx|mjs|cjs))):(?<line>\d+):(?<column>\d+)/g;

function inferIntent(task: string, explicit?: Intent): Intent {
  if (explicit) return explicit;
  const lower = task.toLowerCase();
  if (/security|ssrf|xss|attack|攻撃|セキュリティ/.test(lower)) return "security_review";
  if (/test|spec|assert|failure|failing|失敗/.test(lower)) return "test_failure";
  if (/refactor|cleanup|整理|債務/.test(lower)) return "refactor";
  if (/config|tsconfig|eslint|package|設定/.test(lower)) return "config_fix";
  if (/explain|どう|なぜ|説明/.test(lower)) return "explain";
  if (/api|schema|route|contract/.test(lower)) return "api_change";
  if (/bug|fix|error|例外|壊/.test(lower)) return "bugfix";
  if (/add|implement|feature|実装|追加/.test(lower)) return "feature_addition";
  return "unknown";
}

function extractLikelyPaths(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(PATH_RE)) {
    paths.push(match[1]);
  }
  return [...new Set(paths.map((candidate) => candidate.replace(/^[\s"'`(]+/, "")))];
}

function extractStackFrames(text: string): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const match of text.matchAll(STACK_FRAME_RE)) {
    const groups = match.groups;
    if (!groups?.file) continue;
    frames.push({
      file: groups.file,
      line: groups.line ? Number(groups.line) : undefined,
      column: groups.column ? Number(groups.column) : undefined,
      symbol: groups.symbol,
    });
  }
  return frames;
}

function extractTerms(text: string): string[] {
  const raw = text
    .split(/[^A-Za-z0-9_$#./-]+/)
    .map((term) => term.trim())
    .filter((term) => term.length >= 3 && !STOPWORDS.has(term.toLowerCase()));
  return [...new Set(raw)].slice(0, 40);
}

function extractSymbols(terms: string[]): string[] {
  return terms
    .filter((term) => /^[A-Z_$][A-Za-z0-9_$]*$/.test(term) || /^[a-z_$][A-Za-z0-9_$]*[A-Z][A-Za-z0-9_$]*$/.test(term))
    .slice(0, 30);
}

export function planCodeSearchTask(task: CodeSearchTask): SearchRequest {
  const combined = [task.task, task.stacktrace ?? "", ...(task.queryTerms ?? [])].join("\n");
  const queryTerms = [...new Set([...(task.queryTerms ?? []), ...extractTerms(combined)])].slice(0, 50);
  const stackFrames = extractStackFrames(combined);
  return {
    task: task.task,
    intent: inferIntent(task.task, task.intent),
    queryTerms,
    stacktrace: task.stacktrace ?? "",
    fileGlobs: task.fileGlobs ?? [],
    packageScope: task.packageScope ?? "",
    cwd: path.resolve(task.cwd ?? process.cwd()),
    likelySymbols: extractSymbols(queryTerms),
    likelyPaths: extractLikelyPaths(combined),
    stackFrames,
    budget: { ...DEFAULT_BUDGET, ...(task.budget ?? {}) },
  };
}

export function taskFromVerificationSignal(signal: VerificationSignal, priorTask: CodeSearchTask): CodeSearchTask {
  switch (signal.kind) {
    case "undefined_symbol":
      return { ...priorTask, intent: "bugfix", task: `${priorTask.task}\nResolve undefined symbol ${signal.symbol}`, queryTerms: [signal.symbol, ...(priorTask.queryTerms ?? [])] };
    case "type_error":
      return { ...priorTask, intent: "test_failure", task: `${priorTask.task}\nType error ${signal.typeName ?? ""} ${signal.file ?? ""}`, queryTerms: [signal.typeName, signal.file].filter(Boolean) as string[] };
    case "failing_test":
      return { ...priorTask, intent: "test_failure", task: `${priorTask.task}\nFailing test ${signal.testName ?? ""} ${signal.assertion ?? ""}`, queryTerms: [signal.testFile, signal.testName, signal.assertion].filter(Boolean) as string[] };
    case "runtime_stacktrace":
      return { ...priorTask, intent: "bugfix", stacktrace: signal.stacktrace, task: `${priorTask.task}\nRuntime stacktrace:\n${signal.stacktrace}` };
    case "lint_error":
      return { ...priorTask, intent: "config_fix", task: `${priorTask.task}\nLint error ${signal.rule ?? ""} ${signal.file ?? ""}`, queryTerms: [signal.rule, signal.file].filter(Boolean) as string[] };
    case "package_import_error":
      return { ...priorTask, intent: "config_fix", task: `${priorTask.task}\nPackage import error ${signal.specifier ?? ""} ${signal.packageName ?? ""}`, queryTerms: [signal.specifier, signal.packageName].filter(Boolean) as string[] };
    case "generated_file_selected":
      return { ...priorTask, task: `${priorTask.task}\nFind source owner for generated file ${signal.file}`, queryTerms: [signal.file, "source", "template", "schema"] };
  }
}
