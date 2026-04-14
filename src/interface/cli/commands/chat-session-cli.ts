// ─── Chat session CLI helpers ───

import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

import { StateManager } from "../../../base/state/state-manager.js";
import { resolveGitRoot } from "../../../platform/observation/context-provider.js";
import {
  ChatSessionCatalog,
  ChatSessionSelectorError,
  type ChatSessionCatalogEntry,
  type LoadedChatSession,
} from "../../chat/chat-session-store.js";
import type { ChatMessage } from "../../tui/chat.js";
import { getCliLogger } from "../cli-logger.js";

const logger = getCliLogger();
const CHAT_SESSION_STORAGE_PATH = "~/.pulseed/chat/sessions/<id>.json";
const CHAT_SESSION_STORAGE_DIR = "~/.pulseed/chat/sessions/";
const CHAT_SESSION_CLEANUP_NOTE = "Sessions not accessed in 7 days are eligible for cleanup.";
const DEFAULT_CHAT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type ChatSessionAction =
  | "list"
  | "history"
  | "resume"
  | "continue"
  | "rename"
  | "cleanup";

export interface ChatSessionIntent {
  action: ChatSessionAction;
  selector?: string;
  title?: string;
  dryRun?: boolean;
}

export interface ChatCommandRequest {
  adapter?: string;
  timeoutMs: number;
  task?: string;
  intent: ChatSessionIntent | null;
}

interface ParsedChatCommandValues {
  adapter?: string;
  timeout?: string;
  continue?: boolean;
  resume?: string;
  sessions?: boolean;
  history?: string;
  title?: string;
  "cleanup-sessions"?: boolean;
  "dry-run"?: boolean;
}

function parseTimeout(timeout: string | undefined): number {
  if (timeout === undefined) {
    return 120_000;
  }

  const parsed = Number.parseInt(timeout, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid --timeout value: "${timeout}"`);
  }

  return parsed;
}

function buildIntent(values: ParsedChatCommandValues, positionals: string[]): ChatSessionIntent | null {
  if (values["cleanup-sessions"]) {
    return {
      action: "cleanup",
      dryRun: Boolean(values["dry-run"]),
    };
  }
  if (values.sessions) {
    return { action: "list" };
  }
  if (values.history !== undefined) {
    return {
      action: "history",
      selector: values.history,
      title: values.title,
    };
  }
  if (values.resume !== undefined) {
    return {
      action: "resume",
      selector: values.resume,
      title: values.title,
    };
  }
  if (values.continue) {
    return {
      action: "continue",
      selector: positionals[0],
      title: values.title,
    };
  }
  if (values.title !== undefined) {
    return {
      action: "rename",
      selector: positionals[0],
      title: values.title,
    };
  }
  return null;
}

export function printChatCommandUsage(): void {
  const usage = `
pulseed chat — interactive chat and session controls

Usage:
  pulseed chat [task]
  pulseed chat --continue [id-or-title]
  pulseed chat -c [id-or-title]
  pulseed chat --resume <id-or-title>
  pulseed chat --sessions
  pulseed chat --history <id-or-title>
  pulseed chat --title <title>
  pulseed chat --cleanup-sessions [--dry-run]

Options:
  --adapter <type>        Adapter: claude_api | claude_code_cli | github_issue
  --timeout <ms>          Override command timeout (default: 120000)
  --continue, -c          Continue the latest chat session, or the one selected by the optional positional argument
  --resume <selector>     Resume a session by ID or title
  --sessions              List chat sessions
  --history <selector>    Show the history for a session
  --title <title>         Rename the selected or current session
  --cleanup-sessions      Clean up stale chat sessions in ${CHAT_SESSION_STORAGE_DIR}
  --dry-run               Preview cleanup without deleting anything

Persistence contract:
  Sessions are stored under ${CHAT_SESSION_STORAGE_PATH}
  ${CHAT_SESSION_CLEANUP_NOTE}
`.trim();

  console.log(usage);
}

export function parseChatCommandRequest(argv: string[]): ChatCommandRequest {
  const parsed = parseArgs({
    args: argv,
    options: {
      adapter: { type: "string" },
      timeout: { type: "string" },
      continue: { type: "boolean", short: "c" },
      resume: { type: "string", short: "r" },
      sessions: { type: "boolean" },
      history: { type: "string" },
      title: { type: "string" },
      "cleanup-sessions": { type: "boolean" },
      "dry-run": { type: "boolean" },
    },
    allowPositionals: true,
    strict: false,
  }) as { values: ParsedChatCommandValues; positionals: string[] };
  const { values, positionals } = parsed;
  const intent = buildIntent(values, positionals);

  return {
    adapter: values.adapter,
    timeoutMs: parseTimeout(values.timeout),
    ...(intent ? { intent } : { task: positionals[0], intent: null }),
  };
}

function formatCatalogEntry(entry: ChatSessionCatalogEntry): string {
  const title = entry.title ? ` "${entry.title}"` : "";
  const resumable = entry.agentLoopResumable ? " resumable" : "";
  return `${entry.id}${title} - ${entry.messageCount} message(s), updated ${entry.updatedAt}, cwd ${entry.cwd}${resumable}`;
}

function formatSessionHistory(session: LoadedChatSession): string {
  const title = session.title ? ` "${session.title}"` : "";
  if (session.messages.length === 0) {
    return `Session ${session.id}${title} has no messages.`;
  }
  const transcript = session.messages.map((message) => {
    const role = message.role === "assistant" ? "Assistant" : "User";
    return `${role}: ${message.content}`;
  });
  return `Session ${session.id}${title} (${session.cwd})\n${transcript.join("\n")}`;
}

async function resolveCatalogEntry(
  catalog: ChatSessionCatalog,
  selector: string | undefined,
  cwd: string,
): Promise<ChatSessionCatalogEntry | null> {
  if (selector) {
    return await catalog.resolveSelector(selector);
  }
  return await catalog.latestSession({ cwd: resolveGitRoot(cwd) });
}

export async function resolveSessionForIntent(
  catalog: ChatSessionCatalog,
  intent: ChatSessionIntent,
  cwd: string,
): Promise<LoadedChatSession | null> {
  if (intent.action !== "continue" && intent.action !== "resume") return null;
  const entry = await resolveCatalogEntry(catalog, intent.selector, cwd);
  if (!entry) {
    throw new Error(`No chat session found for ${resolveGitRoot(cwd)}.`);
  }
  if (intent.title) {
    return await catalog.renameSession(entry.id, intent.title);
  }
  const session = await catalog.loadSession(entry.id);
  if (!session) {
    throw new Error(`Chat session "${entry.id}" disappeared before it could be resumed.`);
  }
  return session;
}

export function chatMessagesFromSession(session: LoadedChatSession): ChatMessage[] {
  const title = session.title ? ` "${session.title}"` : "";
  const messages: ChatMessage[] = [
    {
      id: randomUUID(),
      role: "pulseed",
      text: `Resumed chat session ${session.id}${title}.`,
      timestamp: new Date(),
      messageType: "info",
    },
  ];
  for (const message of session.messages) {
    messages.push({
      id: randomUUID(),
      role: message.role === "assistant" ? "pulseed" : "user",
      text: message.content,
      timestamp: Number.isNaN(Date.parse(message.timestamp)) ? new Date() : new Date(message.timestamp),
    });
  }
  return messages;
}

async function runListIntent(catalog: ChatSessionCatalog): Promise<number> {
  const sessions = await catalog.listSessions();
  process.stdout.write(sessions.length === 0 ? "No chat sessions found.\n" : `Chat sessions:\n${sessions.map(formatCatalogEntry).join("\n")}\n`);
  return 0;
}

async function runHistoryIntent(catalog: ChatSessionCatalog, intent: ChatSessionIntent): Promise<number> {
  if (!intent.selector) {
    logger.error("Error: --history requires a session ID or title.");
    return 1;
  }
  const session = await catalog.loadSessionBySelector(intent.selector);
  if (!session) {
    logger.error(`No chat session matched selector "${intent.selector}".`);
    return 1;
  }
  process.stdout.write(formatSessionHistory(session) + "\n");
  return 0;
}

async function runRenameIntent(catalog: ChatSessionCatalog, intent: ChatSessionIntent, cwd: string): Promise<number> {
  if (!intent.title) {
    logger.error("Error: --title requires a non-empty title.");
    return 1;
  }
  const entry = await resolveCatalogEntry(catalog, intent.selector, cwd);
  if (!entry) {
    logger.error(`No chat session found for ${resolveGitRoot(cwd)}.`);
    return 1;
  }
  const renamed = await catalog.renameSession(entry.id, intent.title);
  process.stdout.write(`Renamed chat session ${renamed.id} to "${renamed.title}".\n`);
  return 0;
}

async function runCleanupIntent(catalog: ChatSessionCatalog, intent: ChatSessionIntent): Promise<number> {
  const report = await catalog.cleanupSessions({
    dryRun: Boolean(intent.dryRun),
    olderThanMs: DEFAULT_CHAT_SESSION_TTL_MS,
  });
  const verb = report.dryRun ? "would remove" : "removed";
  process.stdout.write(`Chat session cleanup ${verb} ${report.removedSessionIds.length} session(s).\n`);
  if (report.removedSessionIds.length > 0) {
    process.stdout.write(report.removedSessionIds.join("\n") + "\n");
  }
  return 0;
}

export async function runCatalogOnlyIntent(
  stateManager: StateManager,
  intent: ChatSessionIntent,
  cwd: string,
): Promise<number> {
  const catalog = new ChatSessionCatalog(stateManager);
  try {
    switch (intent.action) {
      case "list":
        return await runListIntent(catalog);
      case "history":
        return await runHistoryIntent(catalog, intent);
      case "rename":
        return await runRenameIntent(catalog, intent, cwd);
      case "cleanup":
        return await runCleanupIntent(catalog, intent);
      case "continue":
      case "resume":
        return 0;
    }
  } catch (err) {
    if (err instanceof ChatSessionSelectorError) {
      logger.error(err.message);
      if (err.matches.length > 0) {
        logger.error(`Matches: ${err.matches.join(", ")}`);
      }
      return 1;
    }
    throw err;
  }
}
