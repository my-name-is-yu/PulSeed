import {
  AgendaDecompositionSchema,
  type AgendaDecomposition,
  type AgendaDecompositionChild,
  type AgentAgendaItem,
} from "../types/companion-autonomy.js";
import { ref, stableId } from "./attention-refs.js";

export interface DecomposeAgendaInput {
  agendaItems: readonly AgentAgendaItem[];
  existingDecompositions?: readonly AgendaDecomposition[];
  now: string;
  maxActiveChildrenPerAgenda?: number;
}

export function decomposeAgenda(input: DecomposeAgendaInput): AgendaDecomposition[] {
  const existingByAgendaId = new Map(
    (input.existingDecompositions ?? []).map((decomposition) => [decomposition.agendaRef.id, decomposition])
  );
  const maxChildren = input.maxActiveChildrenPerAgenda ?? 3;

  return input.agendaItems.map((agendaItem) => {
    const existing = existingByAgendaId.get(agendaItem.agenda_item_id);
    return decomposeAgendaItem({
      agendaItem,
      existing,
      now: input.now,
      maxChildren,
    });
  });
}

export function decomposeAgendaItem(input: {
  agendaItem: AgentAgendaItem;
  existing?: AgendaDecomposition;
  now: string;
  maxChildren?: number;
}): AgendaDecomposition {
  const maxChildren = input.maxChildren ?? 3;
  const clusterRef = input.agendaItem.clusterRef ?? ref("attention_cluster", `legacy:${input.agendaItem.agenda_item_id}`);
  const childSeed = childSeedForCarePosture(input.agendaItem);
  const currentChildKeys = new Set(childSeed.map((childType) => childIdempotencyKey(input.agendaItem, childType)));
  const existingChildren = (input.existing?.children ?? []).map((child) =>
    revalidateExistingChild({
      agendaItem: input.agendaItem,
      child,
      currentChildKeys,
      now: input.now,
    })
  );
  const children = [...existingChildren];

  for (const childType of childSeed) {
    if (activeChildCount(children) >= maxChildren) break;
    const idempotencyKey = childIdempotencyKey(input.agendaItem, childType);
    if (children.some((child) => child.idempotencyKey === idempotencyKey)) continue;
    children.push(createDecompositionChild({
      agendaItem: input.agendaItem,
      clusterId: clusterRef.id,
      childType,
      idempotencyKey,
      now: input.now,
    }));
  }

  const status = input.agendaItem.needsRegrounding || input.agendaItem.staleness_state !== "current"
    ? "needs_regrounding"
    : input.agendaItem.current_posture === "suppressed" || input.agendaItem.carePosture === "silence"
      ? "suppressed"
      : children.some((child) => child.admissionState === "admitted")
        ? "partially_admitted"
        : "open";

  return AgendaDecompositionSchema.parse({
    id: input.existing?.id ?? `agenda-decomposition:${stableId(input.agendaItem.agenda_item_id)}`,
    agendaRef: ref("agent_agenda_item", input.agendaItem.agenda_item_id),
    clusterRef,
    agendaKind: input.agendaItem.kind,
    commitmentLifecycle: input.agendaItem.commitmentLifecycle,
    scope: input.agendaItem.scope,
    children,
    status,
    createdAt: input.existing?.createdAt ?? input.now,
    updatedAt: input.now,
  });
}

function activeChildCount(children: readonly AgendaDecompositionChild[]): number {
  return children.filter((child) =>
    child.admissionState === "not_admitted" || child.admissionState === "needs_approval"
  ).length;
}

function revalidateExistingChild(input: {
  agendaItem: AgentAgendaItem;
  child: AgendaDecompositionChild;
  currentChildKeys: ReadonlySet<string>;
  now: string;
}): AgendaDecompositionChild {
  if (!isActiveChild(input.child)) return input.child;

  const stalenessSnapshot = stalenessSnapshotForAgenda(input.agendaItem, input.now);
  const expectedIdempotencyKey = childIdempotencyKey(input.agendaItem, input.child.childType);
  if (
    input.child.idempotencyKey !== expectedIdempotencyKey
    || !input.currentChildKeys.has(input.child.idempotencyKey)
  ) {
    return {
      ...input.child,
      admissionState: "expired",
      permissionScope: input.agendaItem.scope.permissionScope,
      stalenessSnapshot,
      updatedAt: input.now,
    };
  }

  if (
    input.child.permissionScope === input.agendaItem.scope.permissionScope
    && input.child.stalenessSnapshot.state === stalenessSnapshot.state
    && input.child.stalenessSnapshot.sourceHighWatermark === stalenessSnapshot.sourceHighWatermark
  ) {
    return input.child;
  }

  return {
    ...input.child,
    permissionScope: input.agendaItem.scope.permissionScope,
    stalenessSnapshot,
    updatedAt: input.now,
  };
}

function isActiveChild(child: AgendaDecompositionChild): boolean {
  return child.admissionState === "not_admitted" || child.admissionState === "needs_approval";
}

function createDecompositionChild(input: {
  agendaItem: AgentAgendaItem;
  clusterId: string;
  childType: AgendaDecompositionChild["childType"];
  idempotencyKey: string;
  now: string;
}): AgendaDecompositionChild {
  return {
    id: `agenda-child:${stableId(input.idempotencyKey)}`,
    parentAgendaRef: ref("agent_agenda_item", input.agendaItem.agenda_item_id),
    clusterRef: ref("attention_cluster", input.clusterId),
    childType: input.childType,
    idempotencyKey: input.idempotencyKey,
    requiredAuthority: requiredAuthorityForChild(input.childType),
    permissionScope: input.agendaItem.scope.permissionScope,
    stalenessSnapshot: stalenessSnapshotForAgenda(input.agendaItem, input.now),
    candidatePayloadRef: null,
    admissionState: "not_admitted",
    outcomeRef: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function childIdempotencyKey(
  agendaItem: AgentAgendaItem,
  childType: AgendaDecompositionChild["childType"],
): string {
  return `${agendaItem.policyEpoch}:${agendaItem.agenda_item_id}:${childType}`;
}

function stalenessSnapshotForAgenda(agendaItem: AgentAgendaItem, now: string): AgendaDecompositionChild["stalenessSnapshot"] {
  return {
    state: agendaItem.needsRegrounding || agendaItem.staleness_state !== "current" ? "needs_regrounding" : "fresh",
    observedAt: now,
    sourceHighWatermark: agendaItem.policyEpoch,
    reason: agendaItem.needsRegrounding || agendaItem.staleness_state !== "current"
      ? "agenda requires regrounding before child admission"
      : "agenda projection is fresh for this cycle",
  };
}

function childSeedForCarePosture(agendaItem: AgentAgendaItem): AgendaDecompositionChild["childType"][] {
  if (agendaItem.needsRegrounding || agendaItem.current_posture === "rejected_stale") return ["watch"];
  switch (agendaItem.carePosture) {
    case "notice":
    case "watch":
    case "hold":
      return ["watch"];
    case "prepare":
      return ["prepare", "watch"];
    case "ask":
      return ["ask", "watch"];
    case "offer":
      return ["digest", "ask", "watch"];
    case "act_candidate":
      return ["action_candidate", "prepare", "watch"];
    case "silence":
      return ["silence"];
  }
}

function requiredAuthorityForChild(childType: AgendaDecompositionChild["childType"]): AgendaDecompositionChild["requiredAuthority"] {
  switch (childType) {
    case "watch":
    case "silence":
      return "none";
    case "prepare":
    case "digest":
      return "read";
    case "ask":
      return "notify";
    case "action_candidate":
      return "write";
  }
}
