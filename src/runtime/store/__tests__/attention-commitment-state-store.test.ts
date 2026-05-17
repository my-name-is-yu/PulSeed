import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyCommitmentLifecycleControl,
  buildCommitmentReemissionInput,
  createCommitmentCandidate,
  CommitmentCandidateExtractionSchema,
  ref,
} from "../../attention/index.js";
import type { AttentionScope } from "../../types/companion-autonomy.js";
import { AttentionStateStore } from "../attention-state-store.js";

const NOW = "2026-05-17T00:00:00.000Z";
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-attention-commitment-store-"));
  tmpDirs.push(dir);
  return dir;
}

function scope(): AttentionScope {
  return {
    userId: "user-1",
    identityId: "identity-1",
    workspaceId: "workspace-1",
    conversationId: "conversation-1",
    sessionId: "session-1",
    surfaceClass: "telegram",
    surfaceRef: "surface:telegram",
    permissionScope: "read_only",
    sensitivity: "medium",
    memoryOwner: null,
    policyEpoch: "policy:commitment-store",
  };
}

function candidate(input: {
  summary?: string;
  turnId?: string;
  nextRevisitAt?: string | null;
} = {}) {
  const turnId = input.turnId ?? "turn-1";
  const created = createCommitmentCandidate({
    extraction: CommitmentCandidateExtractionSchema.parse({
      outcome: "candidate",
      summary: input.summary ?? "Think through the weekend launch note.",
      owner: "user",
      confidence: 0.78,
      sensitivity: "internal",
      allowed_memory_use: "attention_only",
      nudge_policy: "allowed",
      watch_vector: ["related_conversation", "deadline"],
    }),
    scope: scope(),
    turnId,
    sessionId: "session-1",
    sourceId: `chat:session-1:${turnId}:user`,
    emittedAt: NOW,
    policyEpoch: "policy:commitment-store",
    activeSurfaceRef: ref("surface", "surface:telegram"),
  });
  expect(created).not.toBeNull();
  return {
    ...created!,
    materialization_state: "watching" as const,
    next_revisit_at: input.nextRevisitAt === undefined ? NOW : input.nextRevisitAt,
  };
}

describe("AttentionStateStore commitment candidates", () => {
  it("persists commitment lifecycle authority through Control DB restart and replay keys", async () => {
    const baseDir = tmpDir();
    const firstStore = new AttentionStateStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir });
    const firstCandidate = candidate();

    await expect(firstStore.saveCommitmentCandidates([firstCandidate])).resolves.toMatchObject({
      accepted: [expect.objectContaining({ commitment_id: firstCandidate.commitment_id })],
      duplicates: [],
    });
    await expect(firstStore.saveCommitmentCandidates([firstCandidate])).resolves.toMatchObject({
      accepted: [expect.objectContaining({ commitment_id: firstCandidate.commitment_id })],
      duplicates: [],
    });

    const restarted = new AttentionStateStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir });
    await expect(restarted.listCommitmentCandidates({ includeTerminal: true })).resolves.toHaveLength(1);

    const resolved = await restarted.applyCommitmentControl({
      commitmentId: firstCandidate.commitment_id,
      control: "already_done",
      now: "2026-05-17T00:05:00.000Z",
      feedbackRef: "feedback:done",
    });
    expect(resolved).toMatchObject({
      materialization_state: "resolved",
      next_revisit_at: null,
      feedback_refs: ["feedback:done"],
    });

    const finalStore = new AttentionStateStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir });
    await expect(finalStore.listCommitmentCandidates()).resolves.toHaveLength(0);
    await expect(finalStore.listCommitmentCandidates({ includeTerminal: true })).resolves.toMatchObject([
      { materialization_state: "resolved" },
    ]);
    expect(buildCommitmentReemissionInput({
      candidate: resolved!,
      triggerKind: "revisit_window",
      now: "2026-05-17T00:10:00.000Z",
    })).toBeNull();
  });

  it("maps user controls to conservative lifecycle transitions without raw surface exposure", () => {
    const watched = candidate();
    const quieted = applyCommitmentLifecycleControl({
      candidate: watched,
      control: "stop_reminders_like_this",
      now: "2026-05-17T00:05:00.000Z",
      feedbackRef: "feedback:overreach",
    });
    const snoozed = applyCommitmentLifecycleControl({
      candidate: watched,
      control: "snooze",
      now: "2026-05-17T00:05:00.000Z",
      snoozeUntil: "2026-05-18T00:00:00.000Z",
    });
    const tombstoned = applyCommitmentLifecycleControl({
      candidate: watched,
      control: "correct_memory_source",
      now: "2026-05-17T00:05:00.000Z",
      feedbackRef: "feedback:correction",
    });

    expect(quieted).toMatchObject({
      materialization_state: "quieted",
      nudge_policy: "disabled",
      suppression_refs: ["feedback:overreach"],
    });
    expect(snoozed).toMatchObject({
      materialization_state: "snoozed",
      next_revisit_at: "2026-05-18T00:00:00.000Z",
    });
    expect(tombstoned).toMatchObject({
      materialization_state: "tombstoned",
      suppression_refs: ["feedback:correction"],
    });
  });

  it("excludes unscheduled commitments from due-before queries", async () => {
    const baseDir = tmpDir();
    const store = new AttentionStateStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir });
    const due = candidate({
      summary: "Review the scheduled launch note.",
      turnId: "turn-due",
    });
    const unscheduled = candidate({
      summary: "Keep a loose eye on launch messaging.",
      turnId: "turn-unscheduled",
      nextRevisitAt: null,
    });

    await store.saveCommitmentCandidates([unscheduled, due]);

    const listed = await store.listCommitmentCandidates({ dueBefore: NOW });
    expect(listed.map((item) => item.commitment_id)).toEqual([due.commitment_id]);
    expect(listed.map((item) => item.commitment_id)).not.toContain(unscheduled.commitment_id);
  });
});
