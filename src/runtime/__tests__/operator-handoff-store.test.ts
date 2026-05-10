import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RuntimeOperatorHandoffStore } from "../store/operator-handoff-store.js";

describe("RuntimeOperatorHandoffStore", () => {
  let tmpDir: string;
  let store: RuntimeOperatorHandoffStore;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "pulseed-operator-handoff-"));
    store = new RuntimeOperatorHandoffStore(path.join(tmpDir, "runtime"), {
      now: () => new Date("2026-05-01T00:00:00.000Z"),
    });
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it("persists open handoffs and resolves them durably", async () => {
    const created = await store.create({
      handoff_id: "handoff-run-1",
      goal_id: "goal-1",
      run_id: "run-1",
      triggers: ["deadline", "external_action"],
      title: "Operator handoff",
      summary: "Deadline finalization requires approval.",
      current_status: "mode=finalization",
      recommended_action: "Approve or skip the external action.",
      required_approvals: ["Publish report"],
      next_action: {
        label: "Publish report",
        tool_name: "publish_report",
        payload_ref: "artifact:best",
        approval_required: true,
      },
      evidence_refs: [{ kind: "artifact", ref: "reports/final.md" }],
    });

    expect(created).toMatchObject({
      schema_version: "runtime-operator-handoff-v1",
      status: "open",
      handoff_id: "handoff-run-1",
      required_approvals: ["Publish report"],
    });

    const restarted = new RuntimeOperatorHandoffStore(path.join(tmpDir, "runtime"));
    expect(await restarted.listOpen()).toHaveLength(1);
    await expect(fsp.stat(path.join(tmpDir, "runtime", "operator-handoffs", "handoff-run-1.json"))).rejects.toThrow();

    await restarted.resolve("handoff-run-1", "approved");
    expect(await restarted.listOpen()).toHaveLength(0);
    expect(await restarted.load("handoff-run-1")).toMatchObject({
      status: "approved",
      resolved_at: expect.any(String),
    });
  });
});
