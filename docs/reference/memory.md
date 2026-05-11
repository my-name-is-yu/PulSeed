# Memory Reference

PulSeed exposes auditable memory operations through `pulseed memory`.

## Operations

```bash
pulseed memory correct <kind:id> --value "Prefer concise reports"
pulseed memory forget <kind:id> --reason "No longer true"
pulseed memory retract <kind:id> --reason "Added by mistake"
pulseed memory history <kind:id>
pulseed memory export [--consent-scope id] [--include-secret]
```

Supported target kinds include:

- `agent_memory`
- `soil_record`
- `runtime_evidence`
- `dream_checkpoint`

The command rejects `--destructive-delete`. The default path is correction,
forgetting, retraction, history, and export with audit/provenance records.

## Relationship To Soil And Playbooks

Soil is the readable long-term memory surface used by runtime and bounded
execution. Dream-backed playbooks are verified procedural memory artifacts. They
are not auto-generated skills and do not overwrite `SKILL.md` files.
