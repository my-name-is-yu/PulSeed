import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { StrategyTemplate } from "../../../base/types/cross-portfolio.js";
import { StrategyTemplateStateStore } from "../strategy-template-state-store.js";
import { importLegacyStrategyTemplateState } from "../strategy-template-state-migration.js";

function makeTemplate(overrides: Partial<StrategyTemplate> = {}): StrategyTemplate {
  return {
    template_id: "tmpl-test-001",
    source_goal_id: "goal-001",
    source_strategy_id: "strat-001",
    hypothesis_pattern: "Automate repetitive verification work",
    domain_tags: ["automation", "verification"],
    effectiveness_score: 0.82,
    applicable_dimensions: ["throughput"],
    embedding_id: "emb-001",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("StrategyTemplateStateStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pulseed-strategy-template-store-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("saves, loads, lists, and upserts strategy templates in the control DB", async () => {
    const store = new StrategyTemplateStateStore(tmpDir);
    const template = makeTemplate();

    await store.save(template);
    expect(await store.load(template.template_id)).toEqual(template);
    expect(await store.list()).toEqual([template]);

    const updated = makeTemplate({ effectiveness_score: 0.91, domain_tags: ["updated"] });
    await store.save(updated);

    expect(await store.load(template.template_id)).toEqual(updated);
    expect(await store.list()).toEqual([updated]);
    expect(fs.existsSync(path.join(tmpDir, "strategy-templates.json"))).toBe(false);
  });

  it("imports legacy strategy-templates.json only through the explicit repair boundary", async () => {
    const validTemplate = makeTemplate({ template_id: "tmpl-imported" });
    const invalidTemplate = {
      template_id: "tmpl-invalid",
      source_goal_id: "goal-invalid",
      source_strategy_id: "strat-invalid",
      hypothesis_pattern: "invalid",
      domain_tags: ["invalid"],
      effectiveness_score: 2,
      applicable_dimensions: ["throughput"],
      embedding_id: null,
      created_at: "2026-01-01T00:00:00.000Z",
    };
    fs.writeFileSync(
      path.join(tmpDir, "strategy-templates.json"),
      JSON.stringify([validTemplate, invalidTemplate], null, 2),
      "utf8",
    );

    const firstReport = await importLegacyStrategyTemplateState(tmpDir);
    expect(firstReport).toMatchObject({
      strategyTemplateFiles: 1,
      importedTemplates: 1,
      skippedAlreadyImported: 0,
    });
    expect(firstReport.blockedSources).toHaveLength(1);

    const store = new StrategyTemplateStateStore(tmpDir);
    expect(await store.load("tmpl-imported")).toEqual(validTemplate);

    const secondReport = await importLegacyStrategyTemplateState(tmpDir);
    expect(secondReport.importedTemplates).toBe(0);
    expect(secondReport.skippedAlreadyImported).toBe(1);
    expect(secondReport.blockedSources).toHaveLength(1);
  });
});
