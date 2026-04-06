# WaitStrategy Design Document

> Cross-cutting concern: WaitStrategy is not a standalone module. It is a schema
> (`strategy/types/strategy.ts`) with behavior split across PortfolioManager,
> StallDetector, and TimeHorizonEngine. This document describes the integration.

---

## 1. Why WaitStrategy Exists

"Waiting" is also a judgment. It takes time for initiatives to show results after
being launched. Knowing when to measure for meaningful results — this sense of
timing is also part of strategy. (vision.md §5.4)

Many actions have delayed effects: deploying a marketing campaign, publishing
documentation, training a model. When PulSeed detects no gap improvement after
such an action, the correct response is sometimes "wait and re-measure," not
"pivot." WaitStrategy formalizes this decision so that intentional waits are
distinguishable from genuine stalls (see stall-detection.md §6).

---

## 2. Responsibility Boundary

| Module | Responsibility |
|--------|----------------|
| **TimeHorizonEngine** | "Can we afford to wait?" — time accounting via `canAffordWait` closure (time-horizon.md §10) |
| **WaitStrategy (via PortfolioManager)** | "Should we wait?" — strategic decision: generation, lifecycle, fallback (portfolio-management.md §7) |
| **StallDetector** | "Is progress happening?" — detection engine; suppresses stall alerts when `plateau_until` is set (stall-detection.md §2.5) |

No single module owns the full wait lifecycle. This is intentional — each module
answers exactly one question.

---

## 3. Type Reference

WaitStrategy extends the base `Strategy` schema defined in
`src/orchestrator/strategy/types/strategy.ts`:

```typescript
// Base strategy has: id, goal_id, target_dimensions, description,
// expected_effect, state, allocation, effectiveness_score, pivot_count,
// max_pivot_count, required_tools, ...

export const WaitStrategySchema = StrategySchema.extend({
  wait_reason: z.string(),               // Why we are waiting (natural language)
  wait_until: z.string(),                // ISO datetime — when to re-evaluate
  measurement_plan: z.string(),          // How to measure if waiting was worthwhile
  fallback_strategy_id: z.string().nullable(), // Strategy to activate if wait fails
});
export type WaitStrategy = z.infer<typeof WaitStrategySchema>;
```

Duck-type detection (no `instanceof` — strategies are plain objects):

```typescript
// src/orchestrator/strategy/portfolio-allocation.ts
export function isWaitStrategy(strategy: Record<string, unknown>): boolean {
  return (
    typeof strategy["wait_reason"] === "string" &&
    typeof strategy["wait_until"] === "string" &&
    typeof strategy["measurement_plan"] === "string"
  );
}
```

---

## 4. Execution Flow

The lifecycle is documented in portfolio-management.md §7.3. This section adds
the `canAffordWait` gate that connects TimeHorizonEngine to the decision.

```
Stall detected (StallDetector §2.1-§2.4)
  │
  ├─ Is this an intentional wait? (portfolio: isWaitStrategy)
  │   yes ─┐
  │        ▼
  │   canAffordWait(wait_until - now)?
  │     yes → set plateau_until, suppress stall (stall-detection.md §2.5)
  │            no tasks generated; allocation reserved (portfolio-management.md §7.4)
  │     no  → genuine stall; apply graduated response (stall-detection.md §4)
  │
  └─ Not a wait → normal stall handling
```

**CoreLoop integration** (`src/orchestrator/loop/core-loop-phases-b.ts`,
`rebalancePortfolio` function):

1. After stall detection and portfolio rebalance, CoreLoop iterates all strategies
   in the portfolio.
2. For each strategy where `isWaitStrategy(strategy)` returns true, it calls
   `portfolioManager.handleWaitStrategyExpiry(goalId, strategy.id)`.
3. `handleWaitStrategyExpiry` checks whether `wait_until` has passed:
   - **Gap improved** → return null (wait succeeded, let evaluation continue)
   - **Gap unchanged** → activate `fallback_strategy_id` if one exists
   - **Gap worsened** → return a rebalance trigger
4. If a rebalance trigger is returned, `portfolioManager.rebalance` is called.

---

## 5. No-Deadline Behavior

`canAffordWait` is a closure returned within `TimeBudgetWithWait` from
`TimeHorizonEngine.getTimeBudget()`:

```typescript
const canAffordWait = (waitHours: number): boolean => {
  if (capturedVelocity <= 0) return false;
  if (capturedRemainingHours === null) return true; // no deadline
  const newRemainingHours = capturedRemainingHours - waitHours;
  if (newRemainingHours <= 0) return false;
  const newRequiredVelocity = capturedCurrentGap / newRemainingHours;
  // ... checks against critical threshold
};
```

Key behavior:
- **No deadline + positive velocity** → always returns `true`. Perpetual goals
  with forward momentum can always afford to wait.
- **No deadline + zero/negative velocity** → returns `false`. A stagnating
  perpetual goal should not wait.
- **With deadline** → computes whether post-wait required velocity would exceed
  the critical pacing threshold. If so, the wait is rejected.

---

## 6. Gaps & Future Work

The following capabilities are referenced in vision.md but not yet implemented:

| Gap | Description |
|-----|-------------|
| **Effect latency estimation** | Heuristic categorization of action types (e.g., "deploy" → hours, "marketing" → days) to auto-suggest `wait_until` durations. Currently the LLM proposes durations without structured guidance. |
| **Adaptive observation frequency** | Reducing observation frequency during waits to save tokens/API calls. TimeHorizonEngine has `suggestObservationInterval` (time-horizon.md §7) but it is not yet connected to the wait state. |
| **LLM-assisted wait duration estimation** | Using the LLM to estimate effect latency based on action type and domain context, rather than relying on fixed heuristics. |
| **Wait state telemetry** | Reporting/dashboard integration for wait states — how long goals spend waiting, wait success rate, average wait duration vs. actual effect onset. |

---

## 7. Module Location

| Concern | File |
|---------|------|
| WaitStrategy schema + type | `src/orchestrator/strategy/types/strategy.ts` |
| `isWaitStrategy` duck-type check | `src/orchestrator/strategy/portfolio-allocation.ts` |
| `handleWaitStrategyExpiry` | `src/orchestrator/strategy/portfolio-manager.ts` (delegates to `portfolio-rebalance.ts`) |
| `canAffordWait` closure | `src/platform/time/time-horizon-engine.ts` |
| `TimeBudgetWithWait` type | `src/base/types/time-horizon.ts` |
| `isSuppressed` (plateau_until) | `src/platform/drive/stall-detector.ts` |
| CoreLoop wait iteration | `src/orchestrator/loop/core-loop-phases-b.ts` (`rebalancePortfolio`) |

---

## 8. Design Note: TimeBudgetWithWait

`TimeBudgetWithWait` is defined as:

```typescript
export type TimeBudgetWithWait = TimeBudget & {
  canAffordWait(waitHours: number): boolean;
};
```

This type is **not Zod-parseable** because it contains a closure (`canAffordWait`).
This is intentional — `canAffordWait` captures `remainingHours`, `velocity`, and
`currentGap` at call time, ensuring the time check is always against a consistent
snapshot. The trade-off: `TimeBudgetWithWait` cannot be serialized to JSON or
validated with Zod. It exists only as an in-memory computation result, never
persisted to state files.

---

## Summary of Design Decisions

| Decision | Rationale |
|----------|-----------|
| No standalone module | WaitStrategy is a schema + behavior distributed across existing modules; a separate class would duplicate orchestration logic |
| Duck-type detection | Strategies are plain Zod-parsed objects; no class hierarchy to use `instanceof` on |
| Closure for `canAffordWait` | Captures time snapshot consistently; avoids passing 5 parameters on every call |
| `fallback_strategy_id` nullable | Not every wait has a fallback; null means "rebalance from scratch" |
| `plateau_until` owned by StallDetector | Suppression is a detection concern, not a strategy concern |
