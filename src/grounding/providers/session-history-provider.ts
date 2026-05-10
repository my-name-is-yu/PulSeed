import type { GroundingMessage, GroundingProvider } from "../contracts.js";
import { makeSection, makeSource } from "./helpers.js";
import { ExecutionSessionStateStore } from "../../runtime/store/execution-session-state-store.js";

function formatRecentMessages(messages: GroundingMessage[]): string {
  return messages
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`)
    .join("\n");
}

function formatStoredSessionLine(session: {
  id: string;
  goal_id: string;
  result_summary: string | null;
}): string {
  return `- ${session.id} (${session.goal_id}): ${session.result_summary ?? "No summary"}`;
}

export const sessionHistoryProvider: GroundingProvider = {
  key: "session_history",
  kind: "dynamic",
  async build(context) {
    if (context.request.recentMessages && context.request.recentMessages.length > 0) {
      const recent = context.request.recentMessages.slice(-context.profile.budgets.maxHistoryMessages);
      const parts = [
        context.request.compactionSummary?.trim()
          ? `Compacted previous conversation summary:\n${context.request.compactionSummary.trim()}`
          : "",
        `Previous conversation:\n${formatRecentMessages(recent)}`,
      ].filter(Boolean);
      return makeSection(
        "session_history",
        parts.join("\n\n"),
        [
          makeSource("session_history", "request.recentMessages", {
            type: "derived",
            trusted: true,
            accepted: true,
            retrievalId: "session:recent_messages",
          }),
        ],
      );
    }

    const stateManager = context.deps.stateManager;
    if (!stateManager) {
      return null;
    }
    const baseDir = stateManager.getBaseDir?.();
    if (!baseDir) {
      return null;
    }
    const store = new ExecutionSessionStateStore(baseDir);
    const sessions = await store.list({ limit: context.profile.budgets.maxHistoryMessages });
    if (sessions.length === 0) {
      return makeSection("session_history", "No recorded session history.", [
        makeSource("session_history", "execution session store", {
          type: "none",
          trusted: true,
          accepted: true,
          retrievalId: "none:session_history",
        }),
      ]);
    }

    return makeSection(
      "session_history",
      sessions.map(formatStoredSessionLine).join("\n"),
      [
        makeSource("session_history", "execution session store", {
          type: "state",
          trusted: true,
          accepted: true,
          retrievalId: "session:stored",
        }),
      ],
    );
  },
};
