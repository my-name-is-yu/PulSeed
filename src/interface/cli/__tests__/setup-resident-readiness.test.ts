import { describe, expect, it } from "vitest";
import {
  buildResidentReadinessReport,
  type ResidentReadinessBindingStatus,
} from "../commands/setup/resident-readiness.js";

describe("setup resident readiness helpers", () => {
  it("reports ready when daemon and Telegram runtime-control bindings are complete", () => {
    const report = buildResidentReadinessReport(
      {
        startDaemon: true,
        daemonPort: 41701,
        notificationConfig: null,
        gatewaySetup: null,
      },
      makeBindingStatus({
        daemon: { running: true, port: 41701, health: "ok" },
        channels: [{
          state: "active",
          configured: true,
          active: true,
          home_target: { channel: "telegram", target_id: "123" },
          runtime_control: { state: "allowed", allowed_count: 1 },
          recent_health: {
            inbound_at: "2026-05-10T00:01:00.000Z",
            outbound_at: "2026-05-10T00:02:00.000Z",
            last_error: null,
          },
        }],
      }),
      null
    );

    expect(report.state).toBe("ready");
    expect(report.checks.every((check) => check.ok)).toBe(true);
  });

  it("reports blocked when daemon readiness failed even if gateway checks are otherwise empty", () => {
    const report = buildResidentReadinessReport(
      {
        startDaemon: true,
        daemonPort: 41701,
        notificationConfig: null,
        gatewaySetup: null,
      },
      makeBindingStatus({
        daemon: { running: false, port: 0, health: "missing" },
      }),
      "Daemon did not respond on port 41701 within 10000ms."
    );

    expect(report.state).toBe("blocked");
    expect(report.checks).toContainEqual(expect.objectContaining({
      name: "daemon",
      ok: false,
      recovery: "pulseed daemon start --detach",
    }));
  });
});

function makeBindingStatus(overrides: {
  daemon?: ResidentReadinessBindingStatus["daemon"];
  channels?: Array<Partial<ResidentReadinessBindingStatus["channels"][number]> & {
    active?: boolean;
    config_path?: string;
    identity_key?: string | null;
    default_goal_id?: string | null;
    goal_bindings?: unknown[];
    access?: { allow_all: boolean; allowed_count: number };
    health?: { daemon_running: boolean; gateway: string; checked_at: number | null };
    warnings?: string[];
  }>;
}): ResidentReadinessBindingStatus {
  return {
    daemon: overrides.daemon ?? { running: false, port: 0, health: "missing" },
    channels: (overrides.channels ?? []).map((channel) => ({
      name: channel.name ?? "telegram-bot",
      state: channel.state ?? "missing",
      configured: channel.configured ?? false,
      degraded: channel.degraded ?? false,
      home_target: channel.home_target ?? null,
      runtime_control: channel.runtime_control ?? { state: "unsupported", allowed_count: 0 },
      recent_health: channel.recent_health ?? { inbound_at: null, outbound_at: null, last_error: null },
    })),
  };
}
