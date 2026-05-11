# Schedule Reference

PulSeed schedules are managed by the ScheduleEngine.

## Layers

- `heartbeat`: health checks for HTTP, TCP, process, disk, or custom command
- `probe`: data-source probing and change detection
- `cron`: prompt, reflection, or Soil publish jobs
- `goal_trigger`: goal execution trigger

## Triggers

- `cron`: cron expression with timezone
- `interval`: seconds plus optional jitter

## Presets

- `daily_brief`
- `weekly_review`
- `dream_consolidation`
- `soil_publish`
- `goal_probe`

## Commands

```bash
pulseed schedule list [--all]
pulseed schedule show <id>
pulseed schedule add --preset daily_brief
pulseed schedule edit <id>
pulseed schedule pause <id>
pulseed schedule resume <id>
pulseed schedule run <id>
pulseed schedule history <id> --limit 10
pulseed schedule cost --period 7d
pulseed schedule remove <id>
pulseed schedule presets
pulseed schedule suggestions list
```

Internal wait-resume entries are hidden by default. Use `list --all` or
`show <id>` when debugging internal projections.
