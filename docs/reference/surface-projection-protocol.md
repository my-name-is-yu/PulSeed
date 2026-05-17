# Surface Projection Protocol

> Status: Current reference. This page describes the shared projection contract
> used by current user-visible surfaces and the explicit current boundaries.

PulSeed's user-visible surfaces should render a typed `SurfaceProjection`
instead of directly exposing raw traces, memory internals, policy rationale,
RuntimeGraph refs, or approval fingerprints.

The public contract lives in `src/runtime/surface-projection-protocol.ts` and
is exported from `src/index.ts`. It defines:

- `SurfaceProjectionSchema`: the shared envelope for projected surface content
- `SurfaceNormalViewSchema`: the redacted normal-user view
- `SurfaceOperatorDebugViewSchema`: the operator/debug view for diagnostics
- `SurfaceActionBindingSchema`: replay-safe bindings for surface actions
- `SurfaceApprovalPromptSchema`: approval prompt projection metadata
- `SurfaceMemorySummarySchema`: redacted memory/profile summary metadata
- `UnifiedSurfaceDeliveryProjectionSchema`: delivery projection metadata for
  transport surfaces

## Current Migrated Surfaces

Current production callers project through the shared contract for:

- chat and gateway assistant output
- gateway dispatch output
- CLI runtime `sessions --json` and `runs --json`
- TUI runtime dashboard status models
- Telegram peer initiative delivery and callback bindings
- conversational approval prompts
- reflection relationship-profile memory summaries

The normal view is fail-closed around internals. A normal projection cannot
carry operator/debug refs or an `operator_debug_view`; debug projection refs
belong only to `operator_debug` surfaces.

## Action Bindings

Buttons or callbacks that can mutate state should use `SurfaceActionBinding`.
Bindings carry the action kind, source projection, target entity, surface
instance, replay key, creation/expiry metadata, and redaction class.

Production validation uses `validateSurfaceActionBinding(...)` before executing
bound actions. The validator rejects stale, expired, wrong-surface,
wrong-target, wrong-action, or wrong-replay bindings. Telegram peer initiative
callbacks use this path for `psb1:` binding callbacks. Older candidate-only
callback payloads are acknowledged but fail closed before feedback or trigger
mutation.

## Boundaries

Operator/debug commands may expose raw event IDs, trace IDs, RuntimeGraph refs,
authority refs, and rebuild evidence through explicit diagnostic commands.
Normal chat, gateway, CLI, TUI-adjacent, approval, Telegram, and memory summary
surfaces should consume redacted projections.

GUI/mobile/visual companion workflows and non-Telegram peer delivery surfaces
remain design-only or contract-only until a production caller path owns delivery,
action validation, and tests.

## Checks

`npm run check:public-contracts` includes
`scripts/check-surface-projection-boundaries.mjs`. The guard verifies the public
exports and rejects normal-surface consumers that introduce operator/debug refs
or raw visibility flags outside the protocol.
