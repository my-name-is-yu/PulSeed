// ─── CLI Shared Utilities ───

export function formatOperationError(operation: string, err: unknown): string {
  if (err instanceof Error) {
    return `Operation "${operation}" failed. Original error: ${err.name}: ${err.message}`;
  }
  return `Operation "${operation}" failed. Original error: ${String(err)}`;
}

export function printUsage(): void {
  console.log(`
Tavori — AI agent orchestrator

Usage:
  tavori run --goal <id>              Run CoreLoop for a goal
  tavori improve [path]               Analyze path, suggest goals, and optionally run improvement loop
  tavori suggest "<context>"          Suggest improvement goals for a project context
  tavori goal add --title "<t>" --dim "name:type:val"  Register a goal (raw mode, no LLM)
  tavori goal add "<description>"                      Register a goal via GoalRefiner (default)
  tavori goal add "<description>" --no-refine          Register a goal via legacy LLM negotiation
  tavori goal list                    List all registered goals
  tavori goal list --archived         Also list archived goals
  tavori goal archive <id>            Archive a completed goal (moves state to ~/.tavori/archive/)
  tavori goal remove <id>             Remove a goal by ID
  tavori goal show <id>               Show goal details (dimensions, constraints, deadline)
  tavori goal reset <id>              Reset goal state for re-running
  tavori cleanup                      Archive all completed goals and remove stale data
  tavori status --goal <id>           Show current status and progress
  tavori report --goal <id>           Show latest report
  tavori log --goal <id>              View observation and gap history log
  tavori tui                          Launch the interactive TUI
  tavori start --goal <id>            Start daemon mode for one or more goals
  tavori stop                         Stop the running daemon
  tavori cron --goal <id>             Print crontab entry for a goal
  tavori config character             Show or update character configuration
  tavori datasource add <type>        Register a new data source (file | http_api)
  tavori datasource list              List all registered data sources
  tavori datasource remove <id>       Remove a data source by ID
  tavori capability list              List all registered capabilities
  tavori capability remove <name>     Remove a capability by name
  tavori knowledge list               List all shared knowledge entries
  tavori knowledge search <query>     Search knowledge entries by keyword
  tavori knowledge stats              Show knowledge base statistics
  tavori plugin list                  List installed plugins
  tavori plugin install <path>        Install a plugin from a local directory
  tavori plugin remove <name>         Remove an installed plugin
  tavori setup                        Interactive setup wizard (first-time configuration)
  tavori provider show                Show current provider config
  tavori provider set                 Set LLM provider and/or default adapter

Options (tavori run):
  --goal <id>                         Goal ID to run (required)
  --max-iterations <n>               Override max iterations (default: 100)
  --adapter <type>                    Adapter: claude_api | claude_code_cli | github_issue (default: claude_api)
  --tree                              Enable tree mode (iterate across all tree nodes)
  --yes, -y                           Auto-approve all tasks (skip approval prompts)

Options (tavori improve):
  --auto                              Full auto mode (select best suggestion, run loop)
  --yes                               Auto-approve (select first suggestion, run loop)
  --max, -n <n>                       Max suggestions (default: 3)

Options (tavori suggest):
  --max, -n <n>                       Max number of suggestions (default: 5)
  --path, -p <dir>                    Repo path to scan for additional context

Options (tavori goal add):
  --title <title>                     Goal title (raw mode)
  --dim <name:type:value>             Dimension spec, repeatable (raw mode, e.g. "tsc_error_count:min:0")
  --no-refine                         Skip GoalRefiner, use legacy negotiate() instead
  --negotiate                         Alias: same as default (refine mode)
  --deadline <ISO-date>               Optional deadline (e.g. 2026-06-01)
  --constraint <text>                 Optional constraint (repeatable)

Options (tavori config character):
  --show                              Show current character config
  --reset                             Reset to defaults
  --caution-level <1-5>               Feasibility threshold (1=conservative, 5=ambitious)
  --stall-flexibility <1-5>           Stall tolerance (1=pivot fast, 5=persistent)
  --communication-directness <1-5>    Output style (1=considerate, 5=direct)
  --proactivity-level <1-5>           Report verbosity (1=events-only, 5=always-detailed)

Options (tavori datasource add):
  --name <name>                       Human-readable name for the data source
  --path <path>                       File path (required for type=file)
  --url <url>                         HTTP URL (required for type=http_api)

Options (tavori provider set):
  --llm <provider>                    LLM provider: anthropic | openai | ollama | codex
  --adapter <type>                    Default adapter: claude_code_cli | claude_api | openai_codex_cli | openai_api | github_issue

Environment:
  ANTHROPIC_API_KEY                   Required for LLM-powered commands
  TAVORI_LLM_PROVIDER                 Override LLM provider (anthropic|openai|ollama|codex)

Examples:
  tavori goal add --title "tsc zero" --dim "tsc_error_count:min:0"
  tavori goal add --title "clean code" --dim "todo_count:max:0" --dim "fixme_count:max:0"
  tavori goal add "Increase test coverage to 90%"
  tavori goal add "Increase test coverage to 90%" --no-refine
  tavori goal list
  tavori goal show <id>
  tavori goal reset <id>
  tavori run --goal <id>
  tavori status --goal <id>
  tavori report --goal <id>
  tavori log --goal <id>
  tavori config character --show
  tavori config character --caution-level 3
  tavori datasource add file --path /path/to/metrics.json --name "My Metrics"
  tavori datasource add http_api --url https://api.example.com/metrics --name "API"
  tavori datasource list
  tavori datasource remove ds_1234567890
`.trim());
}

export function printCharacterConfig(config: {
  caution_level: number;
  stall_flexibility: number;
  communication_directness: number;
  proactivity_level: number;
}): void {
  console.log(`  caution_level:              ${config.caution_level}  (1=conservative, 5=ambitious)`);
  console.log(`  stall_flexibility:          ${config.stall_flexibility}  (1=pivot fast, 5=persistent)`);
  console.log(`  communication_directness:   ${config.communication_directness}  (1=considerate, 5=direct)`);
  console.log(`  proactivity_level:          ${config.proactivity_level}  (1=events-only, 5=always-detailed)`);
}
