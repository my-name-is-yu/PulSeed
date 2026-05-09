import { parseArgs } from "node:util";
import { ScheduleEngine } from "../../../runtime/schedule/engine.js";
import type { StateManager } from "../../../base/state/state-manager.js";
import type { CharacterConfigManager } from "../../../platform/traits/character-config.js";
import {
  buildSchedulePresetEntry,
  listSchedulePresetDefinitions,
  type SchedulePresetInput,
} from "../../../runtime/schedule/presets.js";
import { DreamScheduleSuggestionStore } from "../../../platform/dream/dream-schedule-suggestions.js";
import type { HeartbeatConfig, ScheduleTriggerInput } from "../../../runtime/types/schedule.js";
import { scheduleEdit } from "./schedule/edit.js";
import { scheduleCost } from "./schedule/cost.js";
import { scheduleHistory } from "./schedule/history.js";
import { scheduleRunNow } from "./schedule/run-now.js";
import { getScheduleOrPrintError, parsePositiveInteger } from "./schedule/shared.js";
import { parseExactFiniteNumber } from "./exact-number.js";

export async function cmdSchedule(
  stateManager: StateManager,
  argv: string[],
  characterConfigManager?: CharacterConfigManager,
): Promise<number> {
  const subcommand = argv[0];
  const baseDir = stateManager.getBaseDir();
  const engine = new ScheduleEngine({ baseDir });
  await engine.loadEntries();

  switch (subcommand) {
    case "list":
      scheduleListWithArgs(engine, argv.slice(1));
      return 0;
    case "show":
    case "get":
      scheduleShow(engine, argv.slice(1));
      return 0;
    case "add":
      return await scheduleAdd(engine, argv.slice(1));
    case "edit":
    case "update":
      await scheduleEdit(engine, argv.slice(1));
      return 0;
    case "pause":
    case "disable":
      await scheduleSetEnabled(engine, argv.slice(1), false);
      return 0;
    case "resume":
    case "enable":
      await scheduleSetEnabled(engine, argv.slice(1), true);
      return 0;
    case "run":
    case "run-now":
      await scheduleRunNow(stateManager, characterConfigManager, engine, argv.slice(1));
      return 0;
    case "history":
      await scheduleHistory(engine, argv.slice(1));
      return 0;
    case "cost":
      return await scheduleCost(engine, argv.slice(1));
    case "remove":
      await scheduleRemove(engine, argv.slice(1));
      return 0;
    case "presets":
      schedulePresetList();
      return 0;
    case "suggestions":
      await scheduleSuggestions(baseDir, engine, argv.slice(1));
      return 0;
    default:
      console.log("Usage: pulseed schedule <list|show|add|edit|pause|resume|run|history|cost|remove|presets|suggestions>");
      console.log("  list [--all]                      List schedule entries (internal wait schedules hidden by default)");
      console.log("  show <id>                         Show one schedule entry as JSON");
      console.log("  add                               Add a heartbeat entry or preset");
      console.log("  edit <id>                         Edit name, trigger, enabled state, or layer config");
      console.log("  pause <id>                        Disable a schedule entry without deleting it");
      console.log("  resume <id>                       Re-enable a paused schedule entry");
      console.log("  run <id>                          Run a schedule entry immediately");
      console.log("  history <id> [--limit <n>]        Show recent execution history");
      console.log("  cost [--period <7d|24h|2w>]       Show schedule token usage for a period");
      console.log("  remove <id>                       Remove a schedule entry");
      console.log("  presets                           List reusable schedule presets");
      console.log("  suggestions <list|apply|reject|dismiss>  Review dream-generated suggestions");
      return 1;
  }
}

function scheduleListWithArgs(engine: ScheduleEngine, argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      all: { type: "boolean", default: false },
      internal: { type: "boolean", default: false },
    },
    strict: false,
  });
  const includeInternal = values.all || values.internal;
  const allEntries = engine.getEntries();
  const entries = includeInternal
    ? allEntries
    : allEntries.filter((entry) => entry.metadata?.internal !== true);
  if (entries.length === 0) {
    console.log("No schedule entries.");
    return;
  }
  for (const entry of entries) {
    const status = entry.enabled ? "enabled" : "disabled";
    const schedule = entry.trigger.type === "cron"
      ? entry.trigger.expression
      : `every ${entry.trigger.seconds}s`;
    const lastFired = entry.last_fired_at ?? "never";
    const source = entry.metadata?.source
      ? `${entry.metadata.source}${entry.metadata.preset_key ? `:${entry.metadata.preset_key}` : ""}`
      : "manual";
    console.log(
      `  ${entry.id.slice(0, 8)}  [${entry.layer}] ${entry.name}  (${schedule})  ${status}  source: ${source}  last: ${lastFired}`
    );
  }
  if (!includeInternal) {
    const hiddenCount = allEntries.length - entries.length;
    if (hiddenCount > 0) {
      console.log(`  (${hiddenCount} internal schedule entr${hiddenCount === 1 ? "y" : "ies"} hidden; use --all to show)`);
    }
  }
}

function scheduleShow(engine: ScheduleEngine, argv: string[]): void {
  const entry = getScheduleOrPrintError(engine, argv[0]);
  if (!entry) return;
  if (entry.metadata?.internal === true && entry.metadata.activation_kind === "wait_resume") {
    console.log(JSON.stringify({
      ...entry,
      internal_projection: {
        kind: "wait_resume",
        goal_id: entry.metadata.goal_id ?? entry.goal_trigger?.goal_id ?? null,
        strategy_id: entry.metadata.strategy_id ?? null,
        wait_strategy_id: entry.metadata.wait_strategy_id ?? null,
      },
    }, null, 2));
    return;
  }
  console.log(JSON.stringify(entry, null, 2));
}

async function scheduleSetEnabled(engine: ScheduleEngine, argv: string[], enabled: boolean): Promise<void> {
  const entry = getScheduleOrPrintError(engine, argv[0]);
  if (!entry) return;
  const updated = await engine.updateEntry(entry.id, { enabled });
  if (!updated) {
    console.error(`No schedule entry found matching: ${argv[0]}`);
    return;
  }
  console.log(`${enabled ? "Resumed" : "Paused"} schedule entry: ${updated.id} (${updated.name})`);
}

function parseScheduleAddInteger(value: unknown, label: string): number {
  return parsePositiveInteger(typeof value === "string" ? value : undefined, label);
}

function parseScheduleAddString(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return normalized;
}

function parseScheduleThresholdValue(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error("--threshold-value must be a finite number");
  }
  const parsed = parseExactFiniteNumber(value);
  if (parsed === null) {
    throw new Error("--threshold-value must be a finite number");
  }
  return parsed;
}

function resolveOptionalTrigger(values: { cron?: string; interval?: unknown }): ScheduleTriggerInput | undefined {
  if (values.cron) {
    return { type: "cron", expression: values.cron, timezone: "UTC" };
  }
  if (values.interval !== undefined) {
    return { type: "interval", seconds: parseScheduleAddInteger(values.interval, "--interval"), jitter_factor: 0 };
  }
  return undefined;
}

function buildHeartbeatConfigFromAddArgs(
  values: ReturnType<typeof parseArgs>["values"]
): HeartbeatConfig {
  const failure_threshold = parseScheduleAddInteger(values.threshold, "--threshold");
  const timeout_ms = 5000;
  switch (values.type) {
    case "http":
      return {
        check_type: "http",
        check_config: { url: parseScheduleAddString(values.url, "--url") },
        failure_threshold,
        timeout_ms,
      };
    case "tcp":
      return {
        check_type: "tcp",
        check_config: {
          host: parseScheduleAddString(values.host, "--host"),
          port: parseScheduleAddInteger(values.port, "--port"),
        },
        failure_threshold,
        timeout_ms,
      };
    case "process":
      return {
        check_type: "process",
        check_config: { pid: parseScheduleAddInteger(values.pid, "--pid") },
        failure_threshold,
        timeout_ms,
      };
    case "disk":
      return {
        check_type: "disk",
        check_config: { path: parseScheduleAddString(values.path, "--path") },
        failure_threshold,
        timeout_ms,
      };
    case "custom":
      return {
        check_type: "custom",
        check_config: { command: parseScheduleAddString(values.command, "--command") },
        failure_threshold,
        timeout_ms,
      };
    default:
      throw new Error(`Unknown heartbeat check type: ${String(values.type)}`);
  }
}

function buildPresetInput(values: Record<string, unknown>): SchedulePresetInput {
  const preset = String(values.preset ?? "");
  const trigger = resolveOptionalTrigger({
    cron: typeof values.cron === "string" ? values.cron : undefined,
    interval: values.interval,
  });
  const common = {
    preset,
    name: typeof values.name === "string" ? values.name : undefined,
    enabled: true,
    ...(trigger ? { trigger } : {}),
  };

  switch (preset) {
    case "daily_brief":
    case "weekly_review":
    case "dream_consolidation":
      return {
        ...common,
        preset,
        context_sources: Array.isArray(values["context-source"])
          ? (values["context-source"] as string[])
          : typeof values["context-source"] === "string"
            ? [values["context-source"] as string]
            : [],
      };
    case "soil_publish":
      return {
        ...common,
        preset: "soil_publish",
      };
    case "goal_probe":
      if (typeof values["data-source-id"] !== "string" || values["data-source-id"].length === 0) {
        throw new Error("--data-source-id is required for the goal_probe preset");
      }
      return {
        ...common,
        preset: "goal_probe",
        data_source_id: values["data-source-id"] as string,
        probe_dimension: typeof values["probe-dimension"] === "string"
          ? values["probe-dimension"] as string
          : undefined,
        query_params: {},
        detector_mode: (typeof values["detector-mode"] === "string"
          ? values["detector-mode"]
          : "diff") as "threshold" | "diff" | "presence",
        threshold_value: parseScheduleThresholdValue(values["threshold-value"]),
        baseline_window: typeof values["baseline-window"] === "string"
          ? parseScheduleAddInteger(values["baseline-window"], "--baseline-window")
          : 5,
        llm_on_change: values["llm-on-change"] !== false,
        llm_prompt_template: typeof values["llm-prompt-template"] === "string"
          ? values["llm-prompt-template"] as string
          : undefined,
      };
    default:
      throw new Error(`Unknown preset: ${preset}`);
  }
}

async function scheduleAdd(engine: ScheduleEngine, argv: string[]): Promise<number> {
  let values: ReturnType<typeof parseArgs>["values"];
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        name: { type: "string" },
        preset: { type: "string" },
        type: { type: "string", default: "http" },
        url: { type: "string" },
        host: { type: "string" },
        port: { type: "string" },
        pid: { type: "string" },
        path: { type: "string" },
        command: { type: "string" },
        cron: { type: "string" },
        interval: { type: "string" },
        threshold: { type: "string", default: "3" },
        "data-source-id": { type: "string" },
        "detector-mode": { type: "string" },
        "threshold-value": { type: "string" },
        "baseline-window": { type: "string" },
        "probe-dimension": { type: "string" },
        "llm-on-change": { type: "boolean", default: true },
        "llm-prompt-template": { type: "string" },
        "context-source": { type: "string", multiple: true },
      },
      strict: false,
    }));
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    return 1;
  }

  try {
    if (values.preset) {
      const presetInput = buildPresetInput(values);
      const entry = await engine.addEntry(buildSchedulePresetEntry(presetInput));
      console.log(`Added preset schedule entry: ${entry.id} (${entry.name})`);
      return 0;
    }

    if (!values.name) {
      console.error("Error: --name is required");
      return 1;
    }

    const trigger = values.cron
      ? { type: "cron" as const, expression: values.cron as string, timezone: "UTC" }
      : {
        type: "interval" as const,
        seconds: values.interval !== undefined ? parseScheduleAddInteger(values.interval, "--interval") : 60,
        jitter_factor: 0,
      };

    const entry = await engine.addEntry({
      name: values.name as string,
      layer: "heartbeat",
      trigger,
      enabled: true,
      metadata: {
        source: "manual",
        dependency_hints: [],
      },
      heartbeat: buildHeartbeatConfigFromAddArgs(values),
    });

    console.log(`Added schedule entry: ${entry.id} (${entry.name})`);
    return 0;
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    return 1;
  }
}

async function scheduleRemove(engine: ScheduleEngine, argv: string[]): Promise<void> {
  const match = getScheduleOrPrintError(engine, argv[0]);
  if (!match) return;
  await engine.removeEntry(match.id);
  console.log(`Removed schedule entry: ${match.id} (${match.name})`);
}

function schedulePresetList(): void {
  const definitions = listSchedulePresetDefinitions();
  for (const definition of definitions) {
    const trigger = definition.defaultTrigger.type === "cron"
      ? definition.defaultTrigger.expression
      : `every ${definition.defaultTrigger.seconds}s`;
    console.log(`${definition.key}`);
    console.log(`  ${definition.description}`);
    console.log(`  default trigger: ${trigger}`);
    console.log(`  dependencies: ${definition.dependencyHints.join(", ") || "none"}`);
  }
}

async function scheduleSuggestions(
  baseDir: string,
  engine: ScheduleEngine,
  argv: string[],
): Promise<void> {
  const store = new DreamScheduleSuggestionStore(baseDir);
  const action = argv[0] ?? "list";

  switch (action) {
    case "list": {
      const suggestions = await store.list();
      if (suggestions.length === 0) {
        console.log("No dream schedule suggestions.");
        return;
      }
      for (const suggestion of suggestions) {
        console.log(
          `  ${suggestion.id.slice(0, 8)}  [${suggestion.status}] ${suggestion.type}  goal=${suggestion.goalId ?? "-"}  proposal=${suggestion.proposal}`
        );
        console.log(`    ${suggestion.reason}`);
        if (suggestion.applied_entry_id) {
          console.log(`    applied entry: ${suggestion.applied_entry_id}`);
        }
      }
      return;
    }
    case "apply": {
      const id = argv[1];
      if (!id) {
        console.error("Error: dream suggestion ID is required");
        return;
      }
      const { entry, duplicate } = await store.applySuggestion(id, engine);
      console.log(
        duplicate
          ? `Matched existing schedule entry: ${entry.id} (${entry.name})`
          : `Applied dream suggestion to schedule entry: ${entry.id} (${entry.name})`
      );
      return;
    }
    case "reject":
    case "dismiss": {
      const id = argv[1];
      if (!id) {
        console.error("Error: dream suggestion ID is required");
        return;
      }
      const reason = argv.slice(2).join(" ").trim() || undefined;
      const suggestion = await store.markDecision(id, action === "reject" ? "rejected" : "dismissed", reason);
      console.log(`Marked dream suggestion ${suggestion.id} as ${suggestion.status}`);
      return;
    }
    default:
      console.error("Usage: pulseed schedule suggestions <list|apply|reject|dismiss> [id]");
  }
}
