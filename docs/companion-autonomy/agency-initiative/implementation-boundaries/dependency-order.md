# Dependency Order

> Status: Active design contract. Verify exact behavior against source code and current operating docs.
> Doc status: active_design_contract
> Grounding use: design_context

Primary map: [Implementation Boundaries](./implementation-boundaries-map.md).

## Contract Dependency Order

The contracts should be introduced in dependency order:

1. Foundation schemas: governed memory, Surface, runtime
   item, then remaining permission work.
2. State and attention contracts after their inputs exist.
3. Invalidation and control behavior.
4. Decisions, visibility, and audit.
5. Dependent contract groups, keeping caller-path tests with the first
   production integration in each group.
6. Multi-surface parity after shared decisions, visibility, audit, and
   permission contracts are consumed by at least one production path.

This order avoids surfaces or adapters becoming the policy owner before the
shared contracts exist.

## Review Checklist

- Does any change classify freeform intent, approval, routing, safety,
  permission, control, or target selection with keyword, regex, `includes`, or
  title matching?
- Does any behavior reuse a stale Surface, stale session, stale grant, prior
  target, or previous run plan without explicit compatibility evidence?
- Can deleted or tombstoned content leak through Surface snapshots, audit,
  debug, inspection, runtime events, decisions, or derived rationale?
- Do surfaces render shared decisions instead of recreating permission,
  staleness, visibility, or outcome policy locally?
- Are denied approvals, expired grants, and failed authority checks represented
  as non-execution state rather than summarized as completed work?
- Does every parent contract with runtime behavior have at least one
  production caller-path test once production behavior is added?
- Is quiet work inspectable and interruptible without becoming user-facing
  noise by default?
- Are memory, relationship context, and permission grants kept as separate
  contracts?
