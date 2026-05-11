# Runtime State Reference

PulSeed stores local state under `~/.pulseed/` by default. Set `PULSEED_HOME` to
use a different root.

Common paths:

- `provider.json`: provider, model, adapter, and native AgentLoop settings
- `.env`: optional provider environment fallback values
- `goals/`: goal records
- `tasks/`: task records
- `reports/`: generated goal reports
- `runtime/`: runtime sessions, runs, evidence, health, queues, and logs
- `state/pulseed-control.sqlite`: control database used by current runtime
  ownership paths
- `schedule/`: schedule entries, history, suggestions, and budget state
- `chat/`: chat sessions and summaries
- `plugins/`: installed PulSeed-native plugins
- `plugins-imported-disabled/`: quarantined foreign plugin imports
- `skills/`: imported local skills
- `memory/`: memory and knowledge artifacts
- `logs/`: daemon/runtime logs
- `datasources/`: configured data source records

Do not treat every file under the state root as a public contract. Public docs
only promise the documented command surfaces and high-level storage boundaries.
