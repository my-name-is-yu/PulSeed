# Ownership Boundaries

> Status: Active design contract. Verify exact behavior against source code and current operating docs.
> Doc status: active_design_contract
> Grounding use: design_context

Primary map: [Implementation Boundaries](./implementation-boundaries-map.md).

## Initial Non-Goals

This map does not:

- implement broad production caller-path behavior
- add TypeScript contract modules
- change runtime-control admission behavior
- change grounding, profile, permission, or tool execution behavior
- add new semantic keyword, regex, `includes`, or title-matching logic
- make design-lane ownership decisions part of runtime policy

Related implementation work should use this map as an ownership guide, not as a
license to implement adjacent contracts opportunistically.

## Cross-Lane Ownership Boundaries

| Boundary | Owning design area | Implementation owner | This map's role |
| --- | --- | --- | --- |
| Governed memory record ownership | memory/profile/Soil/Dream contract | memory/profile/Soil/Dream contract modules | Defines contract-to-module placement only |
| Surface selection and invalidation | Surface projection and invalidation | grounding and Surface contract modules | Records shared dependency rules |
| Companion state reducer | companion state | attention/state reducer modules | Records reducer inputs and caller-path harness placement |
| Urge and agenda pipeline | attention metabolism | attention pipeline modules | Keeps signal, urge, agenda, inhibition, and gate separate |
| Runtime item authority and staleness | runtime control | runtime-control modules | Keeps status, posture, authority, staleness, and control policy separate |
| Companion-wide controls and resume | runtime control | runtime-control modules | Marks fail-closed controls and stale resume tests as required |
| Outcome and expression decisions | attention/runtime decisions | runtime/grounding decision modules | Prevents surfaces from recreating permission or visibility policy |
| Audit and visibility | runtime visibility/audit | runtime visibility/audit modules | Marks redaction and inspectability as shared policy |
| Permission grants | runtime permission | runtime permission modules | Keeps grants explicit, scoped, stale-aware, and revocable |
| Completed permission persistence and policy integration | runtime permission dependencies | runtime permission modules | Treat as dependency context; do not duplicate in permission work |
| Waiting permission resume | runtime permission dependencies | runtime permission modules | Keep stored-plan resume tests as dependency context |
| Multi-surface rendering | surface integration | surface integration modules | Surfaces render shared decisions; they do not own policy |

If a module needs a field owned by another boundary, the design should name that
dependency explicitly instead of duplicating ownership.
