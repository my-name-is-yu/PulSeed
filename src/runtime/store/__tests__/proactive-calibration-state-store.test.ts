import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { createProactivePolicyState } from "../../attention/index.js";
import {
  DEFAULT_RESIDENT_ACTIVATION_POLICY_ID,
  ProactivePolicyStateStore,
  ResidentActivationStore,
  applyResidentActivationBindingToPolicyState,
  clearInactiveResidentActivationBudgetFromPolicyState,
} from "../index.js";

const NOW = "2026-05-16T00:00:00.000Z";

describe("proactive calibration runtime state stores", () => {
  it("persists feedback policy state idempotently and never raises delivery from accepted feedback", async () => {
    const tmpDir = makeTempDir("pulseed-proactive-policy-state-");
    try {
      const store = new ProactivePolicyStateStore(path.join(tmpDir, "runtime"), { controlBaseDir: tmpDir });
      const first = await store.applyEvents({
        policyId: DEFAULT_RESIDENT_ACTIVATION_POLICY_ID,
        now: NOW,
        maxDeliveryKind: "digest",
        events: [{
          kind: "feedback",
          feedback_ref: { kind: "peer_feedback_projection", ref: "peer-feedback:accepted" },
          feedback_kind: "accepted",
          recorded_at: "2026-05-16T00:01:00.000Z",
        }],
      });
      const second = await store.applyEvents({
        policyId: DEFAULT_RESIDENT_ACTIVATION_POLICY_ID,
        now: "2026-05-16T00:02:00.000Z",
        maxDeliveryKind: "suggest",
        events: [{
          kind: "feedback",
          feedback_ref: { kind: "peer_feedback_projection", ref: "peer-feedback:accepted" },
          feedback_kind: "accepted",
          recorded_at: "2026-05-16T00:01:00.000Z",
        }],
      });

      expect(first.state).toMatchObject({
        max_delivery_kind: "digest",
        runtime_authority: false,
      });
      expect(first.result).toMatchObject({
        applied_event_count: 1,
        skipped_existing_event_count: 0,
        after_max_delivery_kind: "digest",
        runtime_authority: false,
      });
      expect(second.result).toMatchObject({
        applied_event_count: 0,
        skipped_existing_event_count: 1,
        after_max_delivery_kind: "digest",
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("binds an explicit one-day resident activation budget without overwriting negative feedback cooldowns", async () => {
    const tmpDir = makeTempDir("pulseed-resident-activation-");
    try {
      const activationStore = new ResidentActivationStore(path.join(tmpDir, "runtime"), { controlBaseDir: tmpDir });
      const proposal = await activationStore.propose({
        dogfoodDurationHours: 24,
        now: NOW,
      });
      const binding = await activationStore.accept(proposal.proposal_id, "2026-05-16T00:05:00.000Z");
      const status = await activationStore.projectStatus({ generatedAt: "2026-05-16T00:06:00.000Z" });
      const feedbackNarrowed = createProactivePolicyState({
        policyId: DEFAULT_RESIDENT_ACTIVATION_POLICY_ID,
        now: NOW,
        maxDeliveryKind: "digest",
      });
      const effective = applyResidentActivationBindingToPolicyState({
        state: {
          ...feedbackNarrowed,
          feedback_refs: [{ kind: "peer_feedback_projection", ref: "peer-feedback:not-now" }],
        },
        binding,
        now: "2026-05-16T00:06:00.000Z",
      });

      expect(status).toMatchObject({
        active: true,
        active_binding: {
          max_delivery_kind: "notify",
          budget: { max_notify: 4 },
        },
        raw_refs_visible: false,
        runtime_authority: false,
      });
      expect(effective).toMatchObject({
        max_delivery_kind: "digest",
        interruption_budget: {
          max_notify: 4,
          current_debits: 0,
        },
        runtime_authority: false,
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("applies resident activation policy updates against the latest persisted feedback state", async () => {
    const tmpDir = makeTempDir("pulseed-resident-activation-policy-update-");
    try {
      const runtimeRoot = path.join(tmpDir, "runtime");
      const activationStore = new ResidentActivationStore(runtimeRoot, { controlBaseDir: tmpDir });
      const proposal = await activationStore.propose({
        dogfoodDurationHours: 24,
        now: NOW,
      });
      const binding = await activationStore.accept(proposal.proposal_id, "2026-05-16T00:05:00.000Z");
      const store = new ProactivePolicyStateStore(runtimeRoot, { controlBaseDir: tmpDir });
      const staleSnapshot = await store.loadOrCreate({
        policyId: DEFAULT_RESIDENT_ACTIVATION_POLICY_ID,
        now: NOW,
        maxDeliveryKind: "notify",
      });
      await store.applyEvents({
        policyId: DEFAULT_RESIDENT_ACTIVATION_POLICY_ID,
        now: "2026-05-16T00:06:00.000Z",
        maxDeliveryKind: "notify",
        events: [{
          kind: "feedback",
          feedback_ref: { kind: "peer_feedback_projection", ref: "peer-feedback:not-now" },
          feedback_kind: "dismissed",
          recorded_at: "2026-05-16T00:06:00.000Z",
        }],
      });

      const updated = await store.updateState({
        policyId: DEFAULT_RESIDENT_ACTIVATION_POLICY_ID,
        now: "2026-05-16T00:07:00.000Z",
        maxDeliveryKind: "notify",
        updater: (state) => applyResidentActivationBindingToPolicyState({
          state,
          binding,
          now: "2026-05-16T00:07:00.000Z",
        }),
      });

      expect(staleSnapshot.feedback_refs).toHaveLength(0);
      expect(updated).toMatchObject({
        max_delivery_kind: "digest",
        cooldown_refs: [{ kind: "peer_feedback_projection", ref: "peer-feedback:not-now" }],
        feedback_refs: [{ kind: "peer_feedback_projection", ref: "peer-feedback:not-now" }],
        interruption_budget: {
          budget_id: binding.interruption_budget.budget_id,
        },
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("records resident activation budget debits against the latest persisted feedback state", async () => {
    const tmpDir = makeTempDir("pulseed-resident-activation-budget-debit-update-");
    try {
      const runtimeRoot = path.join(tmpDir, "runtime");
      const activationStore = new ResidentActivationStore(runtimeRoot, { controlBaseDir: tmpDir });
      const proposal = await activationStore.propose({
        dogfoodDurationHours: 24,
        now: NOW,
      });
      const binding = await activationStore.accept(proposal.proposal_id, "2026-05-16T00:05:00.000Z");
      const store = new ProactivePolicyStateStore(runtimeRoot, { controlBaseDir: tmpDir });
      const activated = applyResidentActivationBindingToPolicyState({
        state: createProactivePolicyState({
          policyId: DEFAULT_RESIDENT_ACTIVATION_POLICY_ID,
          now: NOW,
          maxDeliveryKind: "notify",
        }),
        binding,
        now: "2026-05-16T00:05:30.000Z",
      });
      await store.save(activated);
      const staleSnapshot = await store.load(DEFAULT_RESIDENT_ACTIVATION_POLICY_ID);
      await store.applyEvents({
        policyId: DEFAULT_RESIDENT_ACTIVATION_POLICY_ID,
        now: "2026-05-16T00:06:00.000Z",
        maxDeliveryKind: "notify",
        events: [{
          kind: "feedback",
          feedback_ref: { kind: "peer_feedback_projection", ref: "peer-feedback:not-now" },
          feedback_kind: "dismissed",
          recorded_at: "2026-05-16T00:06:00.000Z",
        }],
      });

      const debited = await store.recordBudgetDebit({
        policyId: DEFAULT_RESIDENT_ACTIVATION_POLICY_ID,
        amount: 1,
        debitedAt: "2026-05-16T00:07:00.000Z",
      });

      expect(staleSnapshot?.feedback_refs).toHaveLength(0);
      expect(debited).toMatchObject({
        max_delivery_kind: "digest",
        cooldown_refs: [{ kind: "peer_feedback_projection", ref: "peer-feedback:not-now" }],
        feedback_refs: [{ kind: "peer_feedback_projection", ref: "peer-feedback:not-now" }],
        interruption_budget: {
          budget_id: binding.interruption_budget.budget_id,
          current_debits: 1,
        },
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("preserves resident activation budget debits across binding reapplication and clears inactive activation budgets", async () => {
    const tmpDir = makeTempDir("pulseed-resident-activation-budget-");
    try {
      const activationStore = new ResidentActivationStore(path.join(tmpDir, "runtime"), { controlBaseDir: tmpDir });
      const proposal = await activationStore.propose({
        dogfoodDurationHours: 24,
        now: NOW,
      });
      const binding = await activationStore.accept(proposal.proposal_id, "2026-05-16T00:05:00.000Z");
      const state = createProactivePolicyState({
        policyId: DEFAULT_RESIDENT_ACTIVATION_POLICY_ID,
        now: NOW,
        maxDeliveryKind: "notify",
      });
      const activated = applyResidentActivationBindingToPolicyState({
        state,
        binding,
        now: "2026-05-16T00:06:00.000Z",
      });
      const debited = {
        ...activated,
        interruption_budget: {
          ...activated.interruption_budget!,
          current_debits: 2,
        },
      };
      const reapplied = applyResidentActivationBindingToPolicyState({
        state: debited,
        binding,
        now: "2026-05-16T00:07:00.000Z",
      });
      const cleared = clearInactiveResidentActivationBudgetFromPolicyState({
        state: reapplied,
        now: "2026-05-17T00:06:00.000Z",
      });

      expect(reapplied.interruption_budget).toMatchObject({
        budget_id: binding.interruption_budget.budget_id,
        max_notify: 4,
        current_debits: 2,
      });
      expect(cleared.interruption_budget).toBeUndefined();
      expect(cleared).toMatchObject({
        max_delivery_kind: "notify",
        runtime_authority: false,
      });
    } finally {
      cleanupTempDir(tmpDir);
    }
  });

  it("restores temporary activation delivery caps on expiry without lifting feedback cooldowns", async () => {
    const tmpDir = makeTempDir("pulseed-resident-activation-cap-expiry-");
    try {
      const activationStore = new ResidentActivationStore(path.join(tmpDir, "runtime"), { controlBaseDir: tmpDir });
      const proposal = await activationStore.propose({
        requestedMaxDeliveryKind: "suggest",
        dogfoodDurationHours: 24,
        now: NOW,
      });
      const binding = await activationStore.accept(proposal.proposal_id, "2026-05-16T00:05:00.000Z");
      const state = createProactivePolicyState({
        policyId: DEFAULT_RESIDENT_ACTIVATION_POLICY_ID,
        now: NOW,
        maxDeliveryKind: "notify",
      });
      const activationCapped = applyResidentActivationBindingToPolicyState({
        state,
        binding,
        now: "2026-05-16T00:06:00.000Z",
      });
      const restored = clearInactiveResidentActivationBudgetFromPolicyState({
        state: activationCapped,
        now: "2026-05-17T00:06:00.000Z",
      });
      const quietRestored = clearInactiveResidentActivationBudgetFromPolicyState({
        state: {
          ...activationCapped,
          mode: "quiet",
        },
        now: "2026-05-17T00:06:30.000Z",
      });
      const feedbackCapped = clearInactiveResidentActivationBudgetFromPolicyState({
        state: {
          ...activationCapped,
          max_delivery_kind: "digest",
          cooldown_refs: [{ kind: "peer_feedback_projection", ref: "peer-feedback:not-now" }],
          feedback_refs: [{ kind: "peer_feedback_projection", ref: "peer-feedback:not-now" }],
        },
        now: "2026-05-17T00:07:00.000Z",
      });

      expect(activationCapped).toMatchObject({
        max_delivery_kind: "suggest",
        interruption_budget: {
          budget_id: binding.interruption_budget.budget_id,
        },
      });
      expect(restored).toMatchObject({
        max_delivery_kind: "notify",
        runtime_authority: false,
      });
      expect(quietRestored).toMatchObject({
        mode: "quiet",
        max_delivery_kind: "notify",
        runtime_authority: false,
      });
      expect(restored.interruption_budget).toBeUndefined();
      expect(quietRestored.interruption_budget).toBeUndefined();
      expect(feedbackCapped).toMatchObject({
        max_delivery_kind: "digest",
        cooldown_refs: [{ kind: "peer_feedback_projection", ref: "peer-feedback:not-now" }],
      });
      expect(feedbackCapped.interruption_budget).toBeUndefined();
    } finally {
      cleanupTempDir(tmpDir);
    }
  });
});
