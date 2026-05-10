#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const CATEGORY = Object.freeze({
  MIGRATE_NOW: "migrate now",
  MIGRATION_ONLY_INPUT: "migration-only input",
  DEBUG_EXPORT_OUTPUT: "debug/export output",
  CONFIG_SECRET: "config/secret",
  WORKSPACE_USER_ARTIFACT: "workspace/user artifact",
  SOIL_IMPORT_PUBLISH_ARTIFACT: "Soil import/publish artifact",
  PRODUCT_DECISION_NEEDED: "product decision needed",
});

const CLASSIFICATIONS = new Set(Object.values(CATEGORY));

const ALLOWLIST_RULES_BY_ID = new Map(Object.entries({
  "state-manager-memory-compatibility-facade": ["memory-dream-json-state"],
  "legacy-archived-goal-recovery": ["goal-task-json-state"],
  "legacy-goal-wal-input": ["goal-wal-jsonl"],
  "legacy-execution-session-input": ["execution-session-json"],
  "dream-filesystem-metrics": ["goal-task-json-state", "memory-dream-json-state", "strategy-dream-json-state"],
  "dream-soil-sync-compatibility": ["memory-dream-json-state"],
  "dream-activation-file-state": ["memory-dream-json-state"],
  "dream-evidence-file-references": ["memory-dream-json-state"],
  "knowledge-memory-state-compatibility-map": ["memory-dream-json-state"],
  "memory-persistence-compatibility-map": ["goal-task-json-state", "memory-dream-json-state"],
  "soil-import-overlay-queue": ["soil-import-publish-artifact"],
  "goal-task-store-logical-path-parser": ["goal-task-json-state"],
  "strategy-dream-store-logical-path-parser": ["strategy-dream-json-state"],
  "soil-publish-artifact-state": ["plugin-channel-runtime-json", "soil-import-publish-artifact"],
  "legacy-capability-registry-input": ["capability-registry-json-state"],
  "relationship-profile-user-content": ["profile-json-state"],
  "character-config-user-content": ["profile-json-state"],
  "knowledge-transfer-state-manager-facade": ["plugin-channel-runtime-json"],
}));

const RULES = [
  {
    id: "daemon-json-state",
    owner: "DaemonStateStore / control DB daemon tables",
    pattern: /\b(?:daemon-state|shutdown-state|supervisor-state)\.json\b/,
  },
  {
    id: "runtime-queue-json",
    owner: "JournalBackedQueue SQLite queue table",
    pattern: /(?:^|[\\/'"`])(?:runtime\/queue\.json|queue\.json)\b/,
  },
  {
    id: "plugin-channel-runtime-json",
    owner: "PluginChannelRuntimeStateStore or another typed runtime state store",
    pattern: /(?:^|[\\/'"`])(?:state|health)\.json\b|\bruntime\/assets\/registry\.json\b|\bpulseed-foreign-plugin-(?:compatibility|review)\.json\b/,
  },
  {
    id: "chat-agentloop-json",
    owner: "ChatSessionDataStore / AgentLoop session DB store",
    pattern: /\b(?:chat\/sessions\/[^`'"]+\.json|chat\/agentloop\/[^`'"]+\.state\.json|traces\/agentloop\/[^`'"]+\.jsonl)\b/,
  },
  {
    id: "execution-session-json",
    owner: "ExecutionSessionStateStore / control DB execution session tables",
    pattern: /\bsessions\/(?:index\.json|[^`'"]+\.json)\b/,
  },
  {
    id: "goal-wal-jsonl",
    owner: "Goal WAL control DB ownership",
    pattern: /\bwal\.jsonl\b/,
  },
  {
    id: "goal-lock-file",
    owner: "Goal lock control DB ownership",
    pattern: /\b(?:locks\/goals|goals\/[^`'"]+\/\.lock)\b|["'`]\.lock["'`]/,
  },
  {
    id: "goal-task-json-state",
    owner: "GoalTaskStateStore",
    pattern: /\b(?:goal\.json|observations\.json|gap-history\.json|checkpoint\.json|verification-result\.json|tasks\/[^`'"]+\/[^`'"]+\.json|pipelines\/[^`'"]+\.json|checkpoints\/[^`'"]+\/(?:index\.json|[^`'"]+\.json))\b/,
  },
  {
    id: "goal-current-gap-json-state",
    owner: "StateManager typed gap history/current gap APIs",
    pattern: /\bgaps\/[^`'"]+\/current\.json\b/,
  },
  {
    id: "strategy-dream-json-state",
    owner: "StrategyDreamStateStore / runtime evidence DB stores",
    pattern: /\b(?:strategy-history\.json|portfolio\.json|rebalance-history\.json|wait-meta\/[^`'"]+\.json|importance-buffer\.jsonl|schedule-suggestions\.json|activation-artifacts\.json|watermarks\.json)\b/,
  },
  {
    id: "capability-registry-json-state",
    owner: "future typed capability registry store",
    pattern: /\bcapability_registry\.json\b/,
  },
  {
    id: "agentloop-json-store-class",
    owner: "AgentLoop database session and trace stores",
    pattern: /\b(?:JsonAgentLoopSessionStateStore|JsonlAgentLoopTraceStore)\b/,
  },
  {
    id: "agentloop-path-shaped-resume",
    owner: "AgentLoop database session id resume contract",
    pattern: /\bresumeStatePath\b/,
  },
  {
    id: "runtime-journal-owner",
    owner: "typed SQLite runtime store replacing RuntimeJournal",
    pattern: /\bRuntimeJournal\b/,
  },
  {
    id: "runtime-jsonl-ledger",
    owner: "typed SQLite runtime event store",
    pattern: /\b(?:events\.jsonl|proactiveInterventionLedgerPath|evidenceLedger(?:Goals|Runs)?Dir)\b/,
  },
  {
    id: "memory-dream-json-state",
    owner: "Soil/control DB memory and dream typed stores",
    pattern: /\b(?:entries\.json|trust-store\.json|decision-history\.json|decision-heuristics\.json|session-logs\.jsonl|iteration-logs\.jsonl|experience-log\.json|strategies\.json|tasks\.json|knowledge\.json)\b/,
  },
  {
    id: "ethics-log-json-state",
    owner: "EthicsLogStore / control DB ethics log table",
    pattern: /\bethics-log\.json\b/,
  },
  {
    id: "profile-json-state",
    owner: "Relationship/profile typed runtime store or explicit user-authored config/profile content",
    pattern: /\b(?:relationship-profile\.json|relationship-profile-proposals\.json|character-config\.json)\b/,
  },
  {
    id: "soil-import-publish-artifact",
    owner: "Soil import/publish artifact boundary",
    pattern: /\b(?:overlay-queue\.json|publish\.json|\.publish\/state\.json)\b/,
  },
];

const PATH_ALLOWLIST = [
  allow({
    id: "test-fixtures",
    pattern: /(^|\/)__tests__\//,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "tests may contain legacy fixtures and assertions",
  }),
  allow({
    id: "test-fixtures-directory",
    pattern: /(^|\/)tests\//,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "tests may contain legacy fixtures and assertions",
  }),
  allow({
    id: "documentation",
    pattern: /(^|\/)docs\//,
    category: CATEGORY.WORKSPACE_USER_ARTIFACT,
    reason: "docs are repository artifacts, not runtime code",
  }),
  allow({
    id: "tmp-status-artifacts",
    pattern: /(^|\/)tmp\//,
    category: CATEGORY.DEBUG_EXPORT_OUTPUT,
    reason: "tmp status and audit artifacts are not runtime code",
  }),
  allow({
    id: "goal-canary-debug-export",
    pattern: /(^|\/)scripts\/goal-canary-supervisor\.mjs$/,
    category: CATEGORY.DEBUG_EXPORT_OUTPUT,
    reason: "dogfood debug export artifact collector",
  }),
  allow({
    id: "database-first-guard-script",
    pattern: /(^|\/)scripts\/check-database-first-legacy-stores\.mjs$/,
    category: CATEGORY.DEBUG_EXPORT_OUTPUT,
    reason: "this check contains legacy filename rules",
  }),
  allow({
    id: "runtime-store-migrations",
    pattern: /(^|\/)src\/runtime\/store\/.*migration\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "explicit doctor/migrate import boundary",
  }),
  allow({
    id: "chat-agentloop-migration",
    pattern: /(^|\/)src\/interface\/chat\/chat-agentloop-state-migration\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "explicit chat migration boundary",
  }),
  allow({
    id: "schedule-legacy-migration",
    pattern: /(^|\/)src\/runtime\/schedule\/legacy-cron-migration\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "explicit schedule migration boundary",
  }),
  allow({
    id: "doctor-legacy-import-boundary",
    pattern: /(^|\/)src\/interface\/cli\/commands\/doctor\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "doctor is the compatibility boundary",
  }),
  allow({
    id: "state-manager-memory-compatibility-facade",
    pattern: /(^|\/)src\/base\/state\/state-manager\.ts$/,
    category: CATEGORY.MIGRATE_NOW,
    reason: "temporary memory compatibility facade over Soil/control DB memory stores",
    owner: "direct Soil memory store APIs instead of logical file paths",
    nextSlice: 9,
    debtRank: 9,
  }),
  allow({
    id: "legacy-archived-goal-recovery",
    pattern: /(^|\/)src\/base\/state\/legacy-archived-goal-recovery\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "explicit legacy archive recovery boundary",
  }),
  allow({
    id: "legacy-goal-wal-input",
    pattern: /(^|\/)src\/base\/state\/legacy-state-wal\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "explicit legacy goal WAL import/repair boundary",
  }),
  allow({
    id: "knowledge-documents-compatibility",
    pattern: /(^|\/)src\/platform\/knowledge\/knowledge-manager\.ts$/,
    category: CATEGORY.WORKSPACE_USER_ARTIFACT,
    reason: "documents compatibility facade only",
  }),
  allow({
    id: "legacy-execution-session-input",
    pattern: /(^|\/)src\/runtime\/store\/execution-session-state-migration\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "explicit legacy execution session import/repair boundary",
    owner: "ExecutionSessionStateStore",
  }),
  allow({
    id: "dream-filesystem-metrics",
    pattern: /(^|\/)src\/platform\/dream\/dream-consolidator(?:\/fs-metrics)?\.ts$/,
    category: CATEGORY.PRODUCT_DECISION_NEEDED,
    reason: "known follow-up dream file metrics surface",
    owner: "typed dream/memory metric sources or explicit debug metric boundary",
    nextSlice: 9,
    debtRank: 9,
  }),
  allow({
    id: "dream-soil-sync-compatibility",
    pattern: /(^|\/)src\/platform\/dream\/dream-soil-sync\.ts$/,
    category: CATEGORY.MIGRATE_NOW,
    reason: "known follow-up legacy memory projection read",
    owner: "Soil memory projections",
    nextSlice: 9,
    debtRank: 9,
  }),
  allow({
    id: "dream-activation-file-state",
    pattern: /(^|\/)src\/platform\/dream\/dream-activation\.ts$/,
    category: CATEGORY.MIGRATE_NOW,
    reason: "known follow-up dream activation file-state reads",
    owner: "typed dream, learning, and strategy activation stores",
    nextSlice: 9,
    debtRank: 9,
  }),
  allow({
    id: "dream-evidence-file-references",
    pattern: /(^|\/)src\/platform\/dream\/dream-consolidator\/evidence-helpers\.ts$/,
    category: CATEGORY.PRODUCT_DECISION_NEEDED,
    reason: "known follow-up legacy evidence reference surface",
    owner: "typed memory evidence references or explicit debug reference boundary",
    nextSlice: 9,
    debtRank: 9,
  }),
  allow({
    id: "knowledge-memory-state-compatibility-map",
    pattern: /(^|\/)src\/platform\/knowledge\/knowledge-memory-state-store\.ts$/,
    category: CATEGORY.MIGRATE_NOW,
    reason: "known follow-up memory compatibility path map over Soil state",
    owner: "direct Soil memory store APIs",
    nextSlice: 9,
    debtRank: 9,
  }),
  allow({
    id: "memory-persistence-compatibility-map",
    pattern: /(^|\/)src\/platform\/knowledge\/memory\/memory-persistence\.ts$/,
    category: CATEGORY.MIGRATE_NOW,
    reason: "known follow-up memory compatibility map",
    owner: "Soil memory state",
    nextSlice: 9,
    debtRank: 9,
  }),
  allow({
    id: "soil-import-overlay-queue",
    pattern: /(^|\/)src\/platform\/soil\/importer\.ts$/,
    category: CATEGORY.SOIL_IMPORT_PUBLISH_ARTIFACT,
    reason: "Soil import overlay queue is outside normal runtime state ownership",
    owner: "explicit Soil import artifact",
    nextSlice: 9,
  }),
  allow({
    id: "foreign-plugin-legacy-constants",
    pattern: /(^|\/)src\/runtime\/foreign-plugins\/compatibility\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "legacy filename constants for migration/debug references",
  }),
  allow({
    id: "goal-task-store-logical-path-parser",
    pattern: /(^|\/)src\/runtime\/store\/goal-task-state-store\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "legacy logical-path adapter retained for explicit migration/compatibility coverage; normal callers use typed APIs",
    owner: "GoalTaskStateStore typed APIs",
  }),
  allow({
    id: "strategy-dream-store-logical-path-parser",
    pattern: /(^|\/)src\/runtime\/store\/strategy-dream-state-store\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "legacy logical-path adapter retained for explicit migration/compatibility coverage; normal callers use typed APIs",
    owner: "StrategyDreamStateStore typed APIs",
  }),
  allow({
    id: "soil-publish-artifact-state",
    pattern: /(^|\/)src\/platform\/soil\/publish\/config\.ts$/,
    category: CATEGORY.SOIL_IMPORT_PUBLISH_ARTIFACT,
    reason: "Soil publish state is an explicit publish artifact",
    owner: "explicit Soil publish artifact",
    nextSlice: 9,
  }),
  allow({
    id: "legacy-capability-registry-input",
    pattern: /(^|\/)src\/runtime\/store\/capability-registry-state-migration\.ts$/,
    category: CATEGORY.MIGRATION_ONLY_INPUT,
    reason: "legacy capability_registry.json is an explicit repair import input",
    owner: "CapabilityRegistryStateStore",
  }),
  allow({
    id: "relationship-profile-user-content",
    pattern: /(^|\/)src\/platform\/profile\/relationship-profile\.ts$/,
    category: CATEGORY.WORKSPACE_USER_ARTIFACT,
    reason: "relationship profile is explicit user-authored profile content, not internal runtime state",
    owner: "relationship profile user content",
  }),
  allow({
    id: "character-config-user-content",
    pattern: /(^|\/)src\/platform\/traits\/character-config\.ts$/,
    category: CATEGORY.CONFIG_SECRET,
    reason: "character config is explicit user-editable configuration",
    owner: "character configuration",
  }),
  allow({
    id: "knowledge-transfer-state-manager-facade",
    pattern: /(^|\/)src\/platform\/knowledge\/transfer\/knowledge-transfer-types\.ts$/,
    category: CATEGORY.MIGRATE_NOW,
    reason: "StateManager compatibility facade call site",
    owner: "typed knowledge transfer store APIs",
    nextSlice: 9,
    debtRank: 9,
  }),
];

const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "coverage", ".pulseed-sandbox"]);

export function scanText(filePath, text) {
  return scanTextDetailed(filePath, text).findings;
}

export function scanTextDetailed(filePath, text) {
  const normalizedPath = normalizePath(filePath);
  const allow = PATH_ALLOWLIST.find((entry) => entry.pattern.test(normalizedPath));
  const findings = [];
  const classifiedFindings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.pattern.test(line) && !isConfigAllowed(line)) {
        const finding = {
          filePath: normalizedPath,
          line: index + 1,
          rule: rule.id,
          owner: rule.owner,
          text: line.trim(),
        };
        if (allow && isAllowlistedRule(allow, rule.id)) {
          classifiedFindings.push({
            ...finding,
            allowlistId: allow.id,
            category: allow.category,
            reason: allow.reason,
            expectedOwner: allow.owner ?? rule.owner,
            nextSlice: allow.nextSlice ?? null,
            debtRank: allow.debtRank ?? null,
          });
        } else {
          findings.push({
            ...finding,
            allowlistId: allow?.id,
            allowlistReason: allow && !isAllowlistedRule(allow, rule.id)
              ? `allowlist entry "${allow.id}" does not permit rule "${rule.id}"`
              : undefined,
          });
        }
      }
    }
  });
  return { findings, classifiedFindings };
}

export function scanFiles(roots) {
  return scanFilesDetailed(roots).findings;
}

export function scanFilesDetailed(roots) {
  const findings = [];
  const classifiedFindings = [];
  for (const root of roots) {
    const absoluteRoot = path.resolve(repoRoot, root);
    for (const filePath of walkFiles(absoluteRoot)) {
      const scanned = scanTextDetailed(path.relative(repoRoot, filePath), fs.readFileSync(filePath, "utf8"));
      findings.push(...scanned.findings);
      classifiedFindings.push(...scanned.classifiedFindings);
    }
  }
  return {
    findings,
    classifiedFindings,
    debtReport: buildDebtReport(classifiedFindings),
  };
}

function allow(entry) {
  if (!entry.id) throw new Error("database-first legacy store allowlist entries require an id");
  if (!CLASSIFICATIONS.has(entry.category)) {
    throw new Error(`database-first legacy store allowlist entry "${entry.id}" has invalid category "${entry.category}"`);
  }
  const rules = entry.rules ?? ALLOWLIST_RULES_BY_ID.get(entry.id);
  if ((entry.debtRank !== undefined || entry.nextSlice !== undefined) && rules === undefined) {
    throw new Error(`database-first legacy store allowlist entry "${entry.id}" requires precise rule ids`);
  }
  return rules === undefined ? entry : { ...entry, rules };
}

function isAllowlistedRule(allowlistEntry, ruleId) {
  return allowlistEntry.rules === undefined || allowlistEntry.rules.includes(ruleId);
}

function buildDebtReport(classifiedFindings) {
  const findingsByAllowlistId = new Map();
  for (const finding of classifiedFindings) {
    const existing = findingsByAllowlistId.get(finding.allowlistId) ?? [];
    existing.push(finding);
    findingsByAllowlistId.set(finding.allowlistId, existing);
  }

  return PATH_ALLOWLIST
    .filter((entry) => entry.debtRank !== undefined || entry.nextSlice !== undefined)
    .map((entry) => {
      const matches = findingsByAllowlistId.get(entry.id) ?? [];
      return {
        id: entry.id,
        category: entry.category,
        reason: entry.reason,
        owner: entry.owner ?? null,
        nextSlice: entry.nextSlice ?? null,
        debtRank: entry.debtRank ?? null,
        pathPattern: entry.pattern.source,
        matchCount: matches.length,
        matches,
      };
    })
    .sort((left, right) => {
      const leftRank = left.debtRank ?? Number.MAX_SAFE_INTEGER;
      const rightRank = right.debtRank ?? Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) return leftRank - rightRank;
      return left.id.localeCompare(right.id);
    });
}

function printDebtReport(debtReport) {
  if (debtReport.length === 0) return;
  console.log("classified legacy store debt report:");
  for (const entry of debtReport) {
    const rank = entry.debtRank === null ? "artifact" : `rank ${entry.debtRank}`;
    const next = entry.nextSlice === null ? "no follow-up slice" : `Slice ${entry.nextSlice}`;
    console.log(`- ${entry.id}: ${entry.category}; ${rank}; ${next}; owner: ${entry.owner}; matches: ${entry.matchCount}`);
  }
  console.log("run with --json for line-level classified matches and reasons");
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
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const roots = args.filter((arg) => arg !== "--json");
  const result = scanFilesDetailed(roots.length > 0 ? roots : ["src", "scripts"]);

  if (json) {
    console.log(JSON.stringify({
      ok: result.findings.length === 0,
      findings: result.findings,
      classifiedFindings: result.classifiedFindings,
      debtReport: result.debtReport,
    }, null, 2));
    if (result.findings.length > 0) process.exitCode = 1;
    return;
  }

  const findings = result.findings;
  if (findings.length === 0) {
    console.log("database-first legacy store check passed");
    printDebtReport(result.debtReport);
    return;
  }
  console.error("database-first legacy store check failed:");
  for (const finding of findings) {
    console.error(`${finding.filePath}:${finding.line} [${finding.rule}] ${finding.owner}`);
    console.error(`  ${finding.text}`);
    if (finding.allowlistReason) {
      console.error(`  ${finding.allowlistReason}`);
    }
  }
  console.error("Unclassified legacy store references must be moved to typed stores or categorized as migration, debug/export, config/secret, workspace/user artifact, Soil import/publish artifact, or product-decision debt.");
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
