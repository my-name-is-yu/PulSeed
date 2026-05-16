# Plugin Reference

> Status: Current plugin reference. This page describes supported native plugin manifests and guarded foreign-plugin import boundaries.

PulSeed supports native plugin manifests and a guarded foreign-plugin import
path.

## Native Plugin Manifests

Native plugins can use `plugin.yaml` or `plugin.json`.

Current plugin types:

- `adapter`
- `data_source`
- `notifier`
- `schedule_source`

Current permission names:

- `network`
- `file_read`
- `file_write`
- `shell`

Plugin loading validates manifest shape, semantic version compatibility,
entry-point boundaries, and load failures. A load failure should not bring down
the whole runtime.

## Foreign Plugins

Foreign plugin imports are copied into quarantine and recorded with a
compatibility report. They are evidence for review and conversion, not
runtime-loadable plugins by default.

## Commands

```bash
pulseed plugin list
pulseed plugin install <path|package>
pulseed plugin update <name>
pulseed plugin search <keyword>
pulseed plugin remove <name>
```

Related gateway channel setup lives under [Runtime](../operate/runtime.md).
