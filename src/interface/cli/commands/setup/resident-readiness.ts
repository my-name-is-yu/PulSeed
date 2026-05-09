import * as p from "@clack/prompts";

export type ResidentReadinessState = "ready" | "partial" | "blocked";

export interface ResidentReadinessAnswers {
  startDaemon: boolean;
  daemonPort: number;
  notificationConfig: unknown | null;
  gatewaySetup: unknown | null;
}

export interface ResidentReadinessReport {
  state: ResidentReadinessState;
  checks: Array<{ name: string; ok: boolean; detail: string; recovery?: string }>;
}

export interface ResidentReadinessBindingStatus {
  daemon: {
    running: boolean;
    port: number;
    health: string;
  };
  channels: Array<{
    name: string;
    state: string;
    configured: boolean;
    degraded: boolean;
    home_target: unknown | null;
    runtime_control: {
      state: string;
      allowed_count: number;
    };
    recent_health: {
      inbound_at: string | null;
      outbound_at: string | null;
      last_error: string | null;
    };
  }>;
}

export function buildResidentReadinessReport(
  answers: ResidentReadinessAnswers,
  status: ResidentReadinessBindingStatus,
  daemonStartupError: string | null
): ResidentReadinessReport {
  const configuredChannels = status.channels.filter((channel) => channel.configured);
  const checks: ResidentReadinessReport["checks"] = [];
  const daemonReady = status.daemon.running && status.daemon.health === "ok" && (!answers.startDaemon || status.daemon.port === answers.daemonPort);
  checks.push({
    name: "daemon",
    ok: daemonReady,
    detail: daemonStartupError ?? (daemonReady ? `daemon responding on port ${status.daemon.port} with ok health` : `daemon is not ready (running=${status.daemon.running}, port=${status.daemon.port || "-"}, health=${status.daemon.health})`),
    recovery: daemonReady ? undefined : "pulseed daemon start --detach",
  });
  checks.push({
    name: "gateway",
    ok: configuredChannels.length === 0 || configuredChannels.every((channel) => channel.state === "active"),
    detail: configuredChannels.length === 0
      ? "no messaging channels configured"
      : configuredChannels.map((channel) => `${channel.name}:${channel.state}`).join(", "),
    recovery: configuredChannels.some((channel) => channel.degraded) ? "pulseed gateway setup" : undefined,
  });
  checks.push({
    name: "notification routing",
    ok: answers.notificationConfig !== null || configuredChannels.some((channel) => channel.home_target !== null),
    detail: answers.notificationConfig !== null
      ? "notification config saved"
      : configuredChannels.some((channel) => channel.home_target !== null)
        ? "gateway home/default reply target available"
        : "no notification config or gateway home/default reply target",
    recovery: "pulseed notify add <slack|webhook|email> or send /sethome to the Telegram bot",
  });
  for (const channel of configuredChannels) {
    checks.push({
      name: `${channel.name} reply target`,
      ok: channel.home_target !== null,
      detail: channel.home_target ? "home/default reply target configured" : "missing home/default reply target",
      recovery: channel.name === "telegram-bot" ? "send /sethome to the Telegram bot" : "pulseed gateway setup",
    });
    checks.push({
      name: `${channel.name} runtime-control`,
      ok: channel.runtime_control.state === "allowed",
      detail: `${channel.runtime_control.allowed_count} runtime-control user/sender id(s) configured`,
      recovery: "pulseed gateway setup",
    });
    if (channel.name === "telegram-bot") {
      const roundTripOk = channel.recent_health.inbound_at !== null
        && channel.recent_health.outbound_at !== null
        && channel.recent_health.last_error === null;
      checks.push({
        name: "telegram-bot channel round trip",
        ok: roundTripOk,
        detail: roundTripOk
          ? `last inbound ${channel.recent_health.inbound_at}, last outbound ${channel.recent_health.outbound_at}`
          : `last inbound ${channel.recent_health.inbound_at ?? "-"}, last outbound ${channel.recent_health.outbound_at ?? "-"}, last error ${channel.recent_health.last_error ?? "-"}`,
        recovery: "send a message to the Telegram bot after daemon start",
      });
    }
  }
  const failed = checks.filter((check) => !check.ok);
  const state: ResidentReadinessState = daemonStartupError !== null || failed.some((check) => check.name === "daemon")
    ? "blocked"
    : failed.length > 0
      ? "partial"
      : "ready";
  return { state, checks };
}

export function printResidentReadinessReport(report: ResidentReadinessReport): void {
  const line = `Resident readiness: ${report.state}`;
  if (report.state === "ready") p.log.success(line);
  else if (report.state === "partial") p.log.warn(line);
  else p.log.error(line);
  for (const check of report.checks) {
    const prefix = check.ok ? "ok" : "failed";
    const recovery = !check.ok && check.recovery ? ` Recovery: ${check.recovery}` : "";
    p.log.info(`- ${prefix}: ${check.name} - ${check.detail}.${recovery}`);
  }
}
