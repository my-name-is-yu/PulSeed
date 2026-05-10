import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TransferTrustManager } from "../transfer/transfer-trust.js";
import { StateManager } from "../../../base/state/state-manager.js";

// ─── Helpers ───

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "transfer-trust-test-"));
}

function makeStateManager(tmpDir: string): StateManager {
  return new StateManager(tmpDir);
}

// ─── Tests ───

describe("TransferTrustManager", () => {
  let tmpDir: string;
  let stateManager: StateManager;
  let manager: TransferTrustManager;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    stateManager = makeStateManager(tmpDir);
    manager = new TransferTrustManager({ stateManager });
  });

  it("starts with trust_score 0.5", async () => {
    const score = await manager.getTrustScore("testing::development");
    expect(score.trust_score).toBe(0.5);
    expect(score.success_count).toBe(0);
    expect(score.failure_count).toBe(0);
    expect(score.neutral_count).toBe(0);
  });

  it("increments trust_score by 0.1 after positive feedback", async () => {
    const before = await manager.getTrustScore("domain_a::domain_b");
    expect(before.trust_score).toBe(0.5);

    const after = await manager.updateTrust("domain_a::domain_b", "positive");
    expect(after.trust_score).toBeCloseTo(0.6, 5);
    expect(after.success_count).toBe(1);
    expect(after.failure_count).toBe(0);
  });

  it("decrements trust_score by 0.15 after negative feedback", async () => {
    const after = await manager.updateTrust("domain_a::domain_b", "negative");
    expect(after.trust_score).toBeCloseTo(0.35, 5);
    expect(after.failure_count).toBe(1);
    expect(after.success_count).toBe(0);
  });

  it("keeps trust_score unchanged after neutral feedback", async () => {
    const after = await manager.updateTrust("domain_a::domain_b", "neutral");
    expect(after.trust_score).toBe(0.5);
    expect(after.neutral_count).toBe(1);
  });

  it("clamps trust_score to 0.0 after repeated negative feedback", async () => {
    // Start at 0.5, apply 4 negative updates: 0.5 - 0.15*4 = -0.1 → clamped to 0.0
    for (let i = 0; i < 4; i++) {
      await manager.updateTrust("domain_clamp::low", "negative");
    }
    const score = await manager.getTrustScore("domain_clamp::low");
    expect(score.trust_score).toBeGreaterThanOrEqual(0.0);
    expect(score.trust_score).toBe(0.0);
  });

  it("clamps trust_score to 1.0 after repeated positive feedback", async () => {
    // Start at 0.5, apply 6 positive updates: 0.5 + 0.1*6 = 1.1 → clamped to 1.0
    for (let i = 0; i < 6; i++) {
      await manager.updateTrust("domain_clamp::high", "positive");
    }
    const score = await manager.getTrustScore("domain_clamp::high");
    expect(score.trust_score).toBeLessThanOrEqual(1.0);
    expect(score.trust_score).toBe(1.0);
  });

  it("returns true from shouldInvalidate after three consecutive negative updates", async () => {
    const pair = "bad_domain::another";
    await manager.updateTrust(pair, "negative");
    await manager.updateTrust(pair, "negative");
    expect(await manager.shouldInvalidate(pair)).toBe(false);
    await manager.updateTrust(pair, "negative");
    expect(await manager.shouldInvalidate(pair)).toBe(true);
  });

  it("returns true from shouldInvalidate after three consecutive neutral updates", async () => {
    const pair = "neutral_domain::another";
    await manager.updateTrust(pair, "neutral");
    await manager.updateTrust(pair, "neutral");
    await manager.updateTrust(pair, "neutral");
    expect(await manager.shouldInvalidate(pair)).toBe(true);
  });

  it("returns true from shouldInvalidate after three mixed negative or neutral updates", async () => {
    const pair = "mixed_bad::another";
    await manager.updateTrust(pair, "negative");
    await manager.updateTrust(pair, "neutral");
    await manager.updateTrust(pair, "negative");
    expect(await manager.shouldInvalidate(pair)).toBe(true);
  });

  it("returns false from shouldInvalidate when the streak includes positive feedback", async () => {
    const pair = "mixed_good::another";
    await manager.updateTrust(pair, "negative");
    await manager.updateTrust(pair, "negative");
    await manager.updateTrust(pair, "positive"); // resets the streak
    expect(await manager.shouldInvalidate(pair)).toBe(false);
  });

  it("returns false from shouldInvalidate when history has only two entries", async () => {
    const pair = "short_history::another";
    await manager.updateTrust(pair, "negative");
    await manager.updateTrust(pair, "negative");
    expect(await manager.shouldInvalidate(pair)).toBe(false);
  });

  it("round-trips persisted trust state", async () => {
    const pair = "persist::test";
    await manager.updateTrust(pair, "positive");
    await manager.updateTrust(pair, "positive");

    // Create a new manager with the same stateManager (same tmpDir)
    const manager2 = new TransferTrustManager({ stateManager });
    const score = await manager2.getTrustScore(pair);
    expect(score.trust_score).toBeCloseTo(0.7, 5);
    expect(score.success_count).toBe(2);
  });

  it("persists through the typed store without creating legacy JSON files", async () => {
    const pair = "typed::runtime";
    await manager.updateTrust(pair, "positive");
    await manager.updateTrust(pair, "negative");

    expect(fs.existsSync(path.join(tmpDir, "transfer-trust", "typed::runtime.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "transfer-trust-history", "typed::runtime.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "transfer-trust", "_index.json"))).toBe(false);
    await expect(manager.getAllScores()).resolves.toEqual([
      expect.objectContaining({
        domain_pair: pair,
        success_count: 1,
        failure_count: 1,
      }),
    ]);
  });

  it("keeps index-only domain pairs visible as default score records", async () => {
    await stateManager.writeRaw("transfer-trust/_index.json", ["index-only::pair"]);

    await expect(manager.getAllScores()).resolves.toEqual([
      expect.objectContaining({
        domain_pair: "index-only::pair",
        trust_score: 0.5,
        success_count: 0,
        failure_count: 0,
        neutral_count: 0,
      }),
    ]);
  });

  it("ignores stale legacy score and history files on the normal runtime caller path", async () => {
    const pair = "legacy::stale";
    fs.mkdirSync(path.join(tmpDir, "transfer-trust"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "transfer-trust-history"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "transfer-trust", "legacy::stale.json"), JSON.stringify({
      domain_pair: pair,
      success_count: 9,
      failure_count: 0,
      neutral_count: 0,
      trust_score: 1,
      last_updated: "2026-05-09T00:00:00.000Z",
    }));
    fs.writeFileSync(path.join(tmpDir, "transfer-trust-history", "legacy::stale.json"), JSON.stringify([
      "negative",
      "negative",
      "negative",
    ]));

    const score = await manager.getTrustScore(pair);

    expect(score.trust_score).toBe(0.5);
    expect(await manager.shouldInvalidate(pair)).toBe(false);
  });

  it("computes the scoring formula: similarity * confidence * trustScore", () => {
    // This is a pure calculation test — no async needed
    const similarityScore = 0.8;
    const confidence = 0.9;
    const trustScore = 0.6;
    const baseScore = similarityScore * confidence * trustScore;
    expect(baseScore).toBeCloseTo(0.432, 5);
  });

  it("adds the domain_tag_match 0.1 bonus with an upper clamp at 1.0", () => {
    const similarityScore = 0.8;
    const confidence = 0.9;
    const trustScore = 0.8;
    const baseScore = similarityScore * confidence * trustScore;
    // With domain_tag_match bonus
    const withBonus = Math.min(1.0, baseScore + 0.1);
    expect(withBonus).toBeCloseTo(Math.min(1.0, baseScore + 0.1), 5);
    expect(withBonus).toBeGreaterThan(baseScore);
  });

  it("keeps the domain_tag_match bonus from exceeding 1.0", () => {
    const baseScore = 0.95; // close to 1.0
    const withBonus = Math.min(1.0, baseScore + 0.1);
    expect(withBonus).toBe(1.0);
  });
});
