import { fuzzyFilter, fuzzyMatch } from "../fuzzy.js";

export type Suggestion = {
  name: string;
  description: string;
  aliases: string[];
  type: "command" | "goal";
};

const COMMANDS: Suggestion[] = [
  {
    name: "/tend",
    aliases: [],
    description: "Start background work from this chat",
    type: "command",
  },
  {
    name: "/status",
    aliases: [],
    description: "Show what PulSeed is doing",
    type: "command",
  },
  {
    name: "/help",
    aliases: ["?", "/?"],
    description: "Show examples and commands",
    type: "command",
  },
  {
    name: "/run",
    aliases: ["/start"],
    description: "Start a selected goal loop",
    type: "command",
  },
  {
    name: "/stop",
    aliases: ["/quit"],
    description: "Stop the running loop",
    type: "command",
  },
  {
    name: "/clear",
    aliases: [],
    description: "Clear visible chat messages",
    type: "command",
  },
  {
    name: "/sessions",
    aliases: [],
    description: "List saved runtime sessions",
    type: "command",
  },
  {
    name: "/history",
    aliases: [],
    description: "Show saved chat history",
    type: "command",
  },
  {
    name: "/title",
    aliases: [],
    description: "Rename the current session",
    type: "command",
  },
  {
    name: "/resume",
    aliases: [],
    description: "Resume a saved session",
    type: "command",
  },
  {
    name: "/cleanup",
    aliases: [],
    description: "Clean up stale chat sessions",
    type: "command",
  },
  {
    name: "/compact",
    aliases: [],
    description: "Compact older chat context",
    type: "command",
  },
  {
    name: "/context",
    aliases: ["/working-memory"],
    description: "Show working context",
    type: "command",
  },
  {
    name: "/report",
    aliases: [],
    description: "Generate a summary report",
    type: "command",
  },
  {
    name: "/goals",
    aliases: [],
    description: "List all goals",
    type: "command",
  },
  {
    name: "/tasks",
    aliases: [],
    description: "List tasks for a goal",
    type: "command",
  },
  {
    name: "/task",
    aliases: [],
    description: "Show one task",
    type: "command",
  },
  {
    name: "/track",
    aliases: [],
    description: "Promote this chat to a goal",
    type: "command",
  },
  {
    name: "/dashboard",
    aliases: ["/d"],
    description: "Toggle dashboard sidebar",
    type: "command",
  },
  {
    name: "/settings",
    aliases: [],
    description: "View and toggle config",
    type: "command",
  },
  {
    name: "/config",
    aliases: [],
    description: "Show provider configuration",
    type: "command",
  },
  {
    name: "/model",
    aliases: [],
    description: "Choose model and reasoning effort",
    type: "command",
  },
  {
    name: "/permissions",
    aliases: [],
    description: "Show or update execution policy",
    type: "command",
  },
  {
    name: "/plugins",
    aliases: [],
    description: "List installed plugins",
    type: "command",
  },
  {
    name: "/usage",
    aliases: [],
    description: "Show usage summary",
    type: "command",
  },
  {
    name: "/review",
    aliases: [],
    description: "Show diff and verification context",
    type: "command",
  },
  {
    name: "/fork",
    aliases: [],
    description: "Fork the current chat session",
    type: "command",
  },
  {
    name: "/undo",
    aliases: [],
    description: "Remove the latest chat turn",
    type: "command",
  },
];

const GOAL_ARG_COMMANDS = ["/run ", "/start "];

function isExactCommandMatch(input: string): boolean {
  const normalized = input.trim().toLowerCase();
  return COMMANDS.some((cmd) => {
    if (cmd.name.toLowerCase() === normalized) {
      return true;
    }
    return cmd.aliases.some((alias) => {
      const normalizedAlias = alias.startsWith("/") ? alias : `/${alias}`;
      return normalizedAlias.toLowerCase() === normalized;
    });
  });
}

export function getMatchingSuggestions(
  input: string,
  goalNames: string[],
): Suggestion[] {
  if (!input.startsWith("/")) {
    return [];
  }
  if (isExactCommandMatch(input)) {
    return [];
  }

  for (const prefix of GOAL_ARG_COMMANDS) {
    if (input.startsWith(prefix)) {
      const goalQuery = input.slice(prefix.length);
      if (
        goalNames.some((goal) => goal.toLowerCase() === goalQuery.toLowerCase())
      ) {
        return [];
      }
      const matchedGoals = fuzzyFilter(goalQuery, goalNames, (g) => g, 6);
      return matchedGoals.map((g) => ({
        name: prefix.trimEnd(),
        description: g,
        aliases: [],
        type: "goal",
      }));
    }
  }

  const query = input.slice(1);
  if (!query) {
    return COMMANDS.map((cmd) => ({ ...cmd }));
  }

  const scored: Array<{ cmd: Suggestion; score: number }> = [];

  for (const cmd of COMMANDS) {
    const nameScore = fuzzyMatch(query, cmd.name.slice(1));
    const aliasScores = cmd.aliases.map((a) =>
      a.startsWith("/") ? fuzzyMatch(query, a.slice(1)) : fuzzyMatch(query, a),
    );
    const bestAlias = aliasScores.reduce<number | null>(
      (best, s) => (s !== null && (best === null || s > best) ? s : best),
      null,
    );
    const best =
      nameScore !== null && (bestAlias === null || nameScore >= bestAlias)
        ? nameScore
        : bestAlias;

    if (best !== null) {
      scored.push({ cmd, score: best });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 6).map((s) => s.cmd);
}
