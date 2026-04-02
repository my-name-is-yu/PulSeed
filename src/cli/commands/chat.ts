// ─── pulseed chat command ───

import { parseArgs } from "node:util";

import { StateManager } from "../../state-manager.js";
import { ensureProviderConfig } from "../ensure-api-key.js";
import { buildLLMClient, buildAdapterRegistry } from "../../llm/provider-factory.js";
import { loadProviderConfig } from "../../llm/provider-config.js";
import { formatOperationError } from "../utils.js";
import { getCliLogger } from "../cli-logger.js";

const logger = getCliLogger();

export async function cmdChat(
  stateManager: StateManager,
  argv: string[]
): Promise<number> {
  let values: { adapter?: string; timeout?: string };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args: argv,
      options: {
        adapter: { type: "string" },
        timeout: { type: "string" },
      },
      allowPositionals: true,
      strict: false,
    }) as { values: { adapter?: string; timeout?: string }; positionals: string[] };
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (err) {
    logger.error(formatOperationError("parse chat command arguments", err));
    return 1;
  }

  const task = positionals[0];

  if (!task) {
    console.log("Interactive mode not yet available (Phase 1b)");
    return 0;
  }

  try {
    await ensureProviderConfig();
  } catch (err) {
    logger.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  const timeoutMs = values.timeout !== undefined ? parseInt(values.timeout, 10) : 120_000;

  let adapterType = values.adapter;
  if (!adapterType) {
    try {
      const providerConfig = await loadProviderConfig();
      adapterType = providerConfig.adapter;
    } catch {
      adapterType = "claude_code_cli";
    }
  }

  try {
    const llmClient = await buildLLMClient();
    const adapterRegistry = await buildAdapterRegistry(llmClient);
    const adapter = adapterRegistry.getAdapter(adapterType);

    const { ChatRunner } = await import("../../chat/chat-runner.js");
    const chatRunner = new ChatRunner({ adapter, stateManager });

    const result = await chatRunner.execute(task, process.cwd(), timeoutMs);
    if (result.output) {
      process.stdout.write(result.output + "\n");
    }
    return result.success ? 0 : 1;
  } catch (err) {
    logger.error(formatOperationError("execute chat command", err));
    return 1;
  }
}
