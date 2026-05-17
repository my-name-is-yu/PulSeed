# Runbooks Map

This map groups current operator workflows. Exact commands remain in the command
reference; runbooks explain the order of checks and the handoff between user
surface, daemon, gateway, and diagnostics.

```mermaid
flowchart TD
  runbooks["Runbooks"]
  chat["Chat And TUI Operations"]
  gateway["Daemon And Gateway Readiness"]
  trace["Runtime Trace Triage"]

  runbooks --> chat
  runbooks --> gateway
  runbooks --> trace
```

## Runbooks

- [Chat And TUI Operations](./chat-tui-operations.md)
- [Daemon And Gateway Readiness](./daemon-gateway-readiness.md)
- [Runtime Trace Triage](./runtime-trace-triage.md)
