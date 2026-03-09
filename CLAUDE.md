# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Motive Layer — Python framework that gives AI agents "motivation" via Claude Code Hooks. Intercepts lifecycle events (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, Stop) as Python CLI subprocesses, maintaining goal/gap/constraint state to drive autonomous task selection and completion judgment.

## Status

PoC phase on `poc/motive-layer` branch. `main` branch preserves the pre-implementation state for rollback. Global settings backup at `~/.claude/settings.json.pre-motive`.

## Tech Stack

- Python 3.11+, pydantic>=2.0, pyyaml>=6.0, click>=8.0
- No LLM SDK — this package is called BY Claude Code, not the caller
- State persistence: file-based JSON (no HTTP daemon)

## Build & Test

```bash
pip install -e ".[dev]"        # editable install (once pyproject.toml exists)
pytest tests/                   # run all tests
pytest tests/test_engines/      # run engine tests only
python -m motive_layer.hooks.session_start  # test individual hook via stdin JSON
```

## Architecture

### Integration: Claude Code Hooks → `python -m motive_layer.hooks.*`
Each hook reads/writes `.motive/state.json` (atomic temp-file-rename). Hook config goes in the **host project's** `.claude/settings.json`.

### Package Layout
```
src/motive_layer/
├── cli.py                 # motive init|status|add-goal|goals|log|gc|reset
├── hooks/                 # 6 modules (session_start, user_prompt, pre_tool_use, post_tool_use, post_tool_failure, stop)
├── engines/               # gap_analysis, task_generation, stall_detection, satisficing, priority_scoring, curiosity
├── state/                 # manager (atomic persistence), models (Pydantic), migration
├── collaboration/         # trust balance, behavior matrix, irreversible action detection
├── context/               # injector — generates .claude/rules/motive.md (≤500 tokens)
└── learning/              # action logger (log.jsonl), pattern_analyzer
```

### State Files (in host project)
- `.motive/state.json` — session state, trust balance, active goals
- `.motive/goals/*.json` — individual goal definitions
- `.motive/log.jsonl` — action log (state_before → action → state_after)
- `.motive/config.yaml` — user-configurable thresholds

### Build Order (design.md §9)
Phase 1 (state models + gap analysis + CLI) → Phase 2 (engines) → Phase 3 (hooks) → Phase 4 (trust + learning) → Phase 5 (integration tests)

## Key Constraints

- Each hook must complete in <300ms (SessionStart <200ms) — Python process spawn overhead is a known risk
- Irreversible actions (git push, rm -rf, deploy, DROP TABLE) always require human approval regardless of trust/confidence
- `.motive/` should be in `.gitignore` of host projects
- `motive.md` context injection must stay ≤500 tokens

## Design References

- `concept.md` — concept definition (4-element model, motivation types, satisficing)
- `design.md` — full architecture spec (state schema, hook specs, engine pseudocode, scoring formulas)


# PoC がダメだった場合の復元コマンド
  cp ~/.claude/settings.json.pre-motive ~/.claude/settings.json
  cd ~/Documents/dev/Motiva && git checkout main