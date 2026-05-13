import { describe, expect, it, vi } from "vitest";
import { evaluateResidentProactiveCognition } from "../runner-resident-proactive.js";

describe("resident proactive cognition", () => {
  it("records hold-only cognition metadata when the resident operation boundary blocks preparation", async () => {
    const metadata = await evaluateResidentProactiveCognition({
      attentionAdmission: {
        action: "preemptive_check",
        source_kind: "resident_proactive_maintenance",
        attention_input_id: "attention:input:1",
        signal_context_id: "signal:1",
        urge_id: "urge:1",
        agenda_item_id: "agenda:1",
        inhibition_decision_id: "inhibition:1",
        initiative_gate_decision_id: "gate:1",
        replay_disposition: "accepted",
        requested_outcome: "prepare_action_candidate",
        admission_status: "admitted",
        branch_admitted: true,
        summary: "Resident proactive maintenance selected a preemptive check.",
      },
      operationActivityMetadata: {
        operation_plan_status: "fail_closed",
        operation_plan_reason: "operation boundary blocked preparation",
        operation_preparation_allowed: false,
        operation_execution_allowed: false,
      },
      surfaceActivityMetadata: {},
      logger: {
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      } as never,
    });

    expect(metadata).toMatchObject({
      cognition_id: "cognition:resident:gate:1",
      cognition_delivery_kind: "hold",
      cognition_writeback_proposal_count: 1,
    });
  });
});
