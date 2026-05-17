# Contract Sources

> Status: Active design contract. Verify exact behavior against source code and current operating docs.

Primary map: [Implementation Boundaries](./implementation-boundaries-map.md).

This note records the source contract families used by the companion-autonomy
implementation map. It intentionally links to cluster maps instead of every leaf
contract so Obsidian shows the dependency as a few conceptual edges.

## Source Clusters

- [Agency And Initiative](../agency-initiative-map.md)
- [Implementation Boundaries](./implementation-boundaries-map.md)

## Source Contracts

The parent contracts are design lanes, not GitHub issue identifiers:

| Contract | Primary source design |
| --- | --- |
| `SurfaceProjection` selection gates | Relationship Memory And Surface |
| `CoreCompanionMemoryProjection` decision input | Core Companion Memory Projection |
| deterministic `CompanionState` reducer | Attention Metabolism And Initiative |
| `GovernedMemory` record-kind ownership | Relationship Memory And Surface |
| `SurfaceInvalidationPolicy` and invalidation events | Relationship Memory And Surface, Runtime Control Plane |
| companion-wide controls and fail-closed resume | Runtime Control Plane |
| `OutcomeDecision` and `ExpressionDecision` | Attention Metabolism And Initiative, Runtime Control Plane |
| `UrgeCandidate`, `AgentAgendaItem`, and initiative gate | Attention Metabolism And Initiative |
| `RuntimeItem`, authority, staleness, and control policy | Runtime Control Plane |
| `AuditTrace` and `VisibilityPolicy` | Runtime Control Plane |
| `PermissionGrant` lifecycle and evaluator parent | Runtime Control Plane |
| `CompanionCognitionOutput` turn/intervention advisory artifact | Companion Decision Contract |
| `CompanionGadgetPlan` over verified capability operations | Companion Gadget Planning, Companion Capability Runtime |
| end-to-end companion behavior eval plan | Companion Behavior Evals |

The core flow remains:

```text
evidence and traces
  -> GovernedMemory
  -> SurfaceProjection
  -> CoreCompanionMemoryProjection
  -> CompanionStateSnapshot
  -> UrgeCandidate / AgentAgendaItem
  -> InitiativeGateDecision
  -> CompanionCognitionOutput
  -> CompanionGadgetPlan
  -> RuntimeItem admission
  -> SurfaceResponseGuidance
  -> OutcomeDecision
  -> ExpressionDecision
  -> AuditTrace / VisibilityPolicy
  -> correction, invalidation, and permission updates
```

No layer may use remembered context, stale Surface, prior target selection, or
natural-language approval text as direct authority for side effects.
