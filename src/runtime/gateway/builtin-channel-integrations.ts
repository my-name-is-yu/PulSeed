import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  getGatewayChannelDir,
  getGatewayChannelsDir,
  getPluginsDir,
  getPromotedPluginsDir,
} from "../../base/utils/paths.js";
import type { Logger } from "../logger.js";
import type { INotifier } from "../../base/types/plugin.js";
import type { ChannelAdapter } from "./channel-adapter.js";
import { BUILTIN_GATEWAY_CHANNEL_NAMES } from "./builtin-channel-names.js";
import { DiscordGatewayAdapter } from "./discord-gateway-adapter.js";
import { SignalGatewayAdapter } from "./signal-gateway-adapter.js";
import { TelegramGatewayAdapter } from "./telegram-gateway-adapter.js";
import { WhatsAppGatewayAdapter } from "./whatsapp-gateway-adapter.js";

export interface BuiltinGatewayIntegrations {
  adapters: ChannelAdapter[];
  notifiers: Array<{ name: string; notifier: INotifier }>;
}

export { BUILTIN_GATEWAY_CHANNEL_NAMES } from "./builtin-channel-names.js";

export interface BuiltinGatewayChannelLocation {
  channelName: string;
  channelDir: string;
  configPath: string;
  source: "core" | "legacy-plugin";
}

export async function loadBuiltinGatewayIntegrations(
  baseDir: string,
  logger?: Logger
): Promise<BuiltinGatewayIntegrations> {
  const adapters: ChannelAdapter[] = [];
  const notifiers: Array<{ name: string; notifier: INotifier }> = [];
  const locations = await ensureBuiltinGatewayChannelLocations(baseDir, logger);

  for (const location of locations) {
    try {
      switch (location.channelName) {
        case "telegram-bot": {
          const adapter = TelegramGatewayAdapter.fromConfigDir(location.channelDir);
          adapters.push(adapter);
          notifiers.push({ name: "telegram-bot", notifier: adapter.getNotifier() });
          break;
        }
        case "whatsapp-webhook": {
          const adapter = WhatsAppGatewayAdapter.fromConfigDir(location.channelDir);
          adapters.push(adapter);
          notifiers.push({ name: "whatsapp-webhook", notifier: adapter.getNotifier() });
          break;
        }
        case "signal-bridge": {
          const adapter = SignalGatewayAdapter.fromConfigDir(location.channelDir);
          adapters.push(adapter);
          notifiers.push({ name: "signal-bridge", notifier: adapter.getNotifier() });
          break;
        }
        case "discord-bot": {
          const adapter = DiscordGatewayAdapter.fromConfigDir(location.channelDir);
          adapters.push(adapter);
          notifiers.push({ name: "discord-bot", notifier: adapter.getNotifier() });
          break;
        }
      }
    } catch (err) {
      logger?.warn(
        `[daemon] built-in ${location.channelName} gateway disabled: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  return { adapters, notifiers };
}

export async function ensureBuiltinGatewayChannelLocations(
  baseDir: string,
  logger?: Logger
): Promise<BuiltinGatewayChannelLocation[]> {
  await fs.mkdir(getGatewayChannelsDir(baseDir), { recursive: true });
  const locations: BuiltinGatewayChannelLocation[] = [];

  for (const channelName of BUILTIN_GATEWAY_CHANNEL_NAMES) {
    const location = await ensureBuiltinGatewayChannelLocation(baseDir, channelName, logger);
    if (location) {
      locations.push(location);
    }
  }

  return locations;
}

export async function ensureBuiltinGatewayChannelLocation(
  baseDir: string,
  channelName: string,
  logger?: Logger
): Promise<BuiltinGatewayChannelLocation | null> {
  const channelDir = getGatewayChannelDir(channelName, baseDir);
  const configPath = path.join(channelDir, "config.json");
  if (await pathExists(configPath)) {
    return {
      channelName,
      channelDir,
      configPath,
      source: "core",
    };
  }

  const migrated = await migrateLegacyPluginChannel(baseDir, channelName, logger);
  if (migrated) {
    return migrated;
  }

  return null;
}

async function migrateLegacyPluginChannel(
  baseDir: string,
  channelName: string,
  logger?: Logger
): Promise<BuiltinGatewayChannelLocation | null> {
  const legacyDir = path.join(getPluginsDir(baseDir), channelName);
  const legacyConfigPath = path.join(legacyDir, "config.json");
  if (!(await pathExists(legacyConfigPath))) {
    return null;
  }

  const channelDir = getGatewayChannelDir(channelName, baseDir);
  const configPath = path.join(channelDir, "config.json");
  await fs.mkdir(channelDir, { recursive: true });
  await fs.copyFile(legacyConfigPath, configPath);
  await retireLegacyPluginDirectory(baseDir, channelName, legacyDir);
  logger?.info(`[daemon] promoted legacy ${channelName} plugin config into gateway core`, {
    legacy_dir: legacyDir,
    channel_dir: channelDir,
  });

  return {
    channelName,
    channelDir,
    configPath,
    source: "legacy-plugin",
  };
}

async function retireLegacyPluginDirectory(baseDir: string, channelName: string, legacyDir: string): Promise<void> {
  const archiveRoot = getPromotedPluginsDir(baseDir);
  await fs.mkdir(archiveRoot, { recursive: true });
  const targetDir = await nextAvailablePromotedDir(path.join(archiveRoot, channelName));
  await fs.rename(legacyDir, targetDir);
}

async function nextAvailablePromotedDir(basePath: string): Promise<string> {
  if (!(await pathExists(basePath))) {
    return basePath;
  }
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${basePath}-${index}`;
    if (!(await pathExists(candidate))) {
      return candidate;
    }
  }
  throw new Error(`Unable to find archive slot for promoted plugin: ${basePath}`);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
