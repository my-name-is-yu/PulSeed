import * as p from "@clack/prompts";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { getPulseedDirPath } from "../../../base/utils/paths.js";
import { isDaemonRunning } from "../../../runtime/daemon/client.js";
import { PIDManager } from "../../../runtime/pid-manager.js";
import {
  saveGatewayChannels,
  stepGatewayChannels,
} from "./setup/steps-gateway.js";
import { guardCancel } from "./setup/utils.js";

export async function cmdGateway(argv: string[]): Promise<number> {
  const subcommand = argv[0];
  if (subcommand === "setup") {
    return cmdGatewaySetup(argv.slice(1));
  }

  console.error(`Unknown gateway subcommand: "${subcommand ?? ""}"`);
  console.error("Available: gateway setup");
  return 1;
}

export async function cmdGatewaySetup(_argv: string[]): Promise<number> {
  const baseDir = getPulseedDirPath();
  p.intro("PulSeed Gateway Setup");

  const setup = await stepGatewayChannels(baseDir);
  if (!setup) {
    p.outro("No gateway changes made.");
    return 0;
  }

  const savedPaths = await saveGatewayChannels(baseDir, setup);
  p.note(setup.selectedChannels.join(", "), "Updated channels");
  if (savedPaths.length > 0) {
    p.log.info(`Saved ${savedPaths.length} gateway config file${savedPaths.length === 1 ? "" : "s"}.`);
  }

  await maybeRestartDaemonForGatewayChanges(baseDir);
  p.outro("Gateway setup complete.");
  return 0;
}

async function maybeRestartDaemonForGatewayChanges(baseDir: string): Promise<void> {
  const daemonConfigPath = path.join(baseDir, "daemon.json");
  const { running } = await isDaemonRunning(baseDir);
  if (running) {
    const restart = guardCancel(
      await p.confirm({
        message: "Restart the daemon now to apply gateway changes?",
        initialValue: true,
      })
    );
    if (!restart) return;
    await restartDaemon(baseDir);
    return;
  }

  if (!fs.existsSync(daemonConfigPath)) {
    p.log.info("Gateway configs were saved. Run `pulseed setup` or `pulseed daemon start` when you are ready.");
    return;
  }

  const start = guardCancel(
    await p.confirm({
      message: "Start the daemon now so the gateway comes online?",
      initialValue: true,
    })
  );
  if (!start) return;
  await startDaemon(baseDir);
}

async function restartDaemon(baseDir: string): Promise<void> {
  const pidManager = new PIDManager(baseDir);
  const stopResult = await pidManager.stopRuntime({ timeoutMs: 10_000 });
  if (!stopResult.stopped) {
    p.log.warn("Could not stop the existing daemon cleanly. Continuing with a fresh start attempt.");
  }
  await startDaemon(baseDir);
}

async function startDaemon(baseDir: string): Promise<void> {
  p.log.info("Starting daemon and gateway...");
  const pid = await startDaemonDetached(baseDir);
  try {
    await waitForDaemonReady(baseDir);
    p.log.success(`Daemon and gateway started${pid ? ` (PID: ${pid})` : ""}.`);
  } catch (err) {
    p.log.warn(
      `Gateway config saved, but daemon/gateway did not become ready: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

async function startDaemonDetached(baseDir: string): Promise<number | undefined> {
  const scriptPath = process.argv[1];
  if (!scriptPath) {
    throw new Error("Could not determine CLI entrypoint for daemon start.");
  }

  const child = spawn(process.execPath, [scriptPath, "daemon", "start", "--detach"], {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      PULSEED_HOME: baseDir,
    },
  });

  await new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
  child.unref();
  return child.pid;
}

async function waitForDaemonReady(baseDir: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { running } = await isDaemonRunning(baseDir);
    if (running) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Daemon did not respond within ${timeoutMs}ms.`);
}
