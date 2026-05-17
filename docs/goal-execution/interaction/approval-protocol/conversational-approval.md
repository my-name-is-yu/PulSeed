# Conversational Approval Contract

> Status: Public design reference. This page explains PulSeed design intent and architecture rationale; exact runtime behavior is owned by current source code, tests, and operating docs.
> Doc status: active_design_contract
> Grounding use: design_context

Primary map: [Approval Protocol](./approval-protocol-map.md).

PulSeed's only long-term user-facing approval surface is the conversation where
the approval request originated. High-risk actions still stop at the shared
approval gate, but the user resolves that gate by replying in the originating
conversation channel or thread. TUI controls, web buttons, command-specific
approval widgets, and other mechanical approval affordances are migration
surfaces only; after conversational parity they should be removed instead of
kept as a parallel approval path.

This contract applies to text chat, TUI chat, voice transcripts, Telegram,
Slack, Discord, web chat, and future conversational channels. It does not
remove `ApprovalBroker`, `ApprovalStore`, audit records, or explicit high-risk
approval gates.

## Shared Record

Every approval request starts from a structured approval record. The visible
prompt is rendered from that record, not from ad hoc model prose.

The shared record must carry enough context to reject mismatched replies:

- `approval_id`, `correlation_id`, and the request envelope id.
- Operation metadata such as task id, action, target, description, and risk.
- Origin metadata for channel, conversation/thread, session or turn id, and
  authenticated user identity when available.
- State timestamps for creation, expiry, resolution, and timeout handling.
- Audit payload for the original request and the structured decision.

The structured decision domain is `approve | reject | clarify | unknown`.
Runtime execution may resume only for `approve` on the matching pending
approval record. `reject`, `unknown`, expired, unreachable, and invalid-context
outcomes must not execute the high-risk action. `clarify` keeps the original
record pending and preserves the same approval id and audit context.

## Ownership Boundaries

`ApprovalBroker` owns pending approval lifecycle, timeout, restore, resolution,
and broadcast. `ApprovalStore` remains the durable audit and recovery backing
store. Callers that need approval must continue to request it through the
broker or the broker-backed store path; they must not directly trust
channel-specific UI state.

The conversation layer owns the active conversational approval context for a
turn. `ChatRunner` and equivalent channel runners should know which approval is
currently pending for the originating conversation, expose that pending state to
the renderer, and pass replies to the shared decision parser. They should not
duplicate approval safety semantics.

Channel adapters own transport concerns only: authenticated sender identity,
channel name, conversation/thread id, session id, reply target, and delivery
status. Adapters must not implement channel-specific approval semantics such as
"Slack yes means approve" or "button click bypasses parser". They pass
structured origin metadata into the broker and route rendered prompts back to
the same origin.

Renderers may display pending approval status and progress timeline entries,
but they must not become separate approval resolution surfaces. A status view
can say that an approval is waiting; the actual user-facing resolution remains
the conversational reply.

## Reply Matching

An approval reply is valid only when all matching constraints hold:

- The reply belongs to the same channel and conversation/thread as the request.
- The sender identity is authorized for the original approval request.
- The session/turn context is current and not a previous-turn or stale target.
- The referenced or active `approval_id` is still pending and unexpired.
- The parsed structured decision has sufficient confidence to be actionable.

Cross-channel replies, cross-user replies, stale session replies, previous-turn
approvals, and replies to already resolved or expired approval ids must be
rejected without resolving the pending approval. These rejections should be
auditable as invalid-context decisions where the runtime has enough metadata to
record them.

Ambiguous or low-confidence replies resolve to `unknown` and must not execute
the action. Clarification requests resolve to `clarify`; the same structured
approval record stays pending so the user can decide without losing the
original operation, target, risk, or audit context.

## Timeout And Fallback

Timeouts and unreachable channels fail closed. If the originating channel cannot
be reached, the broker must deny, expire, or pause according to the owning
runtime policy; it must never infer approval. Restored pending approvals after a
restart must be re-rendered to their originating conversation when possible, and
otherwise remain pending until timeout or move to the configured closed state.

## Migration Plan

1. Route approval requests through the originating conversation channel while
   preserving `ApprovalBroker`, `ApprovalStore`, and audit records.
2. Add or extend a shared conversational decision contract that parses replies
   into `approve | reject | clarify | unknown` using the active approval
   context and rejects mismatches.
3. Add production caller-path tests for at least one real conversation ingress
   path so routing and decision parsing are exercised through the same boundary
   users hit.
4. Remove covered mechanical approval controls and help text after
   conversational parity exists. Status and timeline displays may remain as
   read-only pending-approval indicators.
