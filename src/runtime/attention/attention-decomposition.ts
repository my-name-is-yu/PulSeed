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
  const existingChildren = input.existing?.children.filter((child) =>
    child.admissionState === "not_admitted" || child.admissionState === "needs_approval"
  ) ?? [];
  const childSeed = childSeedForCarePosture(input.agendaItem);
  const children = [...existingChildren];

  for (const childType of childSeed) {
    if (children.length >= maxChildren) break;
    const idempotencyKey = `${input.agendaItem.policyEpoch}:${input.agendaItem.agenda_item_id}:${childType}`;
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
    scope: input.agendaItem.scope,
    children,
    status,
    createdAt: input.existing?.createdAt ?? input.now,
    updatedAt: input.now,
  });
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
    stalenessSnapshot: {
      state: input.agendaItem.needsRegrounding ? "needs_regrounding" : "fresh",
      observedAt: input.now,
      sourceHighWatermark: input.agendaItem.policyEpoch,
      reason: input.agendaItem.needsRegrounding
        ? "agenda requires regrounding before child admission"
        : "agenda projection is fresh for this cycle",
    },
    candidatePayloadRef: null,
    admissionState: "not_admitted",
    outcomeRef: null,
    createdAt: input.now,
    updatedAt: input.now,
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
