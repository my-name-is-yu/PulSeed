# Operator Systems Map

This map groups operator-facing systems that are current enough to reference
from runbooks.

```mermaid
flowchart TD
  systems["Operator Systems"]
  schedules["Schedules"]
  gateway["Gateway Channels"]
  mcp["MCP"]
  plugins["Plugins"]
  memory["Memory"]
  projection["Surface Projection"]

  systems --> schedules
  systems --> gateway
  systems --> mcp
  systems --> plugins
  systems --> memory
  systems --> projection
```

## Reference

- [Schedules](./schedules.md)
- [Gateway Channels](./gateway-channels.md)
- [MCP](./mcp.md)
- [Plugins](./plugins.md)
- [Memory](./memory.md)
- [Surface Projection Protocol](./surface-projection-protocol.md)
