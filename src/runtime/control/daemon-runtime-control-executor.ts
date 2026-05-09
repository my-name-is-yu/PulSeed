import { DaemonClient, isDaemonRunning } from "../daemon/client.js";
import type {
  RuntimeControlExecutor,
  RuntimeControlExecutorResult,
} from "./runtime-control-service.js";
import { runtimeControlRestartRequestedMessage } from "./runtime-control-messages.js";

export interface DaemonRuntimeControlExecutorOptions {
  baseDir: string;
  host?: string;
}

export function createDaemonRuntimeControlExecutor(
  options: DaemonRuntimeControlExecutorOptions
): RuntimeControlExecutor {
  return async (operation): Promise<RuntimeControlExecutorResult> => {
    if (
      operation.kind !== "restart_daemon"
      && operation.kind !== "restart_gateway"
      && operation.kind !== "pause_run"
      && operation.kind !== "resume_run"
      && operation.kind !== "cancel_run"
    ) {
      return {
        ok: false,
        state: "failed",
        message: `Runtime control operation ${operation.kind} is not implemented yet.`,
      };
    }

    const daemonInfo = await isDaemonRunning(options.baseDir);
    if (!daemonInfo.running) {
      return {
        ok: false,
        state: "failed",
        message: "PulSeed daemon is not running; restart was not requested.",
      };
    }

    const client = new DaemonClient({
      host: options.host ?? "127.0.0.1",
      port: daemonInfo.port,
      authToken: daemonInfo.authToken,
      baseDir: options.baseDir,
    });

    if (operation.kind === "pause_run" || operation.kind === "resume_run" || operation.kind === "cancel_run") {
      const goalId = operation.target?.goal_id;
      if (!goalId) {
        return {
          ok: false,
          state: "blocked",
          message: `Runtime control operation ${operation.kind} is blocked because no goal bridge was resolved.`,
        };
      }
      const response = operation.kind === "pause_run"
        ? await client.pauseGoal(goalId)
        : operation.kind === "resume_run"
          ? await client.resumeGoal(goalId)
          : await client.stopGoal(goalId);
      if (!response.ok) {
        return {
          ok: false,
          state: "failed",
          message: `PulSeed daemon rejected ${operation.kind} for goal ${goalId}.`,
        };
      }
      return {
        ok: true,
        state: "running",
        message: operation.kind === "pause_run"
          ? `Safe-pause request for ${operation.target?.run_id ?? goalId} was sent through the typed daemon API.`
          : operation.kind === "resume_run"
            ? `Resume request for ${operation.target?.run_id ?? goalId} was sent through the typed daemon API.`
            : `Cancel request for ${operation.target?.run_id ?? goalId} was sent through the typed daemon API.`,
      };
    }

    const response = await client.requestRuntimeControl({
      operationId: operation.operation_id,
      kind: operation.kind,
      reason: operation.reason,
    });

    if (!response.ok) {
      return {
        ok: false,
        state: "failed",
        message: "PulSeed daemon rejected the runtime control request.",
      };
    }

    return {
      ok: true,
      state: "restarting",
      message: runtimeControlRestartRequestedMessage(operation.kind),
    };
  };
}
