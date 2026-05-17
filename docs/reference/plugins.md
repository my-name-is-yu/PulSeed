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

Plugin import is proposal-first. A valid native manifest records a disabled
plugin state and Capability Plane proposal instead of importing the entry point
or registering adapter/data-source/notifier/schedule implementations by
default. Runtime enable/run requires a `CapabilityDescriptor` mapping,
operator review, approval fingerprint checks for side-effecting operations, and
operation-specific verification. The legacy import path is reserved for
explicit compatibility/test boundaries.

Plugin capabilities are represented as descriptor-backed providers:

- `adapter` plugins map to direct-adapter capabilities and cannot execute
  outside the `run-adapter` ToolExecutor path or another explicit Capability
  Plane boundary.
- `notifier` and gateway-channel sends route through descriptor-backed
  notification authority before delivery.
- `data_source` and `schedule_source` proposals remain non-executable until
  reviewed, mapped, and verified for their operation class.

Normal chat/status surfaces do not expose plugin credential scope, approval
fingerprints, or raw catalog internals. Use `pulseed runtime capability explain
<capability-id>` for operator diagnostics.

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
