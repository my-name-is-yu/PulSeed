import { parseArgs } from "node:util";
import type { StateManager } from "../../../base/state/state-manager.js";
import { getCliLogger } from "../cli-logger.js";
import { formatOperationError } from "../utils.js";
import {
  applyRelationshipProfileChangeProposal,
  approveRelationshipProfileChangeProposal,
  loadRelationshipProfileProposalStore,
  rejectRelationshipProfileChangeProposal,
  RelationshipProfileProposalStateSchema,
} from "../../../platform/profile/profile-change-proposal.js";
import {
  loadRelationshipProfile,
  getRelationshipProfileHistory,
  RelationshipProfileConsentScopeSchema,
  RelationshipProfileItemKindSchema,
  RelationshipProfileSensitivitySchema,
  RelationshipProfileSourceSchema,
  retractRelationshipProfileItem,
  selectActiveRelationshipProfileItems,
  upsertRelationshipProfileItem,
  type RelationshipProfileConsentScope,
  type RelationshipProfileItemKind,
  type RelationshipProfileSensitivity,
  type RelationshipProfileSource,
} from "../../../platform/profile/relationship-profile.js";
import { parseExactFiniteNumber } from "./exact-number.js";

function usage(): string {
  return `Usage:
  pulseed profile show [--scope <scope>] [--all] [--json]
  pulseed profile update --kind <kind> --key <stable_key> --value <value> [--scope <scope>] [--sensitivity <public|private|sensitive>] [--confidence <0-1>] [--source <source>] [--evidence-ref <ref>]
  pulseed profile history <stable_key> [--json]
  pulseed profile retract --key <stable_key> --reason <reason> [--source <source>] [--json]
  pulseed profile proposal list [--state <state>] [--json]
  pulseed profile proposal inspect <proposal_id> [--json]
  pulseed profile proposal approve <proposal_id> [--reason <reason>] [--json]
  pulseed profile proposal reject <proposal_id> --reason <reason> [--json]
  pulseed profile proposal apply <proposal_id> [--json]

Scopes: local_planning, resident_behavior, memory_retrieval, user_facing_review
Kinds: identity_fact, preference, dislike, value, boundary, communication_style, notification_preference, long_term_goal, life_context, intervention_policy`;
}

function parseEnum<T extends string>(
  raw: string | undefined,
  label: string,
  parse: (value: string) => { success: true; data: T } | { success: false }
): T | null {
  if (raw === undefined) return null;
  const result = parse(raw);
  if (result.success) return result.data;
  getCliLogger().error(`Error: invalid ${label}: ${raw}`);
  return null;
}

function parseScopeList(raw: string[] | undefined): RelationshipProfileConsentScope[] | null {
  if (!raw || raw.length === 0) return null;
  const parsed: RelationshipProfileConsentScope[] = [];
  for (const value of raw) {
    const result = RelationshipProfileConsentScopeSchema.safeParse(value);
    if (!result.success) {
      getCliLogger().error(`Error: invalid scope: ${value}`);
      return null;
    }
    parsed.push(result.data);
  }
  return [...new Set(parsed)];
}

export async function cmdProfile(stateManager: StateManager, argv: string[]): Promise<number> {
  const subcommand = argv[0];
  if (!subcommand || subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    console.log(usage());
    return 0;
  }

  if (subcommand === "proposal") {
    return cmdProfileProposal(stateManager, argv.slice(1));
  }

  if (subcommand === "show") {
    let values: { scope?: string; all?: boolean; json?: boolean };
    try {
      ({ values } = parseArgs({
        args: argv.slice(1),
        options: {
          scope: { type: "string" },
          all: { type: "boolean" },
          json: { type: "boolean" },
        },
        strict: true,
      }) as { values: { scope?: string; all?: boolean; json?: boolean } });
    } catch (err) {
      getCliLogger().error(formatOperationError("parse profile show arguments", err));
      return 1;
    }

    const store = await loadRelationshipProfile(stateManager.getBaseDir());
    let scope: RelationshipProfileConsentScope | null = null;
    if (values.scope !== undefined) {
      const parsed = RelationshipProfileConsentScopeSchema.safeParse(values.scope);
      if (!parsed.success) {
        getCliLogger().error(`Error: invalid scope: ${values.scope}`);
        return 1;
      }
      scope = parsed.data;
    }
    const items = values.all
      ? store.items
      : scope
        ? selectActiveRelationshipProfileItems(store, scope)
        : selectActiveRelationshipProfileItems(store, "user_facing_review");

    if (values.json) {
      console.log(JSON.stringify({
        schema_version: store.schema_version,
        profile_id: store.profile_id,
        items,
        ...(values.all ? { audit_events: store.audit_events } : {}),
        updated_at: store.updated_at,
      }, null, 2));
      return 0;
    }

    if (items.length === 0) {
      console.log("No relationship profile items.");
      return 0;
    }

    console.log("Relationship profile:");
    for (const item of items) {
      console.log(
        `- ${item.stable_key} [${item.kind}] v${item.version} ${item.status}: ${item.value}` +
          ` (scopes=${item.allowed_scopes.join(",")}; sensitivity=${item.sensitivity}; confidence=${item.confidence.toFixed(2)})`
      );
    }
    return 0;
  }

  if (subcommand === "history") {
    let values: { json?: boolean };
    let positionals: string[];
    try {
      const parsed = parseArgs({
        args: argv.slice(1),
        options: {
          json: { type: "boolean" },
        },
        allowPositionals: true,
        strict: true,
      }) as { values: { json?: boolean }; positionals: string[] };
      values = parsed.values;
      positionals = parsed.positionals;
    } catch (err) {
      getCliLogger().error(formatOperationError("parse profile history arguments", err));
      return 1;
    }

    const stableKey = positionals[0]?.trim();
    if (!stableKey || positionals.length > 1) {
      getCliLogger().error("Error: profile history requires exactly one <stable_key> argument.");
      console.log(usage());
      return 1;
    }

    try {
      const store = await loadRelationshipProfile(stateManager.getBaseDir());
      const history = getRelationshipProfileHistory(store, stableKey);
      if (values.json) {
        console.log(JSON.stringify(history, null, 2));
        return 0;
      }
      if (history.items.length === 0 && history.audit_events.length === 0) {
        console.log(`No relationship profile history for ${stableKey}.`);
        return 0;
      }
      console.log(`Relationship profile history for ${history.stable_key}:`);
      for (const item of history.items) {
        const evidence = item.provenance.evidence_ref ? `; evidence=${item.provenance.evidence_ref}` : "";
        const note = item.provenance.note ? `; note=${item.provenance.note}` : "";
        console.log(
          `- item v${item.version} ${item.status}: ${item.value}` +
            ` (source=${item.provenance.source}; scopes=${item.allowed_scopes.join(",")}; sensitivity=${item.sensitivity}; confidence=${item.confidence.toFixed(2)}${evidence}${note})`
        );
      }
      if (history.audit_events.length > 0) {
        console.log("Audit events:");
        for (const event of history.audit_events) {
          const reason = event.reason ? `; reason=${event.reason}` : "";
          const previous = event.previous_item_id ? `; previous=${event.previous_item_id}` : "";
          console.log(`- ${event.at} ${event.action} v${event.version} item=${event.item_id} source=${event.source}${previous}${reason}`);
        }
      }
      return 0;
    } catch (err) {
      getCliLogger().error(formatOperationError("show relationship profile history", err));
      return 1;
    }
  }

  if (subcommand === "update") {
    let values: {
      kind?: string;
      key?: string;
      value?: string;
      scope?: string[];
      sensitivity?: string;
      confidence?: string;
      source?: string;
      "evidence-ref"?: string;
      note?: string;
      json?: boolean;
    };
    try {
      ({ values } = parseArgs({
        args: argv.slice(1),
        options: {
          kind: { type: "string" },
          key: { type: "string" },
          value: { type: "string" },
          scope: { type: "string", multiple: true },
          sensitivity: { type: "string" },
          confidence: { type: "string" },
          source: { type: "string" },
          "evidence-ref": { type: "string" },
          note: { type: "string" },
          json: { type: "boolean" },
        },
        strict: true,
      }) as {
        values: {
          kind?: string;
          key?: string;
          value?: string;
          scope?: string[];
          sensitivity?: string;
          confidence?: string;
          source?: string;
          "evidence-ref"?: string;
          note?: string;
          json?: boolean;
        };
      });
    } catch (err) {
      getCliLogger().error(formatOperationError("parse profile update arguments", err));
      return 1;
    }

    const kind = parseEnum<RelationshipProfileItemKind>(
      values.kind,
      "kind",
      (value) => RelationshipProfileItemKindSchema.safeParse(value) as never
    );
    const sensitivity = parseEnum<RelationshipProfileSensitivity>(
      values.sensitivity ?? "private",
      "sensitivity",
      (value) => RelationshipProfileSensitivitySchema.safeParse(value) as never
    );
    const source = parseEnum<RelationshipProfileSource>(
      values.source ?? "cli_update",
      "source",
      (value) => RelationshipProfileSourceSchema.safeParse(value) as never
    );
    const allowedScopes = parseScopeList(values.scope);
    if (!kind || !sensitivity || !source || values.scope && !allowedScopes) return 1;
    if (!values.key?.trim() || !values.value?.trim()) {
      getCliLogger().error("Error: --key and --value are required.");
      console.log(usage());
      return 1;
    }

    let confidence: number | undefined;
    if (values.confidence !== undefined) {
      confidence = parseExactFiniteNumber(values.confidence) ?? undefined;
      if (confidence === undefined || confidence < 0 || confidence > 1) {
        getCliLogger().error(`Error: --confidence must be a number between 0 and 1 (got: ${values.confidence})`);
        return 1;
      }
    }

    try {
      const result = await upsertRelationshipProfileItem(stateManager.getBaseDir(), {
        stableKey: values.key,
        kind,
        value: values.value,
        source,
        sensitivity,
        confidence,
        allowedScopes: allowedScopes ?? undefined,
        evidenceRef: values["evidence-ref"],
        note: values.note,
      });
      if (values.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Updated relationship profile item ${result.item.stable_key} v${result.item.version}.`);
        if (result.superseded.length > 0) {
          console.log(`Superseded ${result.superseded.length} previous active item(s).`);
        }
      }
      return 0;
    } catch (err) {
      getCliLogger().error(formatOperationError("update relationship profile", err));
      return 1;
    }
  }

  if (subcommand === "retract") {
    let values: {
      key?: string;
      reason?: string;
      source?: string;
      json?: boolean;
    };
    try {
      ({ values } = parseArgs({
        args: argv.slice(1),
        options: {
          key: { type: "string" },
          reason: { type: "string" },
          source: { type: "string" },
          json: { type: "boolean" },
        },
        strict: true,
      }) as { values: { key?: string; reason?: string; source?: string; json?: boolean } });
    } catch (err) {
      getCliLogger().error(formatOperationError("parse profile retract arguments", err));
      return 1;
    }

    const source = parseEnum<RelationshipProfileSource>(
      values.source ?? "cli_update",
      "source",
      (value) => RelationshipProfileSourceSchema.safeParse(value) as never
    );
    if (!source) return 1;
    if (!values.key?.trim() || !values.reason?.trim()) {
      getCliLogger().error("Error: --key and --reason are required.");
      console.log(usage());
      return 1;
    }

    try {
      const result = await retractRelationshipProfileItem(stateManager.getBaseDir(), {
        stableKey: values.key,
        reason: values.reason,
        source,
      });
      if (values.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Retracted relationship profile item ${result.item.stable_key} v${result.item.version}.`);
      }
      return 0;
    } catch (err) {
      getCliLogger().error(formatOperationError("retract relationship profile item", err));
      return 1;
    }
  }

  getCliLogger().error(`Unknown profile subcommand: "${subcommand}"`);
  console.log(usage());
  return 1;
}

async function cmdProfileProposal(stateManager: StateManager, argv: string[]): Promise<number> {
  const subcommand = argv[0];
  if (!subcommand || subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    console.log(usage());
    return 0;
  }

  if (subcommand === "list") {
    let values: { state?: string; json?: boolean };
    try {
      ({ values } = parseArgs({
        args: argv.slice(1),
        options: {
          state: { type: "string" },
          json: { type: "boolean" },
        },
        strict: true,
      }) as { values: { state?: string; json?: boolean } });
    } catch (err) {
      getCliLogger().error(formatOperationError("parse profile proposal list arguments", err));
      return 1;
    }
    const state = parseEnum(
      values.state,
      "proposal state",
      (value) => RelationshipProfileProposalStateSchema.safeParse(value)
    );
    if (values.state !== undefined && !state) return 1;
    const store = await loadRelationshipProfileProposalStore(stateManager.getBaseDir());
    const proposals = state
      ? store.proposals.filter((proposal) => proposal.approval_state === state)
      : store.proposals;
    if (values.json) {
      console.log(JSON.stringify({ ...store, proposals }, null, 2));
      return 0;
    }
    if (proposals.length === 0) {
      console.log("No relationship profile proposals.");
      return 0;
    }
    console.log("Relationship profile proposals:");
    for (const proposal of proposals) {
      console.log(
        `- ${proposal.id} ${proposal.approval_state} ${proposal.operation} ${proposal.proposed_item.stable_key}` +
          ` (source=${proposal.source}; confidence=${proposal.confidence.toFixed(2)}; sensitivity=${proposal.sensitivity})`
      );
    }
    return 0;
  }

  if (subcommand === "inspect") {
    const parsed = parseProposalIdArgs("inspect", argv.slice(1));
    if (!parsed) return 1;
    const store = await loadRelationshipProfileProposalStore(stateManager.getBaseDir());
    const proposal = store.proposals.find((candidate) => candidate.id === parsed.proposalId);
    if (!proposal) {
      getCliLogger().error(`Error: relationship profile proposal not found: ${parsed.proposalId}`);
      return 1;
    }
    if (parsed.json) {
      console.log(JSON.stringify({
        proposal,
        audit_events: store.audit_events.filter((event) => event.proposal_id === proposal.id),
      }, null, 2));
      return 0;
    }
    console.log(`Relationship profile proposal ${proposal.id}:`);
    console.log(`- state: ${proposal.approval_state}`);
    console.log(`- operation: ${proposal.operation}`);
    console.log(`- key: ${proposal.proposed_item.stable_key}`);
    if (proposal.proposed_item.kind) console.log(`- kind: ${proposal.proposed_item.kind}`);
    if (proposal.proposed_item.value) console.log(`- value: ${proposal.proposed_item.value}`);
    console.log(`- rationale: ${proposal.rationale}`);
    return 0;
  }

  if (subcommand === "approve") {
    const parsed = parseProposalIdArgs("approve", argv.slice(1), { allowReason: true });
    if (!parsed) return 1;
    try {
      const result = await approveRelationshipProfileChangeProposal(stateManager.getBaseDir(), parsed.proposalId, {
        reason: parsed.reason,
      });
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Approved relationship profile proposal ${result.proposal.id}.`);
      }
      return 0;
    } catch (err) {
      getCliLogger().error(formatOperationError("approve relationship profile proposal", err));
      return 1;
    }
  }

  if (subcommand === "reject") {
    const parsed = parseProposalIdArgs("reject", argv.slice(1), { requireReason: true });
    if (!parsed || !parsed.reason) return 1;
    try {
      const result = await rejectRelationshipProfileChangeProposal(stateManager.getBaseDir(), parsed.proposalId, {
        reason: parsed.reason,
      });
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Rejected relationship profile proposal ${result.proposal.id}.`);
      }
      return 0;
    } catch (err) {
      getCliLogger().error(formatOperationError("reject relationship profile proposal", err));
      return 1;
    }
  }

  if (subcommand === "apply") {
    const parsed = parseProposalIdArgs("apply", argv.slice(1));
    if (!parsed) return 1;
    try {
      const result = await applyRelationshipProfileChangeProposal(stateManager.getBaseDir(), parsed.proposalId);
      if (parsed.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Applied relationship profile proposal ${result.proposal.id} to ${result.item.stable_key} v${result.item.version}.`);
      }
      return 0;
    } catch (err) {
      getCliLogger().error(formatOperationError("apply relationship profile proposal", err));
      return 1;
    }
  }

  getCliLogger().error(`Unknown profile proposal subcommand: "${subcommand}"`);
  console.log(usage());
  return 1;
}

function parseProposalIdArgs(
  label: string,
  args: string[],
  options: { allowReason?: boolean; requireReason?: boolean } = {}
): { proposalId: string; reason?: string; json?: boolean } | null {
  let values: { reason?: string; json?: boolean };
  let positionals: string[];
  try {
    const parsed = parseArgs({
      args,
      options: {
        ...(options.allowReason || options.requireReason ? { reason: { type: "string" as const } } : {}),
        json: { type: "boolean" },
      },
      allowPositionals: true,
      strict: true,
    }) as { values: { reason?: string; json?: boolean }; positionals: string[] };
    values = parsed.values;
    positionals = parsed.positionals;
  } catch (err) {
    getCliLogger().error(formatOperationError(`parse profile proposal ${label} arguments`, err));
    return null;
  }
  const proposalId = positionals[0]?.trim();
  if (!proposalId || positionals.length > 1) {
    getCliLogger().error(`Error: profile proposal ${label} requires exactly one <proposal_id> argument.`);
    console.log(usage());
    return null;
  }
  const reason = values.reason?.trim();
  if (options.requireReason && !reason) {
    getCliLogger().error("Error: --reason is required.");
    console.log(usage());
    return null;
  }
  return {
    proposalId,
    ...(reason ? { reason } : {}),
    json: values.json,
  };
}
