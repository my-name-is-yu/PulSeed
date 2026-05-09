#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const RULES = [
  {
    id: "daemon-json-state",
    owner: "DaemonStateStore / control DB daemon tables",
    pattern: /\b(?:daemon-state|shutdown-state|supervisor-state)\.json\b/,
  },
  {
    id: "runtime-queue-json",
    owner: "JournalBackedQueue SQLite queue table",
    pattern: /\b(?:runtime\/queue\.json|queue\.json)\b/,
  },
  {
    id: "plugin-channel-runtime-json",
    owner: "PluginChannelRuntimeStateStore",
    pattern: /(?:^|[\\/'"`])(?:state|health)\.json\b|\bruntime\/assets\/registry\.json\b|\bpulseed-foreign-plugin-(?:compatibility|review)\.json\b/,
  },
  {
    id: "chat-agentloop-json",
    owner: "ChatSessionDataStore / AgentLoop session DB store",
    pattern: /\b(?:chat\/sessions\/[^`'"]+\.json|chat\/agentloop\/[^`'"]+\.state\.json|traces\/agentloop\/[^`'"]+\.jsonl)\b/,
  },
  {
    id: "goal-task-json-state",
    owner: "GoalTaskStateStore",
    pattern: /\b(?:goal\.json|observations\.json|gap-history\.json|checkpoint\.json|verification-result\.json)\b/,
  },
  {
    id: "strategy-dream-json-state",
    owner: "StrategyDreamStateStore / runtime evidence DB stores",
    pattern: /\b(?:strategy-history\.json|portfolio\.json|rebalance-history\.json|importance-buffer\.jsonl|schedule-suggestions\.json|activation-artifacts\.json|watermarks\.json)\b/,
  },
  {
    id: "capability-registry-json-state",
    owner: "future typed capability registry store",
    pattern: /\bcapability_registry\.json\b/,
  },
];

const PATH_ALLOWLIST = [
  { pattern: /(^|\/)__tests__\//, reason: "tests may contain legacy fixtures and assertions" },
  { pattern: /(^|\/)tests\//, reason: "tests may contain legacy fixtures and assertions" },
  { pattern: /(^|\/)docs\//, reason: "docs are not runtime code" },
  { pattern: /(^|\/)tmp\//, reason: "tmp status and audit artifacts are not runtime code" },
  { pattern: /(^|\/)scripts\/goal-canary-supervisor\.mjs$/, reason: "dogfood debug export artifact collector" },
  { pattern: /(^|\/)scripts\/check-database-first-legacy-stores\.mjs$/, reason: "this check contains legacy filename rules" },
  { pattern: /(^|\/)src\/runtime\/store\/.*migration\.ts$/, reason: "explicit doctor/migrate import boundary" },
  { pattern: /(^|\/)src\/interface\/chat\/chat-agentloop-state-migration\.ts$/, reason: "explicit chat migration boundary" },
  { pattern: /(^|\/)src\/runtime\/schedule\/legacy-cron-migration\.ts$/, reason: "explicit schedule migration boundary" },
  { pattern: /(^|\/)src\/interface\/cli\/commands\/doctor\.ts$/, reason: "doctor is the compatibility boundary" },
  { pattern: /(^|\/)src\/base\/state\/state-manager\.ts$/, reason: "temporary compatibility facade over typed stores" },
  { pattern: /(^|\/)src\/base\/state\/state-manager-goal-state\.ts$/, reason: "temporary StateManager compatibility facade over typed goal/task stores" },
  { pattern: /(^|\/)src\/base\/state\/state-manager-wal\.ts$/, reason: "known follow-up goal WAL compatibility surface" },
  { pattern: /(^|\/)src\/interface\/chat\/chat-runner-state\.ts$/, reason: "known follow-up archived goal compatibility surface" },
  { pattern: /(^|\/)src\/platform\/knowledge\/knowledge-manager\.ts$/, reason: "documents compatibility facade only" },
  { pattern: /(^|\/)src\/orchestrator\/execution\/agent-loop\/agent-loop-session-factory\.ts$/, reason: "known follow-up path-shaped AgentLoop resume surface" },
  { pattern: /(^|\/)src\/orchestrator\/execution\/task\/task-lifecycle-runner\.ts$/, reason: "known follow-up StateManager logical-path compatibility caller" },
  { pattern: /(^|\/)src\/orchestrator\/execution\/task\/task-verifier(?:-rules)?\.ts$/, reason: "known follow-up StateManager logical-path compatibility caller" },
  { pattern: /(^|\/)src\/orchestrator\/loop\/checkpoint-manager-loop\.ts$/, reason: "known follow-up StateManager logical-path compatibility caller" },
  { pattern: /(^|\/)src\/orchestrator\/strategy\/portfolio-manager\.ts$/, reason: "known follow-up strategy/capability state surface" },
  { pattern: /(^|\/)src\/orchestrator\/strategy\/strategy-manager(?:-base)?\.ts$/, reason: "known follow-up strategy state surface" },
  { pattern: /(^|\/)src\/platform\/dream\/dream-consolidator(?:\/fs-metrics)?\.ts$/, reason: "known follow-up dream file metrics surface" },
  { pattern: /(^|\/)src\/platform\/knowledge\/memory\/memory-persistence\.ts$/, reason: "known follow-up memory compatibility map" },
  { pattern: /(^|\/)src\/platform\/soil\/importer\.ts$/, reason: "Soil import overlay queue is outside normal runtime state ownership" },
  { pattern: /(^|\/)src\/runtime\/foreign-plugins\/compatibility\.ts$/, reason: "legacy filename constants for migration/debug references" },
  { pattern: /(^|\/)src\/runtime\/daemon\/runner-(?:bootstrap|recovery|startup)\.ts$/, reason: "known follow-up daemon compatibility surface" },
  { pattern: /(^|\/)src\/runtime\/daemon\/wait-deadline-resolver\.ts$/, reason: "known follow-up strategy wait metadata compatibility caller" },
  { pattern: /(^|\/)src\/runtime\/store\/goal-task-state-store\.ts$/, reason: "typed store logical-path compatibility parser" },
  { pattern: /(^|\/)src\/runtime\/store\/strategy-dream-state-store\.ts$/, reason: "typed store logical-path compatibility parser" },
  { pattern: /(^|\/)src\/platform\/soil\/publish\/config\.ts$/, reason: "Soil publish state is an explicit publish artifact" },
  { pattern: /(^|\/)src\/platform\/traits\/curiosity-engine\.ts$/, reason: "known follow-up internal state surface" },
  { pattern: /(^|\/)src\/platform\/observation\/capability-registry\.ts$/, reason: "known follow-up internal state surface" },
  { pattern: /(^|\/)src\/runtime\/executor\/loop-supervisor\.ts$/, reason: "known follow-up legacy supervisor surface" },
  { pattern: /(^|\/)src\/platform\/knowledge\/transfer\/knowledge-transfer-types\.ts$/, reason: "StateManager compatibility facade call site" },
];

const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "coverage", ".pulseed-sandbox"]);

export function scanText(filePath, text) {
  const normalizedPath = normalizePath(filePath);
  const allow = PATH_ALLOWLIST.find((entry) => entry.pattern.test(normalizedPath));
  if (allow) return [];
  const findings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.pattern.test(line) && !isConfigAllowed(line)) {
        findings.push({
          filePath: normalizedPath,
          line: index + 1,
          rule: rule.id,
          owner: rule.owner,
          text: line.trim(),
        });
      }
    }
  });
  return findings;
}

export function scanFiles(roots) {
  const findings = [];
  for (const root of roots) {
    const absoluteRoot = path.resolve(repoRoot, root);
    for (const filePath of walkFiles(absoluteRoot)) {
      findings.push(...scanText(path.relative(repoRoot, filePath), fs.readFileSync(filePath, "utf8")));
    }
  }
  return findings;
}

function isConfigAllowed(line) {
  return /\b(?:provider|notification|daemon|config|plugin|package|tsconfig)\.json\b/.test(line)
    || /\bplugin\.ya?ml\b/.test(line)
    || /\bgateway\/channels\/[^`'"]+\/config\.json\b/.test(line);
}

function* walkFiles(root) {
  if (!fs.existsSync(root)) return;
  const stat = fs.statSync(root);
  if (stat.isFile()) {
    if (EXTENSIONS.has(path.extname(root))) yield root;
    return;
  }
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(entryPath);
    } else if (entry.isFile() && EXTENSIONS.has(path.extname(entry.name))) {
      yield entryPath;
    }
  }
}

function normalizePath(filePath) {
  return filePath.split(path.sep).join("/");
}

function main() {
  const roots = process.argv.slice(2);
  const findings = scanFiles(roots.length > 0 ? roots : ["src", "scripts"]);
  if (findings.length === 0) {
    console.log("database-first legacy store check passed");
    return;
  }
  console.error("database-first legacy store check failed:");
  for (const finding of findings) {
    console.error(`${finding.filePath}:${finding.line} [${finding.rule}] ${finding.owner}`);
    console.error(`  ${finding.text}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
