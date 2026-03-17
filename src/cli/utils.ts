// ─── CLI Shared Utilities ───

export function formatOperationError(operation: string, err: unknown): string {
  if (err instanceof Error) {
    return `Operation "${operation}" failed. Original error: ${err.name}: ${err.message}`;
  }
  return `Operation "${operation}" failed. Original error: ${String(err)}`;
}

export function printUsage(): void {
  console.log(`
Motiva — AI agent orchestrator

Usage:
  motiva run --goal <id>              Run CoreLoop for a goal
  motiva improve [path]               Analyze path, suggest goals, and optionally run improvement loop
  motiva suggest "<context>"          Suggest improvement goals for a project context
  motiva goal add --title "<t>" --dim "name:type:val"  Register a goal (raw mode, no LLM)
  motiva goal add "<description>" --negotiate          Register a goal via LLM negotiation
  motiva goal list                    List all registered goals
  motiva goal list --archived         Also list archived goals
  motiva goal archive <id>            Archive a completed goal (moves state to ~/.motiva/archive/)
  motiva goal remove <id>             Remove a goal by ID
  motiva goal show <id>               Show goal details (dimensions, constraints, deadline)
  motiva goal reset <id>              Reset goal state for re-running
  motiva cleanup                      Archive all completed goals and remove stale data
  motiva status --goal <id>           Show current status and progress
  motiva report --goal <id>           Show latest report
  motiva log --goal <id>              View observation and gap history log
  motiva tui                          Launch the interactive TUI
  motiva start --goal <id>            Start daemon mode for one or more goals
  motiva stop                         Stop the running daemon
  motiva cron --goal <id>             Print crontab entry for a goal
  motiva config character             Show or update character configuration
  motiva datasource add <type>        Register a new data source (file | http_api)
  motiva datasource list              List all registered data sources
  motiva datasource remove <id>       Remove a data source by ID
  motiva capability list              List all registered capabilities
  motiva capability remove <name>     Remove a capability by name
  motiva plugin list                  List installed plugins
  motiva plugin install <path>        Install a plugin from a local directory
  motiva plugin remove <name>         Remove an installed plugin
  motiva provider show                Show current provider config
  motiva provider set                 Set LLM provider and/or default adapter

Options (motiva run):
  --goal <id>                         Goal ID to run (required)
  --max-iterations <n>               Override max iterations (default: 100)
  --adapter <type>                    Adapter: claude_api | claude_code_cli | github_issue (default: claude_api)
  --tree                              Enable tree mode (iterate across all tree nodes)
  --yes, -y                           Auto-approve all tasks (skip approval prompts)

Options (motiva improve):
  --auto                              Full auto mode (select best suggestion, run loop)
  --yes                               Auto-approve (select first suggestion, run loop)
  --max, -n <n>                       Max suggestions (default: 3)

Options (motiva suggest):
  --max, -n <n>                       Max number of suggestions (default: 5)
  --path, -p <dir>                    Repo path to scan for additional context

Options (motiva goal add):
  --title <title>                     Goal title (raw mode)
  --dim <name:type:value>             Dimension spec, repeatable (raw mode, e.g. "tsc_error_count:min:0")
  --negotiate                         Use LLM negotiation instead of raw mode
  --deadline <ISO-date>               Optional deadline (e.g. 2026-06-01)
  --constraint <text>                 Optional constraint (repeatable)

Options (motiva config character):
  --show                              Show current character config
  --reset                             Reset to defaults
  --caution-level <1-5>               Feasibility threshold (1=conservative, 5=ambitious)
  --stall-flexibility <1-5>           Stall tolerance (1=pivot fast, 5=persistent)
  --communication-directness <1-5>    Output style (1=considerate, 5=direct)
  --proactivity-level <1-5>           Report verbosity (1=events-only, 5=always-detailed)

Options (motiva datasource add):
  --name <name>                       Human-readable name for the data source
  --path <path>                       File path (required for type=file)
  --url <url>                         HTTP URL (required for type=http_api)

Options (motiva provider set):
  --llm <provider>                    LLM provider: anthropic | openai | ollama | codex
  --adapter <type>                    Default adapter: claude_code_cli | claude_api | openai_codex_cli | openai_api | github_issue

Environment:
  ANTHROPIC_API_KEY                   Required for LLM-powered commands
  MOTIVA_LLM_PROVIDER                 Override LLM provider (anthropic|openai|ollama|codex)

Examples:
  motiva goal add --title "tsc zero" --dim "tsc_error_count:min:0"
  motiva goal add --title "clean code" --dim "todo_count:max:0" --dim "fixme_count:max:0"
  motiva goal add "Increase test coverage to 90%" --negotiate
  motiva goal list
  motiva goal show <id>
  motiva goal reset <id>
  motiva run --goal <id>
  motiva status --goal <id>
  motiva report --goal <id>
  motiva log --goal <id>
  motiva config character --show
  motiva config character --caution-level 3
  motiva datasource add file --path /path/to/metrics.json --name "My Metrics"
  motiva datasource add http_api --url https://api.example.com/metrics --name "API"
  motiva datasource list
  motiva datasource remove ds_1234567890
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
