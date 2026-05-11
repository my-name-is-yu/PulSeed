# Exact Protocol Grammar Boundaries

> Status: Design document. Verify behavior against source code and current operating docs before treating this as implementation guidance.

Status: protocol contract lane contract under the Codex-like interaction epic.

This note defines where deterministic parsing is allowed. It is intentionally
separate from freeform semantic routing: exact protocol parsers recognize
explicit tokens, command grammar, ids, paths, URLs, schema values, feature
flags, wire tokens, and mention syntax. They do not decide what ordinary prose
means.

## Allowed Deterministic Surfaces

| Surface | Allowed | Boundary |
| --- | --- | --- |
| Slash command | Leading slash or exact symbol command owned by the surface. | Bare words such as `help`, `run`, or `status` are not commands. Sentences that mention command words stay freeform. |
| CLI flag | Flags after an already selected CLI command. | Flags do not select a user intent outside that command grammar. |
| ID | Exact goal, task, run, session, approval, or persisted record id. | IDs fill typed fields; they do not route freeform turns by themselves. |
| Path | Filesystem path validated by the owning operation. | Path parsing validates an operation field, not the whole user intent. |
| URL | URL parsed by a URL-aware caller. | URLs are exact references, not keyword shortcuts. |
| Enum/schema | Literal values accepted by a schema or typed API. | Invalid values fail closed instead of guessing from prose. |
| Feature flag | Named config/env switch and exact value. | Flags are config fields, not natural-language labels. |
| Wire token | Transport/event token inside its protocol envelope. | Tokens are meaningful only inside that envelope. |
| Mention | Exact structured target token such as `@run:run-123`. | Do not select targets by fuzzy labels, titles, or prose references. |

The canonical source for this list is
`src/base/protocol/exact-protocol.ts`.

## Parser Rules

- Exact parsers must be anchored to the explicit protocol surface they own.
- Unknown exact slash commands return a typed command error. They do not fall
  back to matching nearby freeform words.
- Freeform paraphrases, multilingual requests, and ambiguous text stay as text
  input unless a model/tool-schema boundary classifies them.
- Mention parsing is token-level and structured. `@run:run-123` can produce a
  `mention` item; `latest run`, `current session`, and title-like labels are
  freeform references unless a typed resolver handles them.
- Exact parser failures must return null, unknown, invalid-context, or schema
  errors. They must not call a keyword fallback.

## Review Guidance

When reviewing protocol or semantic routing changes:

- Check that deterministic parsing is limited to the allowed surface list.
- Look for keyword lists, regex phrase tables, string `includes`, title
  matching, and language-specific phrase shortcuts on freeform paths.
- Require at least one caller-path test that sends ordinary text through the
  real routing surface instead of passing a precomputed route.
- Include paraphrases and multilingual examples when the behavior is
  user-facing.
- Treat command words embedded in prose as ordinary text.
- Treat exact protocol tests as deterministic parser tests, not semantic
  classifier coverage.

## Test Requirements

Exact protocol tests should cover positive grammar cases and negative freeform
cases:

- `/help` is a command; `help` is not.
- `/status goal-123` is command grammar only where the owning command accepts an
  argument; `show me status` is not.
- `@run:run-123` is a mention token; `please mention run-123` is not.
- A TUI or chat caller-path test must prove freeform paraphrases go to the
  ordinary text/model path rather than a slash, mention, or keyword fallback.
