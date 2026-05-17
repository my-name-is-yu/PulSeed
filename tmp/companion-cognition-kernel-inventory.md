# Companion Cognition Kernel Inventory

This inventory tracks production prompt/policy assembly paths, direct LLM prompt builders, memory-use policy shortcuts, action/response policy shortcuts, commitment/attention policy paths, and their migration decisions for the companion cognition kernel rollout.

## Kickoff State

- Base: `origin/main` after PR #2000, commit recorded by the branch history.
- Draft PR must exist before broad implementation begins.
- This file starts as the inventory artifact and will be expanded as code inspection identifies each path.

## Production Paths

| Area | Current path | Decision | Evidence |
| --- | --- | --- | --- |
| Chat turn / ChatRunner | TBD | Pending inspection | Pending |
| Resident proactive / peer initiative | TBD | Pending inspection | Pending |
| Schedule wake / daemon wake | TBD | Pending inspection | Pending |
| Runtime-control response / tool-adjacent action | TBD | Pending inspection | Pending |
| Memory correction / recall behavior | TBD | Pending inspection | Pending |

## Allowed Boundaries

| Boundary | Why allowed | Guard evidence |
| --- | --- | --- |
| Provider adapters | Pending inspection | Pending |
| Diagnostics/operator surfaces | Pending inspection | Pending |
| Eval fixtures | Pending inspection | Pending |
| Tests/migrations | Pending inspection | Pending |

