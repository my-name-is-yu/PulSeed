// ─── pulseed chat command ───

import React, { useState, useCallback, useEffect } from "react";
import { render, useApp } from "ink";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import * as path from "node:path";

import { StateManager } from "../../../base/state/state-manager.js";
import { ensureProviderConfig } from "../ensure-api-key.js";
import { buildLLMClient, buildAdapterRegistry } from "../../../base/llm/provider-factory.js";
import { loadProviderConfig } from "../../../base/llm/provider-config.js";
import { formatOperationError } from "../utils.js";
import { getCliLogger } from "../cli-logger.js";
import type { ChatRunner } from "../../chat/chat-runner.js";
import { ChatSessionCatalog, ChatSessionSelectorError, type LoadedChatSession } from "../../chat/chat-session-store.js";
import { Chat, type ChatMessage } from "../../tui/chat.js";
import { EthicsGate } from "../../../platform/traits/ethics-gate.js";
import { ObservationEngine } from "../../../platform/observation/observation-engine.js";
import { GoalNegotiator } from "../../../orchestrator/goal/goal-negotiator.js";
import { EscalationHandler } from "../../chat/escalation.js";
import { DaemonClient, isDaemonRunning } from "../../../runtime/daemon/client.js";
import { ScheduleEngine } from "../../../runtime/schedule/engine.js";
import { TrustManager } from "../../../platform/traits/trust-manager.js";
import { ToolRegistry, ToolExecutor, ToolPermissionManager, ConcurrencyController } from "../../../tools/index.js";
import { createBuiltinTools } from "../../../tools/builtin/index.js";
import { applyChatEventToMessages } from "../../chat/chat-event-state.js";
import { isSafeBashCommand } from "../../tui/bash-mode.js";
import {
  createNativeChatAgentLoopRunner,
  shouldUseNativeTaskAgentLoop,
} from "../../../orchestrator/execution/agent-loop/index.js";
import {
  RuntimeControlService,
  createDaemonRuntimeControlExecutor,
} from "../../../runtime/control/index.js";
import {
  chatMessagesFromSession,
  parseChatCommandRequest,
  printChatCommandUsage,
  resolveSessionForIntent,
  runCatalogOnlyIntent,
  type ChatCommandRequest,
} from "./chat-session-cli.js";

const logger = getCliLogger();

export { parseChatCommandRequest, printChatCommandUsage } from "./chat-session-cli.js";

async function promptChatApproval(reason: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (approved: boolean) => {
      if (settled) return;
      settled = true;
      resolve(approved);
    };

    rl.question(`\n⚠ Approval required: ${reason}\nProceed? [y/N] `, (answer) => {
      const normalized = answer.trim().toLowerCase();
      finish(normalized === "y" || normalized === "yes");
      rl.close();
    });

    rl.once("close", () => finish(false));
  });
}

// ─── Interactive REPL component ───

interface ChatAppProps {
  chatRunner: ChatRunner;
  cwd: string;
  timeoutMs: number;
  initialMessages?: ChatMessage[];
}

function ChatApp({ chatRunner, cwd, timeoutMs, initialMessages }: ChatAppProps) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages ?? [
    {
      id: randomUUID(),
      role: "pulseed",
      text: "Chat mode — type a task, /help for commands, /exit to quit.",
      timestamp: new Date(),
      messageType: "info",
    },
  ]);
  const [isProcessing, setIsProcessing] = useState(false);

  const pushNotification = useCallback(
    (text: string) => {
      setMessages((prev) => [
        ...prev,
        {
          id: randomUUID(),
          role: "pulseed" as const,
          text,
          timestamp: new Date(),
          messageType: "info" as const,
        },
      ]);
    },
    []
  );

  useEffect(() => {
    if (chatRunner.getSessionId() === null) {
      chatRunner.startSession(cwd);
    }
    // Wire notification callback so /tend daemon events appear in chat
    chatRunner.onNotification = pushNotification;
    chatRunner.onEvent = (event) => {
      setMessages((prev) => applyChatEventToMessages(prev, event, 200) as ChatMessage[]);
    };
  }, []);

  const onSubmit = useCallback(
    async (input: string) => {
      if (!input.trim() || isProcessing) return;

      if (input.trim().toLowerCase() === "/exit") {
        exit();
        return;
      }

      setMessages((prev) => [
        ...prev,
        { id: randomUUID(), role: "user" as const, text: input, timestamp: new Date() },
      ]);
      setIsProcessing(true);

      try {
        await chatRunner.execute(input, cwd, timeoutMs);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setMessages((prev) => [
          ...prev,
          {
            id: randomUUID(),
            role: "pulseed" as const,
            text: `Error: ${message}`,
            timestamp: new Date(),
            messageType: "error" as const,
          },
        ]);
      } finally {
        setIsProcessing(false);
      }
    },
    [chatRunner, cwd, timeoutMs, isProcessing, exit]
  );

  return React.createElement(Chat, { messages, onSubmit, isProcessing });
}

// ─── Command handler ───

type ChatProviderConfig = Awaited<ReturnType<typeof loadProviderConfig>>;
type ChatLLMClient = Awaited<ReturnType<typeof buildLLMClient>>;

const SESSION_RESOLVE_FAILED = Symbol("session-resolve-failed");

function isCatalogOnlyIntent(request: ChatCommandRequest): boolean {
  return request.intent !== null && request.intent.action !== "continue" && request.intent.action !== "resume";
}

async function resolveAdapterType(requestedAdapter: string | undefined): Promise<string> {
  if (requestedAdapter) {
    return requestedAdapter;
  }
  try {
    const providerConfig = await loadProviderConfig();
    return providerConfig.adapter;
  } catch {
    return "claude_code_cli";
  }
}

async function buildChatToolRuntime(
  stateManager: StateManager,
  llmClient: ChatLLMClient,
  effectiveProviderConfig: ChatProviderConfig,
  pulseedDir: string,
) {
  const trustManager = new TrustManager(stateManager);
  const scheduleEngine = new ScheduleEngine({ baseDir: pulseedDir });
  await scheduleEngine.loadEntries();

  const registry = new ToolRegistry();
  for (const tool of createBuiltinTools({
    stateManager,
    trustManager,
    registry,
    scheduleEngine,
  })) {
    registry.register(tool);
  }

  const permissionManager = new ToolPermissionManager({
    trustManager,
    allowRules: [
      {
        toolName: "shell",
        inputMatcher: (input) =>
          typeof input === "object" &&
          input !== null &&
          typeof (input as Record<string, unknown>)["command"] === "string" &&
          isSafeBashCommand((input as Record<string, unknown>)["command"] as string),
        reason: "safe shell command",
      },
    ],
  });
  const toolExecutor = new ToolExecutor({
    registry,
    permissionManager,
    concurrency: new ConcurrencyController(),
  });
  const chatAgentLoopRunner = shouldUseNativeTaskAgentLoop(effectiveProviderConfig, llmClient)
    ? createNativeChatAgentLoopRunner({
        llmClient,
        providerConfig: effectiveProviderConfig,
        toolRegistry: registry,
        toolExecutor,
        cwd: process.cwd(),
        traceBaseDir: stateManager.getBaseDir(),
      })
    : undefined;

  return { registry, toolExecutor, chatAgentLoopRunner };
}

async function buildEscalationDeps(stateManager: StateManager, llmClient: ChatLLMClient): Promise<{
  escalationHandler?: EscalationHandler;
  goalNegotiatorForTend?: GoalNegotiator;
}> {
  try {
    const ethicsGate = new EthicsGate(stateManager, llmClient);
    const observationEngine = new ObservationEngine(stateManager, [], llmClient);
    const goalNegotiator = new GoalNegotiator(stateManager, llmClient, ethicsGate, observationEngine);
    return {
      escalationHandler: new EscalationHandler({ stateManager, llmClient, goalNegotiator }),
      goalNegotiatorForTend: goalNegotiator,
    };
  } catch {
    logger.warn("Escalation handler could not be initialized — /track and /tend will be unavailable");
    return {};
  }
}

async function buildDaemonDeps(pulseedDir: string): Promise<{
  daemonClient?: DaemonClient;
  daemonBaseUrl?: string;
}> {
  try {
    const daemonInfo = await isDaemonRunning(pulseedDir);
    if (!daemonInfo.running) {
      return {};
    }
    if (daemonInfo.authToken) {
      process.env["PULSEED_DAEMON_TOKEN"] = daemonInfo.authToken;
    }
    return {
      daemonClient: new DaemonClient({
        host: "127.0.0.1",
        port: daemonInfo.port,
        authToken: daemonInfo.authToken,
        baseDir: pulseedDir,
      }),
      daemonBaseUrl: `http://127.0.0.1:${daemonInfo.port}`,
    };
  } catch {
    return {};
  }
}

async function createChatRunnerForCommand(stateManager: StateManager, request: ChatCommandRequest): Promise<ChatRunner> {
  const adapterType = await resolveAdapterType(request.adapter);
  await ensureProviderConfig();

  const llmClient = await buildLLMClient();
  const providerConfig = await loadProviderConfig();
  const effectiveProviderConfig = {
    ...providerConfig,
    adapter: adapterType as typeof providerConfig.adapter,
  };
  const adapterRegistry = await buildAdapterRegistry(llmClient, effectiveProviderConfig);
  const adapter = adapterRegistry.getAdapter(adapterType);
  const pulseedDir = stateManager.getBaseDir();
  const { registry, toolExecutor, chatAgentLoopRunner } = await buildChatToolRuntime(
    stateManager,
    llmClient,
    effectiveProviderConfig,
    pulseedDir,
  );
  const { escalationHandler, goalNegotiatorForTend } = await buildEscalationDeps(stateManager, llmClient);
  const { daemonClient, daemonBaseUrl } = await buildDaemonDeps(pulseedDir);
  const { ChatRunner } = await import("../../chat/chat-runner.js");

  return new ChatRunner({
    adapter,
    stateManager,
    llmClient,
    escalationHandler,
    goalNegotiator: goalNegotiatorForTend,
    daemonClient,
    daemonBaseUrl,
    registry,
    toolExecutor,
    chatAgentLoopRunner,
    approvalFn: promptChatApproval,
    runtimeControlService: new RuntimeControlService({
      runtimeRoot: path.join(stateManager.getBaseDir(), "runtime"),
      executor: createDaemonRuntimeControlExecutor({
        baseDir: stateManager.getBaseDir(),
      }),
    }),
    runtimeReplyTarget: { surface: "cli" },
  });
}

async function startRequestedSession(
  chatRunner: ChatRunner,
  stateManager: StateManager,
  request: ChatCommandRequest,
): Promise<LoadedChatSession | null | typeof SESSION_RESOLVE_FAILED> {
  if (!request.intent) {
    return null;
  }
  try {
    const resumedSession = await resolveSessionForIntent(
      new ChatSessionCatalog(stateManager),
      request.intent,
      process.cwd(),
    );
    if (resumedSession) {
      chatRunner.startSessionFromLoadedSession(resumedSession);
    }
    return resumedSession;
  } catch (err) {
    if (err instanceof ChatSessionSelectorError) {
      logger.error(err.message);
      if (err.matches.length > 0) {
        logger.error(`Matches: ${err.matches.join(", ")}`);
      }
      return SESSION_RESOLVE_FAILED;
    }
    throw err;
  }
}

async function runChatRequest(
  chatRunner: ChatRunner,
  request: ChatCommandRequest,
  resumedSession: LoadedChatSession | null,
): Promise<number> {
  if (request.task) {
    const result = await chatRunner.execute(request.task, process.cwd(), request.timeoutMs);
    if (result.output) {
      process.stdout.write(result.output + "\n");
    }
    return result.success ? 0 : 1;
  }

  const { waitUntilExit } = render(
    React.createElement(ChatApp, {
      chatRunner,
      cwd: process.cwd(),
      timeoutMs: request.timeoutMs,
      initialMessages: resumedSession ? chatMessagesFromSession(resumedSession) : undefined,
    })
  );
  await waitUntilExit();
  return 0;
}

async function runCatalogIntentWithErrorHandling(stateManager: StateManager, request: ChatCommandRequest): Promise<number> {
  try {
    return await runCatalogOnlyIntent(stateManager, request.intent!, process.cwd());
  } catch (err) {
    logger.error(formatOperationError("execute chat command", err));
    return 1;
  }
}

export async function cmdChat(
  stateManager: StateManager,
  argv: string[]
): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    printChatCommandUsage();
    return 0;
  }

  let request: ChatCommandRequest;
  try {
    request = parseChatCommandRequest(argv);
  } catch (err) {
    logger.error(formatOperationError("parse chat command arguments", err));
    return 1;
  }

  if (isCatalogOnlyIntent(request)) {
    return await runCatalogIntentWithErrorHandling(stateManager, request);
  }

  try {
    const chatRunner = await createChatRunnerForCommand(stateManager, request);
    const resumedSession = await startRequestedSession(chatRunner, stateManager, request);
    if (resumedSession === SESSION_RESOLVE_FAILED) return 1;
    return await runChatRequest(chatRunner, request, resumedSession);
  } catch (err) {
    logger.error(formatOperationError("execute chat command", err));
    return 1;
  }
}
