export {
  COGNITION_AUDIT_STORAGE_PLAN,
  FileCognitionAuditSink,
  InMemoryCognitionAuditSink,
  cognitionAuditEventRef,
  createCognitionReplayRecord,
} from "./audit-sink.js";
export {
  CloudBoundaryEvaluationSchema,
  CloudBoundaryModeSchema,
  evaluateCloudBoundaryForCognition,
} from "./cloud-boundary.js";
export {
  CompanionCognitionService,
} from "./companion-cognition-service.js";
export {
  AuthorizationRequestSchema,
  ChatSessionCognitionContextSchema,
  CloudComputeRequestSchema,
  CognitionEventRefSchema,
  CognitionMemoryRequestSchema,
  CognitionMemoryResultSchema,
  CognitionMemorySourceSchema,
  CognitionRedactionPolicySchema,
  CognitionRefSchema,
  CognitionReplayRecordSchema,
  CognitionSourceStoreSchema,
  CognitionUncertaintySchema,
  CognitionWritebackReflectionInputSchema,
  CompanionCognitionCallerPathSchema,
  CompanionCognitionInputSchema,
  CompanionCognitionOutputSchema,
  CompanionCognitionSurfaceTargetSchema,
  GoalIntentionContextSchema,
  GoalRefSchema,
  IntentionLifecycleSchema,
  IntentionSelectionSchema,
  MemoryWritebackProposalSchema,
  PrivacyProfileSchema,
  ProactiveDeliveryKindSchema,
  ReflectionHintSchema,
  RelationshipStateProjectionSchema,
  ResponsePlanSchema,
  RuntimeCognitionContextSchema,
  SideEffectProfileSchema,
  SituationModelSchema,
  ToolAuthorityStageSchema,
  ToolCandidateSchema,
  ToolRiskClassSchema,
  WorkingContextSnapshotSchema,
  deliveryKindRank,
} from "./contracts.js";
export {
  createEmptyCognitionMemoryResult,
  createRelationshipProfileCognitionMemoryPort,
  cognitionMemoryResultFromCoreProjection,
} from "./memory-context.js";
export {
  MEMORY_LIFECYCLE_OWNER_ROUTING_TABLE,
  MemoryLifecycleCanonicalOwnerSchema,
  MemoryLifecycleOwnerRoutingRuleSchema,
  MemoryLifecycleProposedTargetSchema,
  MemoryLifecycleWritebackOwnerSchema,
  ownerForMemoryWritebackProposal,
  ownerRoutingRuleForProposal,
} from "./memory-writeback-owner-routing.js";
export {
  assembleSituationModel,
} from "./situation.js";
export {
  createCloudComputeAuthorizationRequest,
  toolCandidateFromGadgetPlan,
} from "./tool-authority.js";
export {
  createReflectionHintForWriteback,
  createReflectionInputFromCognitionReplay,
  createTurnEpisodeWritebackProposal,
} from "./writeback.js";
export type {
  CognitionAuditSink,
  CognitionMemoryPort,
  CognitionWritebackPort,
} from "./ports.js";
export type {
  CloudBoundaryEvaluation,
  CloudBoundaryMode,
} from "./cloud-boundary.js";
export type {
  AuthorizationRequest,
  ChatSessionCognitionContext,
  CloudComputeRequest,
  CognitionEventRef,
  CognitionMemoryRequest,
  CognitionMemoryResult,
  CognitionMemorySource,
  CognitionRedactionPolicy,
  CognitionRef,
  CognitionReplayRecord,
  CognitionRequestedMemoryUse,
  CognitionSourceStore,
  CognitionUncertainty,
  CognitionWritebackReflectionInput,
  CompanionCognitionCallerPath,
  CompanionCognitionInput,
  CompanionCognitionOutput,
  CompanionCognitionSurfaceTarget,
  GoalIntentionContext,
  GoalRef,
  IntentionLifecycle,
  IntentionSelection,
  MemoryWritebackProposal,
  PrivacyProfile,
  ProactiveDeliveryKind,
  ReflectionHint,
  RelationshipStateProjection,
  ResponsePlan,
  RuntimeCognitionContext,
  SideEffectProfile,
  SituationModel,
  ToolAuthorityStage,
  ToolCandidate,
  ToolRiskClass,
  WorkingContextSnapshot,
} from "./contracts.js";
export type {
  CompanionCognitionServiceDeps,
} from "./companion-cognition-service.js";
export type {
  MemoryLifecycleCanonicalOwner,
  MemoryLifecycleOwnerRoutingRule,
  MemoryLifecycleProposedTarget,
  MemoryLifecycleWritebackOwner,
} from "./memory-writeback-owner-routing.js";
