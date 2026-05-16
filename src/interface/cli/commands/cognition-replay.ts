import { parseArgs } from "node:util";

import type { StateManager } from "../../../base/state/state-manager.js";
import {
  FileCognitionAuditSink,
  projectRelationshipMemoryNormalSummary,
  type CognitionEventRef,
  type CognitionRef,
  type CompanionCognitionSurfaceTarget,
  type RelationshipMemoryNormalSummary,
} from "../../../runtime/cognition/index.js";
import {
  FileCognitiveReplayIndexStore,
  createCognitiveReplayInspectionView,
  type CognitiveReplayInspectionView,
} from "../../../runtime/visibility/index.js";
import {
  FileCognitionWritebackQueueStore,
  type CognitionWritebackQueueEntry,
} from "../../../reflection/index.js";
import {
  createMemoryLifecycleEnvelopeFromCognitionReplayIndexEntry,
  createMemoryLifecycleEnvelopeFromWritebackQueueEntry,
  createMemoryLifecycleReviewInbox,
  type MemoryLifecycleReviewInbox,
} from "../../../grounding/memory-lifecycle-owner-routing.js";
import { getCliLogger } from "../cli-logger.js";
import { formatOperationError } from "../utils.js";

type RuntimeCognitionReplayArgs = {
  json?: boolean;
  view?: string;
  operator?: boolean;
  internal?: boolean;
};

type RuntimeCognitionReplayQueueRef = {
  queue_entry_ref: CognitionRef;
  proposal_ref: CognitionRef;
  owner: CognitionWritebackQueueEntry["owner"];
  state: CognitionWritebackQueueEntry["state"];
  source_state: CognitionWritebackQueueEntry["source_state"];
  review_required: true;
  owner_write_performed: false;
  runtime_authority: false;
  source_refs_visible: boolean;
  source_refs: CognitionEventRef[];
  invalidation_refs: CognitionEventRef[];
};

export type RuntimeCognitionReplayDiagnostic = {
  schema_version: "runtime-cognition-replay-diagnostic-v1";
  generated_at: string;
  read_only: true;
  mutation_performed: false;
  view: CognitiveReplayInspectionView;
  relationship_memory_summaries: RelationshipMemoryNormalSummary[];
  writeback_queue_refs: RuntimeCognitionReplayQueueRef[];
  memory_lifecycle_review_inbox: MemoryLifecycleReviewInbox;
};

function parseRuntimeCognitionReplayArgs(args: string[]): RuntimeCognitionReplayArgs {
  const { values } = parseArgs({
    args,
    options: {
      json: { type: "boolean" },
      view: { type: "string" },
      operator: { type: "boolean" },
      internal: { type: "boolean" },
    },
    strict: false,
  }) as { values: RuntimeCognitionReplayArgs };
  return values;
}

function surfaceTargetForArgs(values: RuntimeCognitionReplayArgs): CompanionCognitionSurfaceTarget | null {
  if (values.internal === true) return "internal_audit";
  if (values.operator === true) return "operator_debug";

  switch (values.view) {
    case undefined:
    case "normal":
    case "normal_user":
      return "normal_user";
    case "operator":
    case "operator_debug":
      return "operator_debug";
    case "internal":
    case "internal_audit":
      return "internal_audit";
    default:
      return null;
  }
}

function refKey(ref: CognitionRef): string {
  return `${ref.kind}:${ref.ref}`;
}

function eventRefLabel(ref: CognitionEventRef): string {
  return `${ref.source_store}:${ref.ref}`;
}

function cognitionRefLabel(ref: CognitionRef | undefined): string {
  return ref ? refKey(ref) : "-";
}

function queueRefsForView(
  queueEntries: CognitionWritebackQueueEntry[],
  view: CognitiveReplayInspectionView,
): RuntimeCognitionReplayQueueRef[] {
  const proposalRefs = new Set(view.items.flatMap((item) => item.writeback_proposal_refs.map(refKey)));
  const sourceRefsVisible = view.surface_target === "operator_debug" || view.surface_target === "internal_audit";
  return queueEntries.flatMap((entry) => {
    const proposalRef = { kind: "memory_writeback_proposal", ref: entry.proposal.proposal_id };
    if (!proposalRefs.has(refKey(proposalRef))) return [];
    return [{
      queue_entry_ref: { kind: "cognition_writeback_queue_entry", ref: entry.queue_entry_id },
      proposal_ref: proposalRef,
      owner: entry.owner,
      state: entry.state,
      source_state: entry.source_state,
      review_required: entry.review_required,
      owner_write_performed: entry.owner_write_performed,
      runtime_authority: entry.runtime_authority,
      source_refs_visible: sourceRefsVisible,
      source_refs: sourceRefsVisible ? entry.source_refs : [],
      invalidation_refs: sourceRefsVisible ? entry.invalidation_refs : [],
    }];
  });
}

export async function createRuntimeCognitionReplayDiagnostic(input: {
  baseDir: string;
  surfaceTarget: CompanionCognitionSurfaceTarget;
  now?: string;
}): Promise<RuntimeCognitionReplayDiagnostic> {
  const [indexEntries, replayRecords, queueEntries] = await Promise.all([
    new FileCognitiveReplayIndexStore(input.baseDir).list(),
    new FileCognitionAuditSink(input.baseDir).list(),
    new FileCognitionWritebackQueueStore(input.baseDir).list(),
  ]);
  const generatedAt = input.now ?? new Date().toISOString();
  const view = createCognitiveReplayInspectionView({
    viewId: `runtime:cognition-replay:${input.surfaceTarget}:${generatedAt}`,
    surfaceTarget: input.surfaceTarget,
    indexEntries,
    replayRecords,
  });
  const lifecycleEnvelopes = [
    ...indexEntries.map(createMemoryLifecycleEnvelopeFromCognitionReplayIndexEntry),
    ...queueEntries.map(createMemoryLifecycleEnvelopeFromWritebackQueueEntry),
  ];

  return {
    schema_version: "runtime-cognition-replay-diagnostic-v1",
    generated_at: generatedAt,
    read_only: true,
    mutation_performed: false,
      view,
      relationship_memory_summaries: replayRecords.flatMap((record) =>
        record.stable_output
          ? [projectRelationshipMemoryNormalSummary(record.stable_output.relationship_state)]
          : []
      ),
      writeback_queue_refs: queueRefsForView(queueEntries, view),
      memory_lifecycle_review_inbox: createMemoryLifecycleReviewInbox({
      inboxId: `runtime:memory-lifecycle-review:${input.surfaceTarget}:${generatedAt}`,
      generatedAt,
      envelopes: lifecycleEnvelopes,
      sourceRefsVisible: input.surfaceTarget === "operator_debug" || input.surfaceTarget === "internal_audit",
    }),
  };
}

export function printRuntimeCognitionReplayDiagnostic(diagnostic: RuntimeCognitionReplayDiagnostic): void {
  const view = diagnostic.view;
  console.log("Cognition replay inspection:");
  console.log(`  View:           ${view.surface_target}`);
  console.log(`  Items:          ${view.items.length}`);
  console.log(`  Raw prompt:     ${view.raw_prompt_visible ? "visible" : "hidden"}`);
  console.log(`  Raw memory:     ${view.raw_memory_visible ? "visible" : "hidden"}`);
  console.log(`  Debug to normal:${view.normal_surface_debug_visible ? "visible" : "hidden"}`);
  console.log(`  Read only:      ${diagnostic.read_only ? "yes" : "no"}`);
  console.log(`  Mutated:        ${diagnostic.mutation_performed ? "yes" : "no"}`);
  console.log(`  Relationship:  ${diagnostic.relationship_memory_summaries.length}`);
  console.log(`  Review inbox:   ${diagnostic.memory_lifecycle_review_inbox.items.length}`);

  if (view.items.length === 0) {
    console.log("  Replay items:   -");
  } else {
    console.log("  Replay items:");
    for (const item of view.items) {
      console.log(`    - ${item.index_entry_id}`);
      console.log(`      cognition:  ${item.cognition_id}`);
      console.log(`      caller:     ${item.caller_path}`);
      console.log(`      owner:      ${item.owner_store}`);
      console.log(`      replay:     ${eventRefLabel(item.replay_record_ref)}`);
      console.log(`      invalid:    ${item.invalidation_state}`);
      console.log(`      response:   ${cognitionRefLabel(item.response_plan_ref)}`);
      console.log(`      tools:      ${item.tool_authority_stages.join(", ") || "-"}`);
      console.log(`      writeback:  ${item.writeback_proposal_refs.map(refKey).join(", ") || "-"}`);
      console.log(`      sources:    ${item.debug_refs_visible ? item.source_refs.map(eventRefLabel).join(", ") || "-" : "hidden"}`);
    }
  }

  if (diagnostic.relationship_memory_summaries.length > 0) {
    console.log("  Relationship memory summaries:");
    for (const summary of diagnostic.relationship_memory_summaries) {
      console.log(`    - posture: ${summary.posture}; overreach: ${summary.overreach_risk}`);
      console.log(`      included: ${summary.included_count}; withheld: ${summary.withheld_count}`);
      for (const fact of summary.included) {
        console.log(`      included ${fact.role}/${fact.allowed_surface_use}: ${fact.user_readable_reason}`);
      }
      for (const fact of summary.withheld) {
        console.log(`      withheld ${fact.role}/${fact.withheld_reason}: ${fact.user_readable_reason}`);
      }
    }
  }

  if (diagnostic.writeback_queue_refs.length === 0) {
    console.log("  Writeback queue refs: -");
  } else {
    console.log("  Writeback queue refs:");
    for (const queueRef of diagnostic.writeback_queue_refs) {
      console.log(`    - ${refKey(queueRef.queue_entry_ref)} -> ${refKey(queueRef.proposal_ref)}`);
      console.log(`      owner/state: ${queueRef.owner}/${queueRef.state}`);
      console.log(`      source:      ${queueRef.source_state}`);
      console.log(`      owner write: ${queueRef.owner_write_performed ? "yes" : "no"}`);
      console.log(`      authority:   ${queueRef.runtime_authority ? "yes" : "no"}`);
      console.log(`      sources:     ${queueRef.source_refs_visible ? queueRef.source_refs.map(eventRefLabel).join(", ") || "-" : "hidden"}`);
    }
  }

  if (diagnostic.memory_lifecycle_review_inbox.items.length > 0) {
    console.log("  Memory lifecycle review:");
    for (const item of diagnostic.memory_lifecycle_review_inbox.items) {
      console.log(`    - ${item.item_id}`);
      console.log(`      kind/state: ${item.item_kind}/${item.review_state}`);
      console.log(`      actions:    ${item.allowed_actions.join(", ") || "-"}`);
      console.log(`      raw content: hidden`);
    }
  }
}

export async function cmdRuntimeCognitionReplay(stateManager: StateManager, args: string[]): Promise<number> {
  const logger = getCliLogger();
  let values: RuntimeCognitionReplayArgs;
  try {
    values = parseRuntimeCognitionReplayArgs(args);
  } catch (err) {
    logger.error(formatOperationError("parse runtime cognition-replay arguments", err));
    return 1;
  }

  const surfaceTarget = surfaceTargetForArgs(values);
  if (!surfaceTarget) {
    logger.error("Error: --view must be one of normal, operator, or internal.");
    return 1;
  }

  const diagnostic = await createRuntimeCognitionReplayDiagnostic({
    baseDir: stateManager.getBaseDir(),
    surfaceTarget,
  });
  if (values.json) {
    console.log(JSON.stringify(diagnostic, null, 2));
  } else {
    printRuntimeCognitionReplayDiagnostic(diagnostic);
  }
  return 0;
}
