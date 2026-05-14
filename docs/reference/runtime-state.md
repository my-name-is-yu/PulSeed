# Runtime State Reference

PulSeed stores local state under `~/.pulseed/` by default. Set `PULSEED_HOME` to
use a different root.

Common paths and boundaries:

- `provider.json`: provider, model, adapter, and native AgentLoop settings
- `.env`: optional provider environment fallback values
- `state/pulseed-control.sqlite`: control database used by current runtime
  ownership paths
- `state/pulseed-memory.sqlite` and Soil SQLite stores: typed memory,
  knowledge, retrieval, and projection metadata where enabled
- `goals/`, `tasks/`, `runtime/`, `schedule/`, and `chat/`: logical feature
  areas that may contain compatibility inputs, summaries, logs, or artifacts;
  current durable runtime truth belongs to typed stores unless a file boundary is
  explicitly documented
- `reports/`: generated goal reports and reproducibility artifacts
- `plugins/`: installed PulSeed-native plugins
- `plugins-imported-disabled/`: quarantined foreign plugin imports
- `skills/`: imported local skills
- `memory/`: memory, knowledge, and Soil projection artifacts
- `logs/`: daemon/runtime logs
- `datasources/`: configured data source records

Do not treat every file under the state root as a documented contract. Docs
only promise the documented command surfaces and high-level storage boundaries.

## State Truth Boundary

Current durable runtime state is owned by typed SQLite/Soil/control DB stores.
Legacy JSON, JSONL, lock, sidecar, and raw `StateManager` fallback paths are not
authoritative normal runtime state unless they are explicitly categorized as
configuration, user-authored content, workspace content, debug/export output,
bounded IPC spool, Soil import/publish artifact, reproducibility artifact, or
doctor/repair migration input.

Run `npm run check:database-first-legacy-stores` to verify that boundary. The
machine-readable `allowlistReport`, `debtReport`, `directFileOwnerReport`, and
`directFileDebtReport` from the guard define the current non-debt file-backed
surfaces.
