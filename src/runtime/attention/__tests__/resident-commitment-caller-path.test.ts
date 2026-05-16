import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CommitmentCandidateExtractionSchema,
  createCommitmentCandidate,
  ref,
} from "../index.js";
import { runResidentCommitmentAttentionCycle } from "../../daemon/runner-resident-proactive.js";
import { AttentionStateStore } from "../../store/attention-state-store.js";
import { PeerInitiativeStore } from "../../peer-initiative/index.js";
import { createFeedbackIngestion } from "../feedback-ingestion.js";
import { FeedbackIngestionStore } from "../../store/feedback-ingestion-store.js";
import type { AttentionScope } from "../../types/companion-autonomy.js";
import type { DaemonRunnerResidentContext } from "../../daemon/runner-resident-shared.js";

const NOW = "2026-05-17T00:00:00.000Z";
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-resident-commitment-"));
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
    policyEpoch: "policy:resident-commitment",
  };
}

function commitmentCandidate() {
  const candidate = createCommitmentCandidate({
    extraction: CommitmentCandidateExtractionSchema.parse({
      outcome: "candidate",
      summary: "Review the pitch deck tomorrow.",
      due: {
        window_start: NOW,
        window_end: "2026-05-17T01:00:00.000Z",
        uncertainty: "medium",
        reason: "test due window",
      },
      owner: "user",
      confidence: 0.86,
      sensitivity: "internal",
      allowed_memory_use: "attention_only",
      nudge_policy: "allowed",
      watch_vector: ["deadline", "related_conversation"],
    }),
    scope: scope(),
    turnId: "turn-1",
    sessionId: "session-1",
    sourceId: "chat:session-1:turn-1:user",
    emittedAt: "2026-05-16T23:50:00.000Z",
    policyEpoch: "policy:resident-commitment",
    activeSurfaceRef: ref("surface", "surface:telegram"),
  });
  expect(candidate).not.toBeNull();
  return {
    ...candidate!,
    materialization_state: "watching" as const,
    next_revisit_at: NOW,
  };
}

function context(baseDir: string, store: AttentionStateStore): Pick<
  DaemonRunnerResidentContext,
  "baseDir" | "config" | "state" | "logger" | "saveDaemonState" | "attentionStateStore" | "feedbackIngestionStore"
> {
  return {
    baseDir,
    config: { runtime_root: "runtime" } as DaemonRunnerResidentContext["config"],
    state: {
      started_at: "2026-05-17T00:00:00.000Z",
      loop_count: 12,
    } as DaemonRunnerResidentContext["state"],
    logger: {
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    } as never,
    saveDaemonState: vi.fn(async () => {}),
    attentionStateStore: store,
    feedbackIngestionStore: new FeedbackIngestionStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir }),
  };
}

describe("resident commitment attention caller path", () => {
  it("re-enters a watched commitment through resident attention and holds the peer follow-up via existing delivery gates", async () => {
    const baseDir = tmpDir();
    const store = new AttentionStateStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir });
    await store.saveCommitmentCandidates([commitmentCandidate()]);

    const handled = await runResidentCommitmentAttentionCycle(context(baseDir, store), NOW);

    expect(handled).toBe(true);
    await expect(store.listCommitmentCandidates({ includeTerminal: true })).resolves.toMatchObject([
      expect.objectContaining({ materialization_state: "active_care" }),
    ]);
    const peerRecords = await new PeerInitiativeStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir })
      .listRecentCandidates();
    expect(peerRecords).toHaveLength(1);
    expect(peerRecords[0]).toMatchObject({
      selected_state: "held",
      candidate: expect.objectContaining({
        max_delivery_kind: "suggest",
        action_plan: expect.objectContaining({
          mode: "internal_preparation",
          preparation_kind: "followup_candidate",
        }),
      }),
    });
    await expect(store.loadConcernState({ scope: scope() })).resolves.toMatchObject({
      agenda_items: [expect.objectContaining({ kind: "commitment_guard" })],
    });

    await runResidentCommitmentAttentionCycle(context(baseDir, store), NOW);
    await expect(new PeerInitiativeStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir })
      .listRecentCandidates()).resolves.toHaveLength(1);
  });

  it("uses recent overreach feedback to quiet due commitments before visible follow-up selection", async () => {
    const baseDir = tmpDir();
    const store = new AttentionStateStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir });
    await store.saveCommitmentCandidates([commitmentCandidate()]);
    const feedbackStore = new FeedbackIngestionStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir });
    await feedbackStore.append(createFeedbackIngestion({
      source: "telegram",
      feedback_kind: "overreach",
      outcome: "overreach",
      target: { kind: "agenda_item", id: "commitment-guard" },
      recorded_at: "2026-05-16T23:59:00.000Z",
      reason: "too much right now",
      agenda_kind: "commitment_guard",
      overreach_indicators: ["unwanted_timing"],
    }));
    await expect(feedbackStore.listEffects()).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ effect_kind: "autonomy_feedback_signal" }),
      expect.objectContaining({ effect_kind: "attention_cooldown" }),
    ]));

    const residentContext = {
      ...context(baseDir, store),
      feedbackIngestionStore: feedbackStore,
    };
    const handled = await runResidentCommitmentAttentionCycle(residentContext, NOW);

    await expect(store.listCommitmentCandidates({ includeTerminal: true })).resolves.toMatchObject([
      expect.objectContaining({
        materialization_state: "quieted",
        nudge_policy: "disabled",
      }),
    ]);
    expect(handled).toBe(true);
    await expect(new PeerInitiativeStore(path.join(baseDir, "runtime"), { controlBaseDir: baseDir })
      .listRecentCandidates()).resolves.toHaveLength(0);
  });
});
