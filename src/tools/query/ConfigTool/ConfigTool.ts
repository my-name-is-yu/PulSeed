import { z } from "zod";
import type { ITool, ToolResult, ToolCallContext, PermissionCheckResult, ToolMetadata, ToolDescriptionContext } from "../../types.js";
import { getPulseedDirPath } from "../../../base/utils/paths.js";
import {
  DEFAULT_PROVIDER_CONFIG,
  loadProviderConfigFile,
  type ProviderConfig,
} from "../../../base/llm/provider-config.js";
import { DESCRIPTION } from "./prompt.js";
import { TAGS, PERMISSION_LEVEL, MAX_OUTPUT_CHARS } from "./constants.js";

export const ConfigToolInputSchema = z.object({
  key: z.string().optional(),
}).strict();
export type ConfigToolInput = z.infer<typeof ConfigToolInputSchema>;

interface ConfigToolData {
  provider?: unknown;
  model?: unknown;
  reasoning_effort?: unknown;
  adapter?: unknown;
  default_adapter?: unknown;
  pulseed_home_dir?: unknown;
  [key: string]: unknown;
}

function buildConfigToolData(
  fileConfig: Partial<ProviderConfig>,
  pulseedHome: string,
): ConfigToolData {
  const adapter = fileConfig.adapter ?? DEFAULT_PROVIDER_CONFIG.adapter;
  return {
    provider: fileConfig.provider ?? "unknown",
    model: fileConfig.model ?? "unknown",
    reasoning_effort: fileConfig.reasoning_effort,
    adapter,
    default_adapter: adapter,
    pulseed_home_dir: pulseedHome,
  };
}

export class ConfigTool implements ITool<ConfigToolInput, unknown> {
  readonly metadata: ToolMetadata = {
    name: "get_config",
    aliases: ["config", "read_config"],
    permissionLevel: PERMISSION_LEVEL,
    isReadOnly: true,
    isDestructive: false,
    shouldDefer: false,
    alwaysLoad: false,
    maxConcurrency: 0,
    maxOutputChars: MAX_OUTPUT_CHARS,
    tags: [...TAGS],
  };
  readonly inputSchema = ConfigToolInputSchema;

  description(_context?: ToolDescriptionContext): string {
    return DESCRIPTION;
  }

  async call(input: ConfigToolInput, context: ToolCallContext): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const pulseedHome = context.providerConfigBaseDir ?? getPulseedDirPath();
      const fileConfig = await loadProviderConfigFile({ baseDir: pulseedHome });
      const config = buildConfigToolData(fileConfig, pulseedHome);
      if (input.key) {
        const value = config[input.key];
        const data = { key: input.key, value: value ?? null };
        return {
          success: true,
          data,
          summary: value !== undefined
            ? `Config ${input.key}=${String(value)}`
            : `Config key ${input.key} not found`,
          durationMs: Date.now() - startTime,
        };
      }
      return {
        success: true,
        data: config,
        summary: `Config: provider=${String(config.provider)}, model=${String(config.model)}`,
        durationMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        data: null,
        summary: "ConfigTool failed: " + (err as Error).message,
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
      };
    }
  }

  async checkPermissions(_input: ConfigToolInput, _context?: ToolCallContext): Promise<PermissionCheckResult> {
    return { status: "allowed" };
  }

  isConcurrencySafe(_input?: ConfigToolInput): boolean {
    return true;
  }
}
