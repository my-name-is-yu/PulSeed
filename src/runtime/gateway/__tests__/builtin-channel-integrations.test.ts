import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILTIN_GATEWAY_CHANNEL_NAMES,
  ensureBuiltinGatewayChannelLocations,
  loadBuiltinGatewayIntegrations,
} from "../builtin-channel-integrations.js";

const tempDirs: string[] = [];

describe("loadBuiltinGatewayIntegrations", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it("loads built-in adapters and notifiers from legacy plugin config locations", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-gateway-core-"));
    tempDirs.push(baseDir);

    await writePluginConfig(baseDir, "telegram-bot", {
      bot_token: "token",
      allowed_user_ids: [1],
      denied_user_ids: [],
      allowed_chat_ids: [],
      denied_chat_ids: [],
      runtime_control_allowed_user_ids: [],
      chat_goal_map: {},
      user_goal_map: {},
      allow_all: true,
      polling_timeout: 30,
    });
    await writePluginConfig(baseDir, "discord-bot", {
      application_id: "app",
      bot_token: "token",
      channel_id: "channel",
      identity_key: "identity",
      allowed_sender_ids: [],
      denied_sender_ids: [],
      allowed_conversation_ids: [],
      denied_conversation_ids: [],
      runtime_control_allowed_sender_ids: [],
      conversation_goal_map: {},
      sender_goal_map: {},
      command_name: "pulseed",
      host: "127.0.0.1",
      port: 8787,
      ephemeral: false,
    });

    const loaded = await loadBuiltinGatewayIntegrations(baseDir);

    expect(loaded.adapters.map((adapter) => adapter.name).sort()).toEqual(["discord", "telegram"]);
    expect(loaded.notifiers.map((entry) => entry.name).sort()).toEqual(["discord-bot", "telegram-bot"]);
    expect(
      JSON.parse(
        await fs.readFile(
          path.join(baseDir, "gateway", "channels", "telegram-bot", "config.json"),
          "utf-8"
        )
      )
    ).toMatchObject({ bot_token: "token" });
    expect(
      await pathExists(path.join(baseDir, "plugins-promoted-to-core", "telegram-bot"))
    ).toBe(true);
    expect(await pathExists(path.join(baseDir, "plugins", "telegram-bot"))).toBe(false);
  });

  it("prefers canonical gateway channel config when present", async () => {
    const baseDir = await fs.mkdtemp(path.join(os.tmpdir(), "pulseed-gateway-core-"));
    tempDirs.push(baseDir);

    await fs.mkdir(path.join(baseDir, "gateway", "channels", "signal-bridge"), { recursive: true });
    await fs.writeFile(
      path.join(baseDir, "gateway", "channels", "signal-bridge", "config.json"),
      JSON.stringify({
        bridge_url: "http://localhost:8080",
        account: "+10000000000",
        recipient_id: "+10000000001",
        identity_key: "me",
        allowed_sender_ids: [],
        denied_sender_ids: [],
        allowed_conversation_ids: [],
        denied_conversation_ids: [],
        runtime_control_allowed_sender_ids: [],
        conversation_goal_map: {},
        sender_goal_map: {},
        poll_interval_ms: 5000,
        receive_timeout_ms: 2000,
      }, null, 2),
      "utf-8"
    );
    await writePluginConfig(baseDir, "signal-bridge", { bridge_url: "legacy" });

    const locations = await ensureBuiltinGatewayChannelLocations(baseDir);

    expect(locations.find((entry) => entry.channelName === "signal-bridge")?.source).toBe("core");
    expect(await pathExists(path.join(baseDir, "plugins", "signal-bridge", "config.json"))).toBe(true);
  });

  it("keeps the canonical channel name list", () => {
    expect(BUILTIN_GATEWAY_CHANNEL_NAMES).toEqual([
      "telegram-bot",
      "whatsapp-webhook",
      "signal-bridge",
      "discord-bot",
    ]);
  });
});

async function writePluginConfig(baseDir: string, pluginName: string, config: Record<string, unknown>): Promise<void> {
  const pluginDir = path.join(baseDir, "plugins", pluginName);
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(path.join(pluginDir, "config.json"), JSON.stringify(config, null, 2), "utf-8");
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
