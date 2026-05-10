import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  importLegacyTransferTrustState,
  openControlDatabase,
  TransferTrustStateStore,
  transferTrustDomainPairKey,
} from "../index.js";
import { StateManager } from "../../../base/state/state-manager.js";
import type { TransferTrustScore } from "../../../base/types/cross-portfolio.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "transfer-trust-state-store-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeScore(domainPair = "alpha::beta", trustScore = 0.65): TransferTrustScore {
  return {
    domain_pair: domainPair,
    success_count: 2,
    failure_count: 1,
    neutral_count: 0,
    trust_score: trustScore,
    last_updated: "2026-05-10T01:00:00.000Z",
  };
}

describe("TransferTrustStateStore", () => {
  it("persists scores, history, and index entries in the control DB", async () => {
    const tmpDir = makeTmpDir();
    const store = new TransferTrustStateStore(tmpDir);
    const score = makeScore();

    await store.saveScore(score);
    await store.saveHistory(score.domain_pair, ["positive", "negative", "neutral"]);

    await expect(store.loadScore(score.domain_pair)).resolves.toEqual(score);
    await expect(store.loadHistory(score.domain_pair)).resolves.toEqual(["positive", "negative", "neutral"]);
    await expect(store.listScores()).resolves.toEqual([score]);
    await expect(store.listIndexDomainPairs()).resolves.toEqual([score.domain_pair]);
    await expect(store.readRawPath("transfer-trust/alpha::beta.json")).resolves.toEqual({
      handled: true,
      value: score,
    });
    await expect(store.readRawPath("transfer-trust-history/alpha::beta.json")).resolves.toEqual({
      handled: true,
      value: ["positive", "negative", "neutral"],
    });
    await expect(store.readRawPath("transfer-trust/_index.json")).resolves.toEqual({
      handled: true,
      value: [score.domain_pair],
    });
    expect(fs.existsSync(path.join(tmpDir, "transfer-trust", "alpha::beta.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "transfer-trust-history", "alpha::beta.json"))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "transfer-trust", "_index.json"))).toBe(false);
  });

  it("normalizes duplicate slash raw paths before StateManager compatibility routing", async () => {
    const tmpDir = makeTmpDir();
    const stateManager = new StateManager(tmpDir);
    const store = new TransferTrustStateStore(tmpDir);
    const score = makeScore("research ops::runtime");
    const key = transferTrustDomainPairKey(score.domain_pair);

    await stateManager.writeRaw(`transfer-trust//${key}.json`, score);
    await stateManager.writeRaw(`transfer-trust-history//${key}.json`, ["negative", "neutral"]);
    await stateManager.writeRaw("transfer-trust//_index.json", [score.domain_pair]);

    await expect(store.loadScore(score.domain_pair)).resolves.toEqual(score);
    await expect(store.loadHistory(score.domain_pair)).resolves.toEqual(["negative", "neutral"]);
    await expect(stateManager.readRaw(`transfer-trust//${key}.json`)).resolves.toEqual(score);
    await expect(stateManager.readRaw(`transfer-trust-history//${key}.json`)).resolves.toEqual(["negative", "neutral"]);
    await expect(stateManager.readRaw("transfer-trust//_index.json")).resolves.toEqual([score.domain_pair]);
    expect(fs.existsSync(path.join(tmpDir, "transfer-trust", `${key}.json`))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "transfer-trust-history", `${key}.json`))).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "transfer-trust", "_index.json"))).toBe(false);
  });

  it("imports legacy score, history, and index files only through the repair boundary", async () => {
    const tmpDir = makeTmpDir();
    const score = makeScore("alpha beta::gamma");
    const key = transferTrustDomainPairKey(score.domain_pair);
    fs.mkdirSync(path.join(tmpDir, "transfer-trust"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "transfer-trust-history"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "transfer-trust", `${key}.json`), JSON.stringify(score));
    fs.writeFileSync(path.join(tmpDir, "transfer-trust-history", `${key}.json`), JSON.stringify(["positive", "neutral"]));
    fs.writeFileSync(path.join(tmpDir, "transfer-trust", "_index.json"), JSON.stringify([score.domain_pair]));

    const report = await importLegacyTransferTrustState(tmpDir);

    expect(report).toMatchObject({
      indexEntries: 1,
      scores: 1,
      historyEntries: 1,
      skippedAlreadyImported: 0,
      retiredExistingTypedState: 0,
      blockedSources: [],
    });
    const store = new TransferTrustStateStore(tmpDir);
    await expect(store.loadScore(score.domain_pair)).resolves.toEqual(score);
    await expect(store.loadHistory(score.domain_pair)).resolves.toEqual(["positive", "neutral"]);
    await expect(store.listIndexDomainPairs()).resolves.toEqual([score.domain_pair]);

    const controlDb = await openControlDatabase({ baseDir: tmpDir });
    try {
      expect(controlDb.listLegacyImports()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          source_kind: "transfer_trust_index",
          source_id: "current",
          migration_name: "transfer-trust-runtime-state",
          status: "imported",
        }),
        expect.objectContaining({
          source_kind: "transfer_trust_score",
          source_id: key,
          migration_name: "transfer-trust-runtime-state",
          status: "imported",
        }),
        expect.objectContaining({
          source_kind: "transfer_trust_history",
          source_id: key,
          migration_name: "transfer-trust-runtime-state",
          status: "imported",
        }),
      ]));
    } finally {
      controlDb.close();
    }
  });

  it("retires stale legacy files when typed state already exists", async () => {
    const tmpDir = makeTmpDir();
    const typedScore = makeScore("alpha::beta", 0.8);
    const staleScore = makeScore("alpha::beta", 0.2);
    const key = transferTrustDomainPairKey(typedScore.domain_pair);
    const store = new TransferTrustStateStore(tmpDir);
    await store.saveScore(typedScore);
    await store.saveHistory(typedScore.domain_pair, ["positive"]);
    fs.mkdirSync(path.join(tmpDir, "transfer-trust"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, "transfer-trust-history"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "transfer-trust", `${key}.json`), JSON.stringify(staleScore));
    fs.writeFileSync(path.join(tmpDir, "transfer-trust-history", `${key}.json`), JSON.stringify(["negative", "negative"]));

    const report = await importLegacyTransferTrustState(tmpDir);

    expect(report).toMatchObject({
      scores: 0,
      historyEntries: 0,
      retiredExistingTypedState: 2,
    });
    await expect(store.loadScore(typedScore.domain_pair)).resolves.toEqual(typedScore);
    await expect(store.loadHistory(typedScore.domain_pair)).resolves.toEqual(["positive"]);
  });
});
