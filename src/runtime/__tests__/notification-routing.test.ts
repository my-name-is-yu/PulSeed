import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { NotificationConfigSchema } from "../../base/types/notification.js";
import {
  applyNaturalLanguageNotificationRouting,
  applyNaturalLanguageNotificationRoutingToConfig,
  saveNotificationConfig,
  type NotificationRoutingDecision,
} from "../notification-routing.js";
import type { ILLMClient } from "../../base/llm/llm-client.js";

function llmDecision(decision: NotificationRoutingDecision): Pick<ILLMClient, "sendMessage" | "parseJSON"> {
  return {
    sendMessage: async () => ({
      content: JSON.stringify(decision),
      usage: { input_tokens: 0, output_tokens: 0 },
      stop_reason: "stop",
    }),
    parseJSON: ((content: string, schema: { parse: (value: unknown) => unknown }) =>
      schema.parse(JSON.parse(content))) as Pick<ILLMClient, "sendMessage" | "parseJSON">["parseJSON"],
  };
}

describe("notification routing natural language updates", () => {
  const tmpDirs: string[] = [];

  afterEach(() => {
    for (const dir of tmpDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes weekly reports only to Discord from a natural language instruction", async () => {
    const config = NotificationConfigSchema.parse({});

    const update = await applyNaturalLanguageNotificationRoutingToConfig(
      config,
      "週次レポートはDiscordだけに送って",
      {
        llmClient: llmDecision({
          action: "update_routes",
          selected_notifiers: ["discord-bot"],
          report_types: ["weekly_report"],
          mode: "only",
          enabled: true,
          confidence: 0.94,
          reason: "weekly report exclusive route",
        }),
      }
    );

    expect(update.applied).toBe(true);
    expect(update.config.plugin_notifiers.mode).toBe("only");
    expect(update.config.plugin_notifiers.routes).toEqual([
      {
        id: "discord-bot",
        enabled: true,
        report_types: ["weekly_report"],
      },
    ]);
  });

  it("disables one notifier while leaving plugin routing in all mode", async () => {
    const config = NotificationConfigSchema.parse({});

    const update = await applyNaturalLanguageNotificationRoutingToConfig(
      config,
      "WhatsAppには通知を送らない",
      {
        llmClient: llmDecision({
          action: "update_routes",
          selected_notifiers: ["whatsapp-webhook"],
          report_types: [],
          mode: "all",
          enabled: false,
          confidence: 0.91,
          reason: "disable selected notifier",
        }),
      }
    );

    expect(update.applied).toBe(true);
    expect(update.config.plugin_notifiers.mode).toBe("all");
    expect(update.config.plugin_notifiers.routes).toEqual([
      {
        id: "whatsapp-webhook",
        enabled: false,
        report_types: [],
      },
    ]);
  });

  it("can disable all plugin notifier delivery", async () => {
    const config = NotificationConfigSchema.parse({});

    const update = await applyNaturalLanguageNotificationRoutingToConfig(
      config,
      "プラグイン通知は全部止めて",
      {
        llmClient: llmDecision({
          action: "disable_all",
          selected_notifiers: [],
          report_types: [],
          mode: "none",
          enabled: false,
          confidence: 0.96,
          reason: "disable all plugin notifier delivery",
        }),
      }
    );

    expect(update.applied).toBe(true);
    expect(update.config.plugin_notifiers.mode).toBe("none");
  });

  it("applies a multilingual route change through structured parser output", async () => {
    const config = NotificationConfigSchema.parse({});

    const update = await applyNaturalLanguageNotificationRoutingToConfig(
      config,
      "Envía solamente las alertas urgentes por Telegram",
      {
        llmClient: llmDecision({
          action: "update_routes",
          selected_notifiers: ["telegram-bot"],
          report_types: ["urgent_alert", "approval_request"],
          mode: "only",
          enabled: true,
          confidence: 0.9,
          reason: "exclusive urgent notification route",
        }),
      }
    );

    expect(update.config.plugin_notifiers).toEqual({
      mode: "only",
      routes: [
        {
          id: "telegram-bot",
          enabled: true,
          report_types: ["urgent_alert", "approval_request"],
        },
      ],
    });
  });

  it("does not mutate config for ambiguous instructions", async () => {
    const config = NotificationConfigSchema.parse({
      plugin_notifiers: {
        mode: "all",
        routes: [{ id: "discord-bot", enabled: true, report_types: ["weekly_report"] }],
      },
    });

    const update = await applyNaturalLanguageNotificationRoutingToConfig(
      config,
      "いい感じに通知を調整して",
      {
        llmClient: llmDecision({
          action: "ambiguous",
          selected_notifiers: [],
          report_types: [],
          mode: null,
          enabled: null,
          confidence: 0.42,
          clarification: "Specify the notifier and report types to route.",
          reason: "missing route target",
        }),
      }
    );

    expect(update.applied).toBe(false);
    expect(update.config).toEqual(config);
    expect(update.summary).toContain("unchanged");
  });

  it("does not mutate config when the structured parser is unavailable", async () => {
    const config = NotificationConfigSchema.parse({});

    const update = await applyNaturalLanguageNotificationRoutingToConfig(
      config,
      "Send weekly reports to Slack"
    );

    expect(update.applied).toBe(false);
    expect(update.config).toEqual(config);
    expect(update.decision.action).toBe("unsupported");
  });

  it("does not overwrite an invalid notification config when applying a route", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-routing-invalid-"));
    tmpDirs.push(tmpDir);
    const configPath = path.join(tmpDir, "notification.json");
    const invalidJson = JSON.stringify({ channels: [{ type: "webhook", url: "not-a-url" }] });
    fs.writeFileSync(configPath, invalidJson, "utf-8");

    await expect(
      applyNaturalLanguageNotificationRouting("Discordだけ", configPath, {
        llmClient: llmDecision({
          action: "update_routes",
          selected_notifiers: ["discord-bot"],
          report_types: [],
          mode: "only",
          enabled: true,
          confidence: 0.9,
          reason: "exclusive discord route",
        }),
      })
    ).rejects.toThrow(/Invalid notification config/);

    expect(fs.readFileSync(configPath, "utf-8")).toBe(invalidJson);
  });

  it("validates notification config before persisting", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-routing-save-invalid-"));
    tmpDirs.push(tmpDir);
    const configPath = path.join(tmpDir, "notification.json");
    const invalidConfig = NotificationConfigSchema.parse({});
    invalidConfig.channels.push({
      type: "email",
      address: "user@example.com",
      smtp: {
        host: "smtp.example.com",
        port: 65_536,
        secure: true,
        auth: { user: "user", pass: "pass" },
      },
      report_types: [],
      format: "full",
    });

    await expect(saveNotificationConfig(configPath, invalidConfig)).rejects.toThrow();

    expect(fs.existsSync(configPath)).toBe(false);
  });
});
