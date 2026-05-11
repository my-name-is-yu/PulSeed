# Codex-Like User Interaction Contract

> Status: Internal design note. Verify public behavior against source code and public-current docs before treating this as user-facing guidance.

Status: target contract for #1104 child issues

This document defines the target interaction contract for PulSeed's
Codex-like natural-language chat surfaces. It is an implementation-facing
contract, not a claim that all behavior already exists. The golden fixture next
to this document, `codex-like-interaction-contract.golden.json`, contains the
same contract in a machine-checkable form for later production tests.

## Goals

- Ordinary chat, TUI chat, gateway messages, and CLI/chat ingress should submit
  the same typed user input shape.
- The transcript should be display-first: the user sees text, progress, tool
  observations, permission prompts, clarification, recovery, and final answers.
- Host state should stay structured: turn ids, run ids, tool calls, pending
  permissions, current targets, selected tools, and replay metadata are data,
  not prose hidden in the transcript.
- Freeform user intent should reach the model/tool schema boundary as natural
  language unless a deterministic protocol surface was used.

## Non-Goals

- This contract does not add new tool execution behavior.
- Exact protocol grammar is defined separately in
  [Exact Protocol Grammar Boundaries](exact-protocol-boundaries.md).
- This contract does not allow keyword lists, regex phrase tables, string
  `includes`, title matching, or language-specific shortcuts to become the
  primary decision mechanism for freeform semantic behavior.

## Layers

### UserInput

Every surface creates a `UserInput` item list before route or model execution.
The initial #1106 shape should support at least these item kinds:

| Kind | Contents | Notes |
| --- | --- | --- |
| `text` | freeform user text | Preserve as ordinary text. Do not pre-classify natural language into runtime/edit/test/shell/approval intent. |
| `image` | remote image URL plus optional label | Future-facing. Model-visible only if the selected model supports it. |
| `local_image` | host path plus optional label | Host validates access; model receives safe attachment metadata/content only through the request builder. |
| `mention` | structured target reference | Deterministic parsing is allowed for exact mention syntax. |
| `skill` | structured skill reference | Deterministic parsing is allowed for exact skill syntax. |
| `tool` | explicit tool reference | Deterministic parsing is allowed for exact tool ids. |
| `attachment` | future file/blob reference | Host-owned access and redaction. |

### Turn Operation

The conversation owner converts user input into one of two operations:

| Operation | When | Required state |
| --- | --- | --- |
| `TurnStart` | No active turn exists for the conversation/session. | New `turn_id`, current reply target, current cwd, current session state, current tool selection. |
| `TurnSteer` | A turn is active and the input belongs to the same conversation/session. | Existing `turn_id`, steer input id, current reply target, active run id, active target snapshot. |

Steering input must not re-use a stale previous-turn target. If the steer text
introduces a new target or asks an ordinary side question, the active turn
receives the text as steering context and any target decision is made from the
current typed state plus the new input, not from a cached route.

### TurnContext

The request builder receives a first-class `TurnContext` assembled for this
turn. It separates model-visible state from host-only state.

Model-visible examples:

- cwd, current date, timezone, session title, selected model, selected
  model-visible tools, active turn/run summary, relevant AGENTS/user/developer
  instructions, safe runtime evidence, outstanding user-facing confirmation.

Host-only examples:

- raw approval policy internals, secret values, local credential paths,
  unredacted attachments, cross-user identity details not needed by the model,
  stale route caches, rejected previous-turn targets, and internal audit
  records.

### Model Request

Ordinary chat requests should combine conversation history, base instructions,
`TurnContext`, and typed tool schemas. They should not ask for schema-shaped
final JSON unless the caller explicitly requested structured output. Tool calls
are structured at the tool boundary; final assistant text is display text.

## Transcript Model

The transcript is an ordered projection of structured events:

| Event | Display text | Structured state |
| --- | --- | --- |
| `turn_start` | The user's text and optional start/progress line. | `turn_id`, `input_id`, `reply_target`, `operation=TurnStart`. |
| `turn_steer` | The user's mid-turn message. | Existing `turn_id`, `steer_input_id`, active run snapshot. |
| `assistant_delta` | Incremental assistant text. | Current `turn_id`, stream offsets. |
| `activity` | Short commentary/checkpoint. | Activity kind, source id, transient flag. |
| `tool_call` | Short tool start text when useful. | Tool call id, typed tool name, redacted args, approval level. |
| `tool_observation` | Concise result/observation summary. | Tool result id, success/error, duration, artifact refs. |
| `permission_prompt` | Human-readable prompt in the originating conversation. | Pending permission/approval record id, action, target, risk, expiry, origin. |
| `clarification` | One clear question. | Clarification id, unknown field(s), allowed answer shape if deterministic. |
| `error_recovery` | Error explanation and next safe step. | Error code, stopped reason, retryability, partial output refs. |
| `turn_complete` | Final answer as display text. | Final status, elapsed time, persisted/replay refs, usage summary. |

The display projection may be suppressed for noisy internal tool chatter, but
the structured state remains available for replay, audit, and model context.

## Permission Dialogue

Permission prompts are rendered from a typed pending record, never improvised by
the model. The visible prompt names the operation, target, risk, and possible
outcomes. A reply resolves only the matching pending record.

The structured decision domain is:

- `approve`: execute only the matching pending record.
- `reject`: do not execute and persist the denial.
- `clarify`: keep the same pending record open and ask/answer about it.
- `unknown`: fail closed or continue asking, depending on the owning policy.

The approval resolver must verify channel, conversation/thread, sender,
session/turn, `approval_id`, expiry, and confidence. Cross-channel replies,
stale session replies, previous-turn approvals, and replies to already resolved
records do not execute the action.

## Clarification

Clarification is a typed state, not a generic fallback string. A clarification
must preserve:

- what is missing or ambiguous,
- what operation is paused,
- the current turn/run ids,
- whether the answer can be parsed deterministically,
- and when the clarification expires or is superseded.

Ordinary side questions during an active turn should be preserved as steering
input. If they are not sufficient to resolve the active turn, the model can
answer or ask a typed clarification without losing the active run context.

## Resume And Stale Target Rules

Resume creates or restores a current typed target from persisted state. It does
not silently reuse the most recent route, approval, run, cwd, or reply target.

Required stale rejection rules:

- A current input without an explicit target must not inherit a previous turn's
  target if the previous turn completed.
- A steer input that introduces a different target must not be forced back onto
  the old target by route cache.
- A pending permission reply must match the pending record and origin; otherwise
  it is `unknown` or invalid-context.
- "latest", "current", and "active" are resolved from typed current state and
  rejected when the state is absent or ambiguous.

## Examples

### Ordinary Chat, English

User display:

```text
What can you see from the current repo?
```

Structured input:

```json
{
  "operation": "TurnStart",
  "input": { "items": [{ "kind": "text", "text": "What can you see from the current repo?" }] },
  "route": { "kind": "model_request" }
}
```

Assistant display:

```text
This repo is PulSeed. I can inspect local files and tests when you ask me to
work on it.
```

Final state:

```json
{ "final_output_mode": "display_text", "structured_output": null }
```

### Tool Progress And Observation, English

Display transcript:

```text
User: Check the failing test and fix it.
Assistant: I am checking the focused test and the code path it exercises.
Tool: npm test -- src/interface/chat/__tests__/chat-runner.test.ts
Observation: The focused test fails because the pending confirmation is reused after a new intent.
Assistant: I fixed the confirmation reset and added a two-turn regression test.
```

Structured state keeps `tool_call_id`, command args, duration, exit status,
artifact refs, changed files, and verification commands separately from those
display lines.

### Permission Prompt, English

Display prompt:

```text
PulSeed wants to run `npm publish --dry-run` in this workspace. This can read
package metadata and contact the registry. Approve, reject, or ask for details.
```

Structured pending record:

```json
{
  "approval_id": "approval-123",
  "turn_id": "turn-7",
  "operation": "shell_command",
  "target": "npm publish --dry-run",
  "risk": "external_network",
  "origin": { "channel": "tui", "conversation_id": "local", "user_id": "owner" },
  "expires_at": "2026-05-06T07:30:00.000Z",
  "reply_matching": {
    "same_channel": true,
    "same_conversation_or_thread": true,
    "authorized_sender": "owner",
    "current_session_or_turn": "turn-7",
    "pending_unexpired_approval_id": "approval-123"
  },
  "decision_domain": ["approve", "reject", "clarify", "unknown"]
}
```

### Mid-Turn Steering, Japanese

User display:

```text
そのテストだけじゃなくて TUI 側も見て
```

Structured operation:

```json
{
  "operation": "TurnSteer",
  "turn_id": "turn-active",
  "input": { "items": [{ "kind": "text", "text": "そのテストだけじゃなくて TUI 側も見て" }] },
  "target_resolution": "current_typed_state_plus_new_input"
}
```

The text is not classified by Japanese phrase matching. It is preserved as
steering context for the active model/tool turn.

### Clarification, Japanese

Assistant display:

```text
どの PR を対象にしますか。番号か URL で指定してください。
```

Structured state:

```json
{
  "clarification_id": "clarify-1",
  "missing_fields": ["pull_request_ref"],
  "answer_protocol": "github_pr_ref"
}
```

The answer protocol is deterministic because PR numbers and URLs are exact
protocol surfaces.

### Stale Target Rejection, Japanese

If the previous turn targeted `run-A` and completed, this new user display:

```text
最新の方を止めて
```

must not silently reuse `run-A`. The host resolves "latest/current/active" from
typed runtime state. If there is no unambiguous active run, the assistant asks a
clarifying question or reports that no current target exists.

### Resume, English

User display:

```text
Resume the previous coding session.
```

Resume loads persisted session state and creates a current typed target:

```json
{
  "operation": "TurnStart",
  "resume": {
    "session_id": "session-42",
    "source": "persisted_session_store",
    "state_path": "host-only"
  }
}
```

The model-visible context receives the safe summary, not raw host-only state
paths or stale route caches.

## Implementation Order

1. #1106: introduce canonical `UserInput` and make TUI/non-TUI ingress produce
   equivalent typed input without freeform pre-classification.
2. #1107: introduce or unify `TurnStart` and `TurnSteer` so active work is
   steered and idle input starts a new turn.
3. #1108: assemble first-class `TurnContext` and separate model-visible from
   host-only state.
4. #1109: route ordinary chat model calls through a central request builder
   that combines history, base instructions, `TurnContext`, and typed tool
   schemas.
