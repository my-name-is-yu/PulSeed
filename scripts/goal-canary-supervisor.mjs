#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const DEFAULT_CYCLE_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_POLL_INTERVAL_MS = 15 * 1000;

const SCENARIOS = [
  {
    slug: "artifact-contract-exactness",
    dimension: "contract_done_exists:present",
    title: "Goal canary: artifact contract exactness",
    expectedArtifact: "reports/contract.done",
    workspaceFiles: {
      "README.md": [
        "# Artifact contract exactness canary",
        "",
        "Create `scripts/contract-canary.mjs`, `reports/contract.json`, and a completion marker at `reports/contract.done`.",
        "The generated task must set PulSeed `artifact_contract.required=true`.",
        "The only required artifact is `reports/contract.json` with kind `metrics_json`.",
        "The exact required_fields must be `[\"score\",\"scenario\"]`.",
        "The exact field_types must be `{ \"score\": \"number\", \"scenario\": \"string\" }`.",
        "The artifact contract must set `fresh_after_task_start: true`.",
        "The script-local `node scripts/contract-canary.mjs --check-contract` validator must validate the exact same fields and types.",
        "`--check-contract` must write `reports/contract.json` before validation so PulSeed can observe a fresh task artifact; it must not merely validate a schema-valid stale file.",
        "Only create `reports/contract.done` after the metrics file has been written and the validator passes.",
        "Do not add alias fields to either the writer or the contract.",
        "The validator may regenerate missing/schema-invalid artifacts, but it must not reject an otherwise valid artifact only because it predates the validator process.",
        "",
      ].join("\n"),
      "reports/contract.json": JSON.stringify({ score: 0.1, scenario: "stale" }, null, 2) + "\n",
    },
  },
  {
    slug: "task-lifecycle-reconciliation",
    dimension: "lifecycle_report_exists:present",
    title: "Goal canary: task lifecycle reconciliation",
    expectedArtifact: "reports/lifecycle.json",
    workspaceFiles: {
      "README.md": [
        "# Task lifecycle reconciliation canary",
        "",
        "Create `scripts/lifecycle-canary.mjs` and `reports/lifecycle.json`.",
        "The report must contain `{ \"scenario\": \"task-lifecycle-reconciliation\", \"ok\": true }`.",
        "Run `node scripts/lifecycle-canary.mjs --check-contract` as the blocking verification command.",
        "Complete the task through the normal AgentLoop final output.",
        "Do not mutate PulSeed task lifecycle-owned fields through `task_update`.",
        "A task that has reached succeeded in the task ledger must not be overwritten to error by later verification/reporting paths.",
        "",
      ].join("\n"),
    },
  },
  {
    slug: "agentloop-final-output-schema",
    dimension: "final_schema_report_exists:present",
    title: "Goal canary: AgentLoop final output schema variants",
    expectedArtifact: "reports/final-schema.json",
    workspaceFiles: {
      "README.md": [
        "# AgentLoop final output schema canary",
        "",
        "Create `reports/final-schema.json` with `{ \"scenario\": \"agentloop-final-output-schema\", \"ok\": true }`.",
        "Use `node -e \"const fs=require('fs'); const x=JSON.parse(fs.readFileSync('reports/final-schema.json','utf8')); if(x.scenario!=='agentloop-final-output-schema'||x.ok!==true) process.exit(1)\"` as the blocking verification command.",
        "Return a valid final task completion even if the model naturally uses fields like finalAnswer, final_answer, summary, completionEvidence, or object-shaped evidence during schema repair.",
        "PulSeed should normalize or reject through the typed output contract, not convert a valid completion into task error because of a naming variant.",
        "",
      ].join("\n"),
    },
  },
  {
    slug: "completion-judger-fallback",
    dimension: "judger_report_exists:present",
    title: "Goal canary: completion judger fallback",
    expectedArtifact: "reports/judger.json",
    workspaceFiles: {
      "README.md": [
        "# Completion judger fallback canary",
        "",
        "Create `scripts/judger-canary.mjs` and `reports/judger.json`.",
        "Use artifact/mechanical verification as authoritative evidence.",
        "The report must contain `{ \"scenario\": \"completion-judger-fallback\", \"passed\": true }`.",
        "Run `node scripts/judger-canary.mjs --check-contract` as the blocking verification command.",
        "If the LLM completion judger is unavailable or times out after mechanical/artifact pass, PulSeed must not downgrade the task to failed.",
        "",
      ].join("\n"),
    },
  },
  {
    slug: "non-git-workspace-handoff",
    dimension: "nongit_report_exists:present",
    title: "Goal canary: non-git workspace handoff",
    expectedArtifact: "reports/nongit.json",
    workspaceFiles: {
      "README.md": [
        "# Non-git workspace handoff canary",
        "",
        "This workspace is intentionally not a git repository.",
        "Create `reports/nongit.json` with `{ \"scenario\": \"non-git-workspace-handoff\", \"safe\": true }`.",
        "Run a blocking verification command that reads the JSON file.",
        "PulSeed revert/reporting must not claim git revert success when git is unavailable.",
        "",
      ].join("\n"),
    },
  },
  {
    slug: "daemon-stop-restart",
    dimension: "restart_report_exists:present",
    title: "Goal canary: daemon stop restart recovery",
    expectedArtifact: "reports/restart.json",
    workspaceFiles: {
      "README.md": [
        "# Daemon stop/restart canary",
        "",
        "Create `scripts/restart-canary.mjs` and `reports/restart.json` inside this disposable workspace.",
        "The script must write `{ \"scenario\": \"daemon-stop-restart\", \"restart_safe\": true }` to `reports/restart.json`.",
        "The generated PulSeed task must set `artifact_contract.required=true`.",
        "The only required artifact is `reports/restart.json` with kind `metrics_json`.",
        "The exact required_fields must be `[\"scenario\",\"restart_safe\"]`.",
        "The exact field_types must be `{ \"scenario\": \"string\", \"restart_safe\": \"boolean\" }`.",
        "The artifact contract must set `fresh_after_task_start: true`.",
        "Run `node scripts/restart-canary.mjs --check-contract` as the focused blocking verification command.",
        "`--check-contract` must read the JSON file and fail when the payload is missing or wrong.",
        "The external supervisor may stop and restart the daemon while observe or verification state is fresh.",
        "Do not modify PulSeed source code from this task; the supervisor verifies runtime stale-worker recovery externally.",
        "",
      ].join("\n"),
    },
    restartAfterExpectedArtifactSeen: true,
  },
  {
    slug: "observation-freshness",
    dimension: "accuracy:min:0.9",
    title: "Goal canary: observation freshness aggregation",
    expectedArtifact: "experiments/fresh/metrics.json",
    workspaceFiles: {
      "README.md": [
        "# Observation freshness canary",
        "",
        "Create `experiments/stale/metrics.json` with `{ \"accuracy\": 0.2 }` and an older mtime.",
        "Create `experiments/fresh/metrics.json` with `{ \"accuracy\": 0.93 }`.",
        "PulSeed observation should prefer the fresh artifact over stale evidence for the `accuracy` dimension.",
        "For max/min aggregation, the selected current value must respect the dimension direction instead of taking the wrong extreme.",
        "",
      ].join("\n"),
      "experiments/stale/metrics.json": JSON.stringify({ accuracy: 0.2 }, null, 2) + "\n",
    },
  },
  {
    slug: "cli-packaging-build",
    dimension: "packaged_cli_report_exists:present",
    title: "Goal canary: CLI packaging and build surface",
    expectedArtifact: "reports/packaged-cli.json",
    workspaceFiles: {
      "README.md": [
        "# CLI packaging/build canary",
        "",
        "Create `reports/packaged-cli.json` after checking the PulSeed build artifact surface from the caller workspace.",
        "The report should record whether `dist/interface/cli/cli-runner.js` is executable and whether packaged artifact verification passed.",
        "Do not run npm publish, create tags, create GitHub Releases, or touch version/changelog files.",
        "",
      ].join("\n"),
    },
  },
];

function parseArgs(argv) {
  const options = {
    evidenceRoot: null,
    cycleTimeoutMs: DEFAULT_CYCLE_TIMEOUT_MS,
    snapshotIntervalMs: DEFAULT_SNAPSHOT_INTERVAL_MS,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    maxScenarios: SCENARIOS.length,
    scenarioSlugs: [],
    model: process.env.PULSEED_CANARY_MODEL ?? "gpt-5.4-mini",
    stopOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--evidence-root" && next) options.evidenceRoot = next, i += 1;
    else if (arg === "--cycle-timeout-ms" && next) options.cycleTimeoutMs = positiveInt(next, arg), i += 1;
    else if (arg === "--snapshot-interval-ms" && next) options.snapshotIntervalMs = positiveInt(next, arg), i += 1;
    else if (arg === "--poll-ms" && next) options.pollIntervalMs = positiveInt(next, arg), i += 1;
    else if (arg === "--max-scenarios" && next) options.maxScenarios = positiveInt(next, arg), i += 1;
    else if (arg === "--scenario" && next) {
      options.scenarioSlugs.push(...next.split(",").map((item) => item.trim()).filter(Boolean));
      i += 1;
    } else if (arg === "--model" && next) {
      options.model = next;
      i += 1;
    } else if (arg === "--stop-only") {
      options.stopOnly = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function positiveInt(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function printHelp() {
  console.log([
    "Usage: node scripts/goal-canary-supervisor.mjs [options]",
    "",
    "Options:",
    "  --scenario <slug[,slug]>       Run selected scenario(s)",
    "  --max-scenarios <n>            Run the first N scenarios after filtering",
    "  --evidence-root <path>         Evidence output root",
    "  --cycle-timeout-ms <ms>        Per-scenario timeout, default 20m",
    "  --snapshot-interval-ms <ms>    Evidence snapshot cadence, default 5m",
    "  --poll-ms <ms>                 Poll cadence, default 15s",
    "  --model <model>                Provider model, default gpt-5.4-mini",
  ].join("\n"));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const cliPath = path.join(repoRoot, "dist", "interface", "cli", "cli-runner.js");
  await fs.access(cliPath, fsConstants.X_OK);

  const startedAt = new Date();
  const evidenceRoot = path.resolve(
    options.evidenceRoot ?? path.join("tmp", "goal-canaries", formatTimestamp(startedAt))
  );
  await fs.mkdir(evidenceRoot, { recursive: true });

  const selected = selectScenarios(options);
  const results = [];
  for (const scenario of selected) {
    const result = await runScenario({
      scenario,
      repoRoot,
      cliPath,
      evidenceRoot,
      options,
    });
    results.push(result);
    await writeSummary(evidenceRoot, results, { partial: true });
    if (result.finalState !== "completed") break;
  }
  await writeSummary(evidenceRoot, results, { partial: false });

  const failed = results.filter((result) => result.finalState !== "completed");
  console.log(`Canary evidence: ${evidenceRoot}`);
  console.log(`Scenarios: ${results.length}, completed: ${results.length - failed.length}, blocked: ${failed.length}`);
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

function selectScenarios(options) {
  const filtered = options.scenarioSlugs.length > 0
    ? SCENARIOS.filter((scenario) => options.scenarioSlugs.includes(scenario.slug))
    : SCENARIOS;
  const missing = options.scenarioSlugs.filter((slug) => !SCENARIOS.some((scenario) => scenario.slug === slug));
  if (missing.length > 0) {
    throw new Error(`Unknown scenario slug(s): ${missing.join(", ")}`);
  }
  return filtered.slice(0, options.maxScenarios);
}

async function runScenario(input) {
  const { scenario, cliPath, repoRoot, evidenceRoot, options } = input;
  const scenarioDir = path.join(evidenceRoot, scenario.slug);
  const pulseedHome = path.join(scenarioDir, "pulseed-home");
  const workspace = path.join(scenarioDir, "workspace");
  const snapshotsDir = path.join(scenarioDir, "snapshots");
  await fs.mkdir(snapshotsDir, { recursive: true });
  await fs.mkdir(workspace, { recursive: true });

  await writeWorkspace(workspace, scenario.workspaceFiles);
  if (scenario.slug === "artifact-contract-exactness") {
    const stale = new Date(Date.now() - 60 * 60 * 1000);
    await fs.utimes(path.join(workspace, "reports", "contract.json"), stale, stale);
  }
  if (scenario.slug === "observation-freshness") {
    const stale = new Date(Date.now() - 60 * 60 * 1000);
    await fs.utimes(path.join(workspace, "experiments", "stale", "metrics.json"), stale, stale);
  }

  await fs.mkdir(pulseedHome, { recursive: true });
  await writeJson(path.join(pulseedHome, "provider.json"), {
    provider: "openai",
    model: options.model,
    light_model: options.model,
    reasoning_effort: "low",
    adapter: "openai_codex_cli",
    agent_loop: {
      security: {
        sandbox_mode: "workspace_write",
        approval_policy: "never",
        network_access: false,
        trust_project_instructions: true,
      },
      worktree: {
        enabled: true,
        keep_for_debug: true,
        cleanup_policy: "never",
      },
    },
  });
  await writeJson(path.join(pulseedHome, "daemon.json"), {
    event_server_port: 0,
    check_interval_ms: 30_000,
    iterations_per_cycle: 1,
    max_concurrent_goals: 1,
    workspace_path: workspace,
    run_policy: { mode: "bounded", max_iterations: 1 },
    crash_recovery: { enabled: true, max_retries: 0, retry_delay_ms: 10_000 },
  });

  const env = {
    ...process.env,
    PULSEED_HOME: pulseedHome,
    PULSEED_PROVIDER: "openai",
    PULSEED_ADAPTER: "openai_codex_cli",
    PULSEED_MODEL: options.model,
    PULSEED_REASONING_EFFORT: "low",
  };
  delete env.PULSEED_DEFAULT_ADAPTER;

  const logFile = path.join(scenarioDir, "supervisor.log");
  await appendLog(logFile, `scenario=${scenario.slug}\nworkspace=${workspace}\npulseed_home=${pulseedHome}\n`);

  let goalId = null;
  let finalState = "blocked";
  let classification = "unknown";
  let taskId = null;
  let stopStatus = "not_started";
  let restarted = false;
  let interruptedTaskId = null;
  let restartInterruptedRunningTask = false;
  let restartStartedAt = null;
  let restartCutoffEventAt = null;

  try {
    const goalDescription = buildGoalDescription(scenario, workspace);
    const addResult = await runCli(cliPath, [
      "goal",
      "add",
      goalDescription,
      "--title",
      scenario.title,
      "--dim",
      scenario.dimension,
      "--workspace",
      workspace,
      "--yes",
    ], { cwd: workspace, env, logFile, timeoutMs: 120_000 });
    if (addResult.code !== 0) {
      finalState = "blocked";
      classification = "goal_add_failed";
      await writeText(path.join(scenarioDir, "goal-add.stderr.txt"), addResult.stderr);
      return { scenario: scenario.slug, goalId, taskId, finalState, classification, stopStatus, scenarioDir };
    }

    goalId = extractGoalId(addResult.stdout + "\n" + addResult.stderr);
    if (!goalId) {
      finalState = "blocked";
      classification = "goal_id_parse_failed";
      await writeText(path.join(scenarioDir, "goal-add.stdout.txt"), addResult.stdout);
      return { scenario: scenario.slug, goalId, taskId, finalState, classification, stopStatus, scenarioDir };
    }

    await snapshot({ cliPath, env, cwd: workspace, scenarioDir, snapshotsDir, goalId, label: "after-goal-add", logFile });

    const started = await startDaemon({ cliPath, env, workspace, goalId, logFile });
    if (started.code !== 0) {
      finalState = "blocked";
      classification = "daemon_start_failed";
      return { scenario: scenario.slug, goalId, taskId, finalState, classification, stopStatus, scenarioDir };
    }

    const deadline = Date.now() + options.cycleTimeoutMs;
    let nextSnapshotAt = Date.now();
    while (Date.now() < deadline) {
      if (Date.now() >= nextSnapshotAt) {
        await snapshot({
          cliPath,
          env,
          cwd: workspace,
          scenarioDir,
          snapshotsDir,
          goalId,
          label: `poll-${Date.now()}`,
          logFile,
        });
        nextSnapshotAt = Date.now() + options.snapshotIntervalMs;
      }

      const latest = await readLatestTaskAndLedger(pulseedHome, goalId);
      const workspaceFiles = await listWorkspaceFiles(workspace);
      latest.workspaceFiles = workspaceFiles.map((entry) => entry.path);
      taskId = latest.task?.id ?? taskId;
      const expectedArtifactSeen =
        Boolean(scenario.restartAfterExpectedArtifactSeen) &&
        Boolean(scenario.expectedArtifact) &&
        latest.workspaceFiles.includes(scenario.expectedArtifact);
      if (expectedArtifactSeen && taskId && !restarted) {
        if (latest.task?.status !== "running") {
          finalState = "blocked";
          classification = `restart_not_exercised_task_${latest.task?.status ?? "unknown"}`;
          break;
        }
        interruptedTaskId = taskId;
        restartInterruptedRunningTask = true;
        restartStartedAt = new Date().toISOString();
        restartCutoffEventAt = getLatestLedgerEvent(latest.ledger)?.ts ?? null;
        await runCli(cliPath, ["daemon", "stop"], { cwd: workspace, env, logFile, timeoutMs: 30_000 });
        await snapshot({ cliPath, env, cwd: workspace, scenarioDir, snapshotsDir, goalId, label: "after-forced-stop", logFile });
        await startDaemon({ cliPath, env, workspace, goalId, logFile });
        restarted = true;
        continue;
      } else if (scenario.restartAfterFirstTaskSeen && taskId && !restarted) {
        interruptedTaskId = taskId;
        restartInterruptedRunningTask = latest.task?.status === "running";
        restartStartedAt = new Date().toISOString();
        restartCutoffEventAt = getLatestLedgerEvent(latest.ledger)?.ts ?? null;
        await runCli(cliPath, ["daemon", "stop"], { cwd: workspace, env, logFile, timeoutMs: 30_000 });
        await snapshot({ cliPath, env, cwd: workspace, scenarioDir, snapshotsDir, goalId, label: "after-forced-stop", logFile });
        await startDaemon({ cliPath, env, workspace, goalId, logFile });
        restarted = true;
        continue;
      }

      const classificationNow = classifyScenarioState(scenario, latest, {
        restarted,
        interruptedTaskId,
        restartInterruptedRunningTask,
        restartStartedAt,
        restartCutoffEventAt,
      });
      if (classificationNow.done) {
        finalState = "completed";
        classification = classificationNow.classification;
        break;
      }
      if (classificationNow.blocked) {
        finalState = "blocked";
        classification = classificationNow.classification;
        break;
      }

      await sleep(options.pollIntervalMs);
    }

    if (finalState !== "completed" && classification === "unknown") {
      finalState = "timeout";
      classification = "cycle_timeout";
    }

    await snapshot({ cliPath, env, cwd: workspace, scenarioDir, snapshotsDir, goalId, label: "final-before-stop", logFile });
  } finally {
    const stopResult = await runCli(cliPath, ["daemon", "stop"], { cwd: workspace, env, logFile, timeoutMs: 45_000 });
    stopStatus = stopResult.code === 0 ? "stopped_or_not_running" : "stop_failed";
    if (goalId) {
      await snapshot({ cliPath, env, cwd: workspace, scenarioDir, snapshotsDir, goalId, label: "after-stop", logFile });
    }
  }

  return {
    scenario: scenario.slug,
    goalId,
    taskId,
    finalState,
    classification,
    stopStatus,
    scenarioDir,
  };
}

function buildGoalDescription(scenario, workspace) {
  return [
    scenario.title,
    "",
    `Disposable workspace: ${workspace}`,
    `Required evidence artifact: ${scenario.expectedArtifact}`,
    "Run only local commands in the disposable workspace.",
    "Do not submit, upload, deploy, publish, tag, or create a GitHub Release.",
    "Do not touch CHANGELOG.md, package version fields, npm publish, release scripts, or tag creation.",
    "Use the real PulSeed daemon/DurableLoop/AgentLoop/tool execution/verification/ledger/observation path.",
    "",
    "Scenario instructions:",
    scenario.workspaceFiles["README.md"] ?? "",
  ].join("\n");
}

async function startDaemon({ cliPath, env, workspace, goalId, logFile }) {
  return runCli(cliPath, [
    "daemon",
    "start",
    "--detach",
    "--goal",
    goalId,
    "--iterations-per-cycle",
    "1",
    "--check-interval-ms",
    "30000",
    "--max-concurrent-goals",
    "1",
    "--workspace",
    workspace,
  ], { cwd: workspace, env, logFile, timeoutMs: 60_000 });
}

export function classifyScenarioState(scenario, latest, context = {}) {
  const task = latest.task;
  const ledger = latest.ledger;
  if (!task) return { done: false, blocked: false, classification: "waiting_for_task_generation" };

  const latestLedgerEvent = getLatestLedgerEvent(ledger);
  const latestEvent = latestLedgerEvent?.type ?? null;
  const restartRecoveryState = classifyRestartRecoveryState(scenario, latest, context, latestLedgerEvent);
  if (restartRecoveryState) {
    return restartRecoveryState;
  }

  if (latestEvent === "succeeded" || task.status === "completed") {
    if (task.status === "error" || task.status === "failed") {
      return { done: false, blocked: true, classification: "succeeded_then_terminal_error" };
    }
    if (
      scenario.restartAfterExpectedArtifactSeen &&
      (context.restarted !== true ||
        context.restartInterruptedRunningTask !== true ||
        context.interruptedTaskId !== task.id)
    ) {
      return { done: false, blocked: true, classification: "restart_not_exercised_before_success" };
    }
    return { done: true, blocked: false, classification: "task_succeeded" };
  }

  const terminalFailureStatuses = new Set(["error", "failed", "timed_out", "blocked", "cancelled", "discarded", "abandoned"]);
  if (terminalFailureStatuses.has(task.status) || latestEvent === "failed" || latestEvent === "abandoned") {
    if (
      (scenario.restartAfterFirstTaskSeen || scenario.restartAfterExpectedArtifactSeen) &&
      context.restarted === true &&
      context.interruptedTaskId === task.id &&
      (task.status === "cancelled" || latestEvent === "failed")
    ) {
      return { done: false, blocked: false, classification: "awaiting_restart_retry" };
    }
    return { done: false, blocked: true, classification: `terminal_${task.status || latestEvent}` };
  }

  const expected = scenario.expectedArtifact;
  if (expected && latest.workspaceFiles?.includes(expected) && task.verification_verdict === "pass") {
    if (scenario.restartAfterExpectedArtifactSeen) {
      return { done: false, blocked: false, classification: "awaiting_restart_recovery_ledger" };
    }
    return { done: true, blocked: false, classification: "artifact_and_verification_passed" };
  }
  return { done: false, blocked: false, classification: "running" };
}

function classifyRestartRecoveryState(scenario, latest, context, latestLedgerEvent) {
  if (!scenario.restartAfterExpectedArtifactSeen) return null;
  const task = latest.task;
  if (!task) return null;

  const observedSuccess = latestLedgerEvent?.type === "succeeded" || task.status === "completed";
  if (!observedSuccess) return null;

  if (
    context.restarted !== true ||
    context.restartInterruptedRunningTask !== true ||
    context.interruptedTaskId !== task.id
  ) {
    return { done: false, blocked: true, classification: "restart_not_exercised_before_success" };
  }

  if (latestLedgerEvent?.type !== "succeeded") {
    return { done: false, blocked: false, classification: "awaiting_restart_success_ledger" };
  }

  if (!isIsoAfter(latestLedgerEvent.ts, context.restartCutoffEventAt)) {
    return { done: false, blocked: true, classification: "stale_restart_success_ledger" };
  }

  if (!hasFreshRestartRecoveryHistory(latest.taskHistory, task.id, context.restartStartedAt)) {
    return { done: false, blocked: true, classification: "missing_fresh_restart_recovery_history" };
  }

  if (task.status !== "completed" || task.verification_verdict !== "pass") {
    return { done: false, blocked: true, classification: "restart_success_without_completed_pass" };
  }

  return { done: true, blocked: false, classification: "task_succeeded" };
}

function getLatestLedgerEvent(ledger) {
  if (!ledger || typeof ledger !== "object") return null;
  const summaryType = typeof ledger.summary?.latest_event_type === "string"
    ? ledger.summary.latest_event_type
    : null;
  const summaryTs = typeof ledger.summary?.latest_event_at === "string"
    ? ledger.summary.latest_event_at
    : null;
  if (summaryType) {
    return { type: summaryType, ts: summaryTs };
  }
  const events = Array.isArray(ledger.events) ? ledger.events : [];
  const event = events.at(-1);
  if (!event || typeof event !== "object" || typeof event.type !== "string") return null;
  return {
    type: event.type,
    ts: typeof event.ts === "string" ? event.ts : null,
  };
}

function hasFreshRestartRecoveryHistory(taskHistory, taskId, restartStartedAt) {
  if (!Array.isArray(taskHistory)) return false;
  const daemonRecoverySources = new Set(["daemon_shutdown", "daemon_startup"]);
  return taskHistory.some((entry) =>
    entry &&
    typeof entry === "object" &&
    entry.task_id === taskId &&
    daemonRecoverySources.has(entry.recovery_source) &&
    isIsoAtOrAfter(entry.completed_at, restartStartedAt)
  );
}

function isIsoAfter(value, cutoff) {
  if (!cutoff) return Boolean(value);
  const valueMs = typeof value === "string" ? Date.parse(value) : NaN;
  const cutoffMs = typeof cutoff === "string" ? Date.parse(cutoff) : NaN;
  return Number.isFinite(valueMs) && Number.isFinite(cutoffMs) && valueMs > cutoffMs;
}

function isIsoAtOrAfter(value, cutoff) {
  if (!cutoff) return Boolean(value);
  const valueMs = typeof value === "string" ? Date.parse(value) : NaN;
  const cutoffMs = typeof cutoff === "string" ? Date.parse(cutoff) : NaN;
  return Number.isFinite(valueMs) && Number.isFinite(cutoffMs) && valueMs >= cutoffMs;
}

async function snapshot(input) {
  const { cliPath, env, cwd, scenarioDir, snapshotsDir, goalId, label, logFile } = input;
  const dir = path.join(snapshotsDir, sanitize(label));
  await fs.mkdir(dir, { recursive: true });

  const daemonStatus = await runCli(cliPath, ["daemon", "status"], { cwd, env, logFile, timeoutMs: 20_000, allowFailure: true });
  await writeText(path.join(dir, "daemon-status.txt"), daemonStatus.stdout + daemonStatus.stderr);

  const goalStatus = await runCli(cliPath, ["status", "--goal", goalId], { cwd, env, logFile, timeoutMs: 30_000, allowFailure: true });
  await writeText(path.join(dir, "goal-status.txt"), goalStatus.stdout + goalStatus.stderr);

  const home = env.PULSEED_HOME;
  await copyIfExists(path.join(home, "daemon-state.json"), path.join(dir, "daemon-state.json"));
  await copyIfExists(path.join(home, "runtime", "supervisor-state.json"), path.join(dir, "supervisor-state.json"));
  await copyIfExists(path.join(home, "logs", "pulseed.log"), path.join(dir, "pulseed.log"));
  await copyIfExists(path.join(home, "goals", goalId, "goal.json"), path.join(dir, "goal.json"));
  await copyIfExists(path.join(home, "goals", goalId, "observations.json"), path.join(dir, "observations.json"));
  await copyIfExists(path.join(home, "tasks", goalId, "task-history.json"), path.join(dir, "task-history.json"));

  const latest = await readLatestTaskAndLedger(home, goalId);
  if (latest.taskPath) await copyIfExists(latest.taskPath, path.join(dir, "latest-task.json"));
  if (latest.ledgerPath) await copyIfExists(latest.ledgerPath, path.join(dir, "latest-ledger.json"));

  const workspaceFiles = await listWorkspaceFiles(cwd);
  await writeJson(path.join(dir, "workspace-files.json"), workspaceFiles);
  await writeJson(path.join(scenarioDir, "latest-snapshot.json"), {
    label,
    goalId,
    latestTask: latest.task?.id ?? null,
    latestTaskStatus: latest.task?.status ?? null,
    latestLedgerEvent: latest.ledger?.summary?.latest_event_type ?? null,
    workspaceFiles,
    capturedAt: new Date().toISOString(),
  });
}

async function readLatestTaskAndLedger(home, goalId) {
  const taskDir = path.join(home, "tasks", goalId);
  const taskEntries = await readDirEntries(taskDir);
  const taskFiles = taskEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "task-history.json")
    .map((entry) => path.join(taskDir, entry.name));
  const sortedTasks = await sortPathsByMtimeDesc(taskFiles);
  const taskPath = sortedTasks[0] ?? null;
  const task = taskPath ? await readJsonOrNull(taskPath) : null;

  const ledgerDir = path.join(taskDir, "ledger");
  const ledgerEntries = await readDirEntries(ledgerDir);
  const ledgerFiles = ledgerEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(ledgerDir, entry.name));
  const sortedLedgers = await sortPathsByMtimeDesc(ledgerFiles);
  const ledgerPath = task?.id
    ? path.join(ledgerDir, `${task.id}.json`)
    : sortedLedgers[0] ?? null;
  const ledger = ledgerPath ? await readJsonOrNull(ledgerPath) : null;
  const taskHistoryPath = path.join(taskDir, "task-history.json");
  const rawTaskHistory = await readJsonOrNull(taskHistoryPath);
  const taskHistory = Array.isArray(rawTaskHistory) ? rawTaskHistory : [];

  const workspaceFiles = task?.goal_id ? [] : [];
  return { task, taskPath, ledger, ledgerPath, taskHistory, workspaceFiles };
}

async function writeWorkspace(workspace, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(workspace, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf8");
  }
}

async function listWorkspaceFiles(workspace) {
  const result = [];
  async function walk(dir) {
    const entries = await readDirEntries(dir);
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const rel = path.relative(workspace, fullPath);
      if (rel.startsWith(".git") || rel.includes(`${path.sep}.git${path.sep}`)) continue;
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const stat = await fs.stat(fullPath);
        result.push({
          path: rel,
          size: stat.size,
          mtime: stat.mtime.toISOString(),
        });
      }
    }
  }
  await walk(workspace);
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

async function readDirEntries(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function sortPathsByMtimeDesc(paths) {
  const withStats = [];
  for (const item of paths) {
    try {
      const stat = await fs.stat(item);
      withStats.push({ item, mtime: stat.mtimeMs });
    } catch {
      // skip
    }
  }
  return withStats.sort((a, b) => b.mtime - a.mtime).map((entry) => entry.item);
}

async function copyIfExists(src, dest) {
  try {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
  } catch {
    // best-effort evidence
  }
}

async function readJsonOrNull(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, value, "utf8");
}

async function appendLog(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.appendFile(filePath, `[${new Date().toISOString()}] ${value}`, "utf8");
}

async function runCli(cliPath, args, opts) {
  return runCommand(process.execPath, [cliPath, ...args], opts);
}

async function runCommand(command, args, opts) {
  const {
    cwd,
    env,
    logFile,
    timeoutMs = 120_000,
    allowFailure = false,
  } = opts;
  await appendLog(logFile, `$ ${command} ${args.map(shellQuote).join(" ")}\n`);
  const result = await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killChild(child, "SIGTERM");
      setTimeout(() => killChild(child, "SIGKILL"), 5_000).unref();
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: `${stderr}${error.message}`, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : code ?? 1, stdout, stderr, timedOut });
    });
  });
  await appendLog(logFile, `exit=${result.code} timedOut=${result.timedOut}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}\n`);
  if (result.code !== 0 && !allowFailure) {
    await appendLog(logFile, `command failed: ${command} ${args.join(" ")}\n`);
  }
  return result;
}

function killChild(child, signal) {
  if (typeof child.pid !== "number") return;
  try {
    if (process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already exited
    }
  }
}

async function writeSummary(evidenceRoot, results, { partial }) {
  await writeJson(path.join(evidenceRoot, "summary.json"), {
    partial,
    updatedAt: new Date().toISOString(),
    results,
  });
  const lines = [
    "# Goal Canary Summary",
    "",
    `Updated: ${new Date().toISOString()}`,
    `Partial: ${partial}`,
    "",
    "| scenario | goal | task | state | classification | stop | evidence |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...results.map((result) => [
      result.scenario,
      result.goalId ?? "",
      result.taskId ?? "",
      result.finalState,
      result.classification,
      result.stopStatus,
      path.relative(evidenceRoot, result.scenarioDir),
    ].map((cell) => String(cell).replace(/\|/g, "\\|")).join(" | ")).map((row) => `| ${row} |`),
    "",
  ];
  await writeText(path.join(evidenceRoot, "summary.md"), `${lines.join("\n")}\n`);
}

function extractGoalId(output) {
  const match = output.match(/Goal ID:\s+([^\s]+)/);
  return match?.[1] ?? null;
}

function formatTimestamp(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "T",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function sanitize(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").slice(0, 120);
}

function shellQuote(value) {
  if (/^[a-zA-Z0-9_./:=@-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (isMainModule()) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exit(1);
  });
}

function isMainModule() {
  return process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
}
