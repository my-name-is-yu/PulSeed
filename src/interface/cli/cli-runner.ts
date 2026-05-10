#!/usr/bin/env node
// ─── CLIRunner ───
//
// PulSeed CLI entry point. Wires all dependencies and exposes subcommands:
//   pulseed run --goal <id>            Run DurableLoop once for a given goal
//   pulseed goal add "<description>"   Negotiate and register a new goal (interactive)
//   pulseed goal list                  List all registered goals
//   pulseed goal archive <id>          Archive a completed goal
//   pulseed goal show <id>             Show goal details
//   pulseed goal reset <id>            Reset goal state for re-running
//   pulseed status --goal <id>         Show current progress report
//   pulseed report --goal <id>         Show latest report
//   pulseed log --goal <id>            View execution/observation log
//   pulseed start --goal <id>          Start daemon mode for one or more goals
//   pulseed stop                       Stop the running daemon
//   pulseed cron --goal <id>           Print crontab entry for a goal
//   pulseed schedule list              List schedule entries
//   pulseed schedule pause <id>        Pause a schedule entry
//   pulseed schedule resume <id>       Resume a paused schedule entry
//   pulseed schedule run <id>          Run a schedule entry immediately
//   pulseed cleanup                    Archive all completed goals and remove stale data
//   pulseed improve [path]             Analyze, suggest goals, and run improvement loop
//   pulseed suggest "<context>"        Suggest improvement goals for a project
//   pulseed capability list            List all registered capabilities
//   pulseed capability remove <name>   Remove a capability by name
//   pulseed knowledge list             List all shared knowledge entries
//   pulseed knowledge search <query>   Search knowledge entries by keyword
//   pulseed knowledge stats            Show knowledge base statistics
//   pulseed task list --goal <id>      List tasks for a goal
//   pulseed task show <taskId> --goal <id>  Show task details

import { getCliLogger } from "./cli-logger.js";
import { StateManager } from "../../base/state/state-manager.js";
import { CharacterConfigManager } from "../../platform/traits/character-config.js";
import type { DurableLoop } from "../../orchestrator/loop/durable-loop.js";
import { dispatchCommand } from "./cli-command-registry.js";
import { formatOperationError, printUsage } from "./utils.js";
import { getPulseedVersion } from "../../base/utils/pulseed-meta.js";

const logger = getCliLogger();

const STATELESS_GLOBAL_FLAGS = new Set(["--yes", "-y", "--dev"]);

function stripStatelessGlobalFlags(argv: readonly string[]): string[] {
  return argv.filter((arg) => !STATELESS_GLOBAL_FLAGS.has(arg));
}

function isTopLevelHelpRequest(argv: readonly string[]): boolean {
  const args = stripStatelessGlobalFlags(argv);
  return args.length === 1 && (args[0] === "--help" || args[0] === "-h" || args[0] === "help");
}

function isHelpToken(arg: string | undefined): boolean {
  return arg === "--help" || arg === "-h" || arg === "help";
}

function includesHelpFlag(args: readonly string[]): boolean {
  return args.some((arg) => isHelpToken(arg));
}

function isParentHelpRequest(args: readonly string[], parent: "telegram" | "gateway"): boolean {
  return args[0] === parent && (args.length === 1 || (args.length === 2 && isHelpToken(args[1])));
}

function getStatelessSetupHelpRequest(
  argv: readonly string[]
): { kind: "setup" | "telegram" | "telegram_setup" | "gateway" | "gateway_setup"; args: string[] } | null {
  const args = stripStatelessGlobalFlags(argv);
  if (args[0] === "setup" && includesHelpFlag(args.slice(1))) {
    return { kind: "setup", args: args.slice(1) };
  }
  if (isParentHelpRequest(args, "telegram")) {
    return { kind: "telegram", args: args.slice(1) };
  }
  if (args[0] === "telegram" && args[1] === "setup" && includesHelpFlag(args.slice(2))) {
    return { kind: "telegram_setup", args: args.slice(2) };
  }
  if (isParentHelpRequest(args, "gateway")) {
    return { kind: "gateway", args: args.slice(1) };
  }
  if (args[0] === "gateway" && args[1] === "setup" && includesHelpFlag(args.slice(2))) {
    return { kind: "gateway_setup", args: args.slice(2) };
  }
  return null;
}

function isDefaultTuiLaunchRequest(argv: readonly string[]): boolean {
  const args = stripStatelessGlobalFlags(argv);
  return args.length === 0 || (args.length === 1 && args[0] === "tui");
}

// ─── CLIRunner ───

/**
 * @description Coordinates CLI argument parsing, dependency wiring, and subcommand execution for the PulSeed command-line interface.
 */
export class CLIRunner {
  private readonly stateManager: StateManager;
  private readonly characterConfigManager: CharacterConfigManager;
  private activeDurableLoop: DurableLoop | null = null;

  /**
   * @description Creates a CLI runner with state and character configuration managers rooted at the optional base directory.
   * @param {string} [baseDir] Optional base directory for PulSeed state storage.
   * @returns {void} Does not return a value.
   */
  constructor(baseDir?: string) {
    this.stateManager = new StateManager(baseDir);
    this.characterConfigManager = new CharacterConfigManager(this.stateManager);
  }

  /**
   * @description Initialises the state directory structure. Must be awaited before issuing any subcommands.
   * @returns {Promise<void>}
   */
  async init(): Promise<void> {
    await this.stateManager.init();
  }

  /**
   * @description Stops the active DurableLoop if one is currently running. Safe to call before `run()` or when no loop is active.
   * @returns {void} Does not return a value.
   */
  stop(): void {
    if (this.activeDurableLoop) {
      this.activeDurableLoop.stop();
    }
  }

  // ─── Main dispatch ───

  /**
   * @description Parses CLI arguments, dispatches the matching PulSeed subcommand, and returns the resulting exit code.
   * @param {string[]} argv Raw subcommand arguments, excluding the `node` executable and script path.
   * @returns {Promise<number>} A promise that resolves to `0` for success, `1` for errors, or `2` for stall escalation.
   */
  async run(argv: string[]): Promise<number> {
    if (argv.includes("--version") || argv.includes("-v")) {
      console.log(getPulseedVersion(import.meta.url));
      return 0;
    }
    if (isTopLevelHelpRequest(argv)) {
      printUsage();
      return 0;
    }
    const statelessSetupHelp = getStatelessSetupHelpRequest(argv);
    if (statelessSetupHelp !== null) {
      if (statelessSetupHelp.kind === "setup") {
        const { cmdSetup } = await import("./commands/setup.js");
        return cmdSetup(statelessSetupHelp.args);
      }
      if (statelessSetupHelp.kind === "telegram_setup") {
        const { cmdTelegramSetup } = await import("./commands/telegram.js");
        return cmdTelegramSetup(statelessSetupHelp.args);
      }
      if (statelessSetupHelp.kind === "telegram") {
        const { cmdTelegram } = await import("./commands/telegram.js");
        return cmdTelegram(statelessSetupHelp.args);
      }
      if (statelessSetupHelp.kind === "gateway") {
        const { cmdGateway } = await import("./commands/gateway.js");
        return cmdGateway(statelessSetupHelp.args);
      }
      const { cmdGatewaySetup } = await import("./commands/gateway.js");
      return cmdGatewaySetup(statelessSetupHelp.args);
    }

    try {
      await this.init();
    } catch (err) {
      if (isDefaultTuiLaunchRequest(argv)) {
        logger.error("PulSeed could not open local runtime state before launching the TUI.");
        logger.error(formatOperationError("initialize CLI state", err));
        printUsage();
        return 1;
      }
      throw err;
    }

    // Extract --yes / -y and --dev globally so they work regardless of position
    let globalYes = false;
    const filteredArgv: string[] = [];
    for (const arg of argv) {
      if (arg === "--yes" || arg === "-y") {
        globalYes = true;
      } else if (arg === "--dev") {
        process.env["PULSEED_DEV"] = "1";
      } else {
        filteredArgv.push(arg);
      }
    }

    const activeDurableLoopRef = { value: this.activeDurableLoop };
    const result = await dispatchCommand(
      filteredArgv,
      globalYes,
      this.stateManager,
      this.characterConfigManager,
      activeDurableLoopRef,
    );
    this.activeDurableLoop = activeDurableLoopRef.value;
    return result;
  }
}

// ─── Entry point (when run directly as a binary) ───

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const runner = new CLIRunner();
  try {
    const code = await runner.run(argv);
    process.exit(code);
  } catch (err) {
    logger.error(formatOperationError("execute CLI entry point", err));
    process.exit(1);
  }
}

import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

const isMain = (() => {
  if (typeof process === "undefined" || !process.argv[1]) return false;
  try {
    const thisFile = realpathSync(fileURLToPath(import.meta.url));
    const entryFile = realpathSync(process.argv[1]);
    return thisFile === entryFile;
  } catch (err) {
    logger.error(formatOperationError("resolve CLI entry point path", err));
    return false;
  }
})();

if (isMain) {
  main();
}
