import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { cleanupTempDir, makeTempDir } from "../../../../tests/helpers/temp-dir.js";
import { writeJsonFileAtomic } from "../../../base/utils/json-io.js";
import { KnowledgeMemoryStateStore } from "../../knowledge/knowledge-memory-state-store.js";
import { saveAgentMemoryStoreToTruth, saveDomainKnowledgeToTruth, saveSharedKnowledgeToTruth } from "../../knowledge/memory-truth-adapter.js";
import { AgentMemoryStoreSchema } from "../../knowledge/types/agent-memory.js";
import { ScheduleEntryStore } from "../../../runtime/schedule/entry-store.js";
import { ScheduleEntrySchema } from "../../../runtime/types/schedule.js";
import { SoilCompiler } from "../compiler.js";
import { rebuildSoilFromRuntime } from "../runtime-rebuild.js";
import { SoilDoctor } from "../doctor.js";
import { SqliteSoilRepository } from "../sqlite-repository.js";
import {
  loadSoilOverlayQueue,
  scanAndStoreSoilOverlays,
  updateSoilOverlayStatus,
} from "../importer.js";
import { readSoilMarkdownFile } from "../io.js";
import { SoilPageFrontmatterSchema } from "../types.js";

function fixedClock(): Date {
  return new Date("2026-04-11T10:00:00.000Z");
}

describe("Soil runtime rebuild", () => {
  it("rebuilds projections and index from runtime DB truth", async () => {
    const baseDir = makeTempDir("soil-runtime-rebuild-");
    try {
      await writeJsonFileAtomic(path.join(baseDir, "reports", "goal-1", "report-1.json"), {
        id: "report-1",
        report_type: "weekly_report",
        goal_id: "goal-1",
        title: "Weekly Report",
        content: "Weekly progress and schedule notes.",
        verbosity: "standard",
        generated_at: "2026-04-11T09:00:00.000Z",
        delivered_at: null,
        read: false,
      });
      const knowledgeMemoryStore = new KnowledgeMemoryStateStore(baseDir);
      await knowledgeMemoryStore.saveDomainKnowledge({
        goal_id: "goal-1",
        domain: "research",
        last_updated: "2026-04-11T09:00:00.000Z",
        entries: [
          {
            entry_id: "k-1",
            question: "What matters?",
            answer: "Readable projections.",
            sources: [{ type: "document", reference: "doc", reliability: "high" }],
            confidence: 0.9,
            acquired_at: "2026-04-11T08:00:00.000Z",
            acquisition_task_id: "task-1",
            superseded_by: null,
            tags: ["soil"],
            embedding_id: null,
          },
        ],
      });
      await knowledgeMemoryStore.saveSharedKnowledgeEntries([]);
      await knowledgeMemoryStore.saveAgentMemoryStore(AgentMemoryStoreSchema.parse({
        entries: [
          {
            id: "m-1",
            key: "tone",
            value: "Prefer concise answers.",
            tags: ["preference"],
            memory_type: "preference",
            status: "compiled",
            created_at: "2026-04-11T08:00:00.000Z",
            updated_at: "2026-04-11T09:00:00.000Z",
          },
        ],
        last_consolidated_at: "2026-04-11T09:30:00.000Z",
      }));
      await writeJsonFileAtomic(path.join(baseDir, "decisions", "goal-1-2026-04-11T09-00-00-000Z.json"), {
        id: "d-1",
        goal_id: "goal-1",
        goal_type: "research",
        strategy_id: "s-1",
        decision: "proceed",
        context: { gap_value: 0.1, stall_count: 0, cycle_count: 1, trust_score: 1 },
        outcome: "pending",
        timestamp: "2026-04-11T09:00:00.000Z",
        what_worked: [],
        what_failed: [],
        suggested_next: [],
      });
      await fsp.writeFile(path.join(baseDir, "SEED.md"), "# Seed\n", "utf-8");
      await fsp.writeFile(path.join(baseDir, "ROOT.md"), "# Root\n", "utf-8");
      await fsp.writeFile(path.join(baseDir, "USER.md"), "# User\n", "utf-8");

      const report = await rebuildSoilFromRuntime({ baseDir, clock: fixedClock });

      expect(report.projected.reports).toBe(1);
      expect(report.projected.domainKnowledge).toBe(1);
      expect(report.projected.agentMemory).toBe(1);
      expect(report.projected.decisions).toBe(1);
      expect(report.index.page_count).toBeGreaterThan(5);

      expect(await readSoilMarkdownFile(path.join(baseDir, "soil", "knowledge", "domain", "goal-1.md"))).not.toBeNull();
      expect(await readSoilMarkdownFile(path.join(baseDir, "soil", "memory", "index.md"))).not.toBeNull();
      expect(await readSoilMarkdownFile(path.join(baseDir, "soil", "decision", "recent.md"))).not.toBeNull();

      const doctor = await SoilDoctor.create({ rootDir: path.join(baseDir, "soil") }).inspect();
      expect(doctor.findings.filter((finding) => finding.code === "missing-index")).toHaveLength(0);
      expect(doctor.findings.filter((finding) => finding.code === "watermark-mismatch")).toHaveLength(0);
      expect(doctor.findings.filter((finding) => finding.code === "index-checksum-mismatch")).toHaveLength(0);
    } finally {
      cleanupTempDir(baseDir);
    }
  });

  it("rebuilds schedules from Control DB without pruning DB provenance", async () => {
    const baseDir = makeTempDir("soil-runtime-rebuild-schedule-");
    try {
      const entry = ScheduleEntrySchema.parse({
        id: "22222222-2222-4222-8222-222222222222",
        name: "control-db-schedule",
        layer: "heartbeat",
        trigger: { type: "interval", seconds: 60, jitter_factor: 0 },
        enabled: true,
        heartbeat: {
          check_type: "custom",
          check_config: { command: "echo ok" },
          failure_threshold: 3,
          timeout_ms: 5000,
        },
        created_at: "2026-04-11T09:00:00.000Z",
        updated_at: "2026-04-11T09:00:00.000Z",
        last_fired_at: null,
        next_fire_at: "2026-04-11T09:01:00.000Z",
        consecutive_failures: 0,
        last_escalation_at: null,
        escalation_timestamps: [],
        total_executions: 0,
        total_tokens_used: 0,
        max_tokens_per_day: 100000,
        tokens_used_today: 0,
        budget_reset_at: null,
        baseline_results: [],
      });
      await new ScheduleEntryStore(baseDir, { warn: () => {} }).saveEntries([entry]);

      const report = await rebuildSoilFromRuntime({ baseDir, clock: fixedClock });
      const schedulePage = await readSoilMarkdownFile(path.join(baseDir, "soil", "schedule", "current.md"));
      const rebuilt = await rebuildSoilFromRuntime({ baseDir, clock: fixedClock });
      const schedulePageAfterRebuild = await readSoilMarkdownFile(path.join(baseDir, "soil", "schedule", "current.md"));
      const doctor = await SoilDoctor.create({ rootDir: path.join(baseDir, "soil") }).inspect();

      expect(report.projected.schedules).toBe(1);
      expect(rebuilt.pruned.map((item) => item.soilId)).not.toContain("schedule/current");
      expect(schedulePageAfterRebuild).not.toBeNull();
      expect(
        doctor.findings.filter(
          (finding) => finding.code === "missing-source-path" && finding.soilId?.startsWith("schedule/")
        )
      ).toHaveLength(0);
      expect(doctor.findings.filter((finding) => finding.code === "watermark-mismatch")).toHaveLength(0);
      expect(schedulePage?.frontmatter.summary).toBe("1/1 schedules enabled");
      expect(schedulePage?.frontmatter.source_truth).toBe("runtime_db");
      expect(schedulePage?.frontmatter.source_refs[0]?.source_type).toBe("control_db");
      expect(schedulePage?.frontmatter.source_refs[0]?.source_path).toBe("control-db:schedule_entries");
      expect(schedulePage?.body).toContain("control-db-schedule");
    } finally {
      cleanupTempDir(baseDir);
    }
  });

  it("does not rebuild stale domain or shared knowledge from Soil when typed truth is inactive", async () => {
    const baseDir = makeTempDir("soil-runtime-rebuild-inactive-truth-");
    try {
      const knowledgeMemoryStore = new KnowledgeMemoryStateStore(baseDir);
      const staleEntry = {
        entry_id: "stale-editor",
        question: "Which editor is current?",
        answer: "Atom",
        sources: [{ type: "document" as const, reference: "old-note", reliability: "high" as const }],
        confidence: 0.9,
        acquired_at: "2026-04-11T08:00:00.000Z",
        acquisition_task_id: "task-1",
        superseded_by: null,
        tags: ["editor"],
        embedding_id: null,
      };
      await knowledgeMemoryStore.saveDomainKnowledge({
        goal_id: "goal-1",
        domain: "goal-1",
        last_updated: "2026-04-11T09:00:00.000Z",
        entries: [staleEntry],
      });
      await knowledgeMemoryStore.saveSharedKnowledgeEntries([{
        ...staleEntry,
        source_goal_ids: ["goal-1"],
        domain_stability: "moderate",
        revalidation_due_at: null,
      }]);
      await rebuildSoilFromRuntime({ baseDir, clock: fixedClock });

      await saveDomainKnowledgeToTruth(baseDir, {
        goal_id: "goal-1",
        domain: "goal-1",
        last_updated: "2026-04-11T09:00:00.000Z",
        entries: [{ ...staleEntry, superseded_by: "replacement-editor" }],
      });
      await saveSharedKnowledgeToTruth(baseDir, [{
        ...staleEntry,
        superseded_by: "replacement-editor",
        source_goal_ids: ["goal-1"],
        domain_stability: "moderate",
        revalidation_due_at: null,
      }]);

      const rebuilt = await rebuildSoilFromRuntime({ baseDir, clock: fixedClock });
      const domainPage = await readSoilMarkdownFile(path.join(baseDir, "soil", "knowledge", "domain", "goal-1.md"));
      const sharedPage = await readSoilMarkdownFile(path.join(baseDir, "soil", "knowledge", "shared", "index.md"));
      const repo = await SqliteSoilRepository.openExisting({ rootDir: path.join(baseDir, "soil") });

      expect(rebuilt.projected.domainKnowledge).toBe(1);
      expect(rebuilt.projected.sharedKnowledge).toBe(0);
      expect(domainPage?.body).toContain("- Entries: 0");
      expect(domainPage?.body).not.toContain("Atom");
      expect(sharedPage?.body).toContain("- Entries: 0");
      expect(sharedPage?.body).not.toContain("Atom");
      expect(repo).not.toBeNull();
      try {
        const domainHits = await repo!.searchLexical({
          query: "Atom",
          limit: 5,
          record_filter: { source_types: ["knowledge_domain_entry"] },
        });
        const sharedHits = await repo!.searchLexical({
          query: "Atom",
          limit: 5,
          record_filter: { source_types: ["knowledge_shared_entry"] },
        });
        expect(domainHits.map((candidate) => candidate.record_id)).not.toContain("knowledge_domain_entry:goal-1:stale-editor");
        expect(sharedHits.map((candidate) => candidate.record_id)).not.toContain("knowledge_shared_entry:stale-editor");
      } finally {
        repo?.close();
      }
    } finally {
      cleanupTempDir(baseDir);
    }
  });

  it("rebuilds empty agent memory truth over stale Soil memory pages", async () => {
    const baseDir = makeTempDir("soil-runtime-rebuild-agent-empty-truth-");
    try {
      const knowledgeMemoryStore = new KnowledgeMemoryStateStore(baseDir);
      await knowledgeMemoryStore.saveAgentMemoryStore(AgentMemoryStoreSchema.parse({
        entries: [{
          id: "memory-stale-editor",
          key: "favorite-editor",
          value: "Atom",
          tags: ["editor"],
          memory_type: "preference",
          status: "compiled",
          created_at: "2026-04-11T08:00:00.000Z",
          updated_at: "2026-04-11T09:00:00.000Z",
        }],
        corrections: [],
        last_consolidated_at: "2026-04-11T09:30:00.000Z",
      }));
      await rebuildSoilFromRuntime({ baseDir, clock: fixedClock });
      const stalePage = await readSoilMarkdownFile(path.join(baseDir, "soil", "memory", "index.md"));
      expect(stalePage?.body).toContain("Atom");

      await saveAgentMemoryStoreToTruth(baseDir, AgentMemoryStoreSchema.parse({
        entries: [],
        corrections: [],
        last_consolidated_at: null,
      }));

      const rebuilt = await rebuildSoilFromRuntime({ baseDir, clock: fixedClock });
      const memoryPage = await readSoilMarkdownFile(path.join(baseDir, "soil", "memory", "index.md"));
      const repo = await SqliteSoilRepository.openExisting({ rootDir: path.join(baseDir, "soil") });

      expect(rebuilt.projected.agentMemory).toBe(0);
      expect(memoryPage?.body).toContain("- Entries: 0");
      expect(memoryPage?.body).not.toContain("Atom");
      expect(repo).not.toBeNull();
      try {
        const memoryHits = await repo!.searchLexical({
          query: "Atom",
          limit: 5,
          record_filter: { source_types: ["knowledge_agent_memory_entry"] },
        });
        expect(memoryHits.map((candidate) => candidate.record_id)).not.toContain("knowledge_agent_memory_entry:memory-stale-editor");
      } finally {
        repo?.close();
      }
    } finally {
      cleanupTempDir(baseDir);
    }
  });

  it("prunes generated runtime projections whose JSON source was deleted", async () => {
    const baseDir = makeTempDir("soil-runtime-prune-");
    try {
      const reportPath = path.join(baseDir, "reports", "goal-1", "report-1.json");
      const decisionPath = path.join(baseDir, "decisions", "goal-1-2026-04-11T09-00-00-000Z.json");
      await writeJsonFileAtomic(reportPath, {
        id: "report-1",
        report_type: "weekly_report",
        goal_id: "goal-1",
        title: "Weekly Report",
        content: "This report should disappear from the active Soil index.",
        verbosity: "standard",
        generated_at: "2026-04-11T09:00:00.000Z",
        delivered_at: null,
        read: false,
      });
      await writeJsonFileAtomic(decisionPath, {
        id: "d-1",
        goal_id: "goal-1",
        goal_type: "research",
        strategy_id: "s-1",
        decision: "temporary decision",
        context: { gap_value: 0.1, stall_count: 0, cycle_count: 1, trust_score: 1 },
        outcome: "pending",
        timestamp: "2026-04-11T09:00:00.000Z",
        what_worked: [],
        what_failed: [],
        suggested_next: [],
      });

      await rebuildSoilFromRuntime({ baseDir, clock: fixedClock });
      await fsp.unlink(reportPath);
      await fsp.unlink(decisionPath);

      const rebuilt = await rebuildSoilFromRuntime({ baseDir, clock: fixedClock });
      const reportPagePath = path.join(baseDir, "soil", "report", "weekly", "goal-1", "report-1.md");
      const decisionPage = await readSoilMarkdownFile(path.join(baseDir, "soil", "decision", "recent.md"));

      await expect(fsp.access(reportPagePath)).rejects.toThrow();
      expect(rebuilt.pruned.map((item) => item.soilId)).toContain("report/weekly/goal-1/report-1");
      expect(rebuilt.index.pages.map((page) => page.soil_id)).not.toContain("report/weekly/goal-1/report-1");
      expect(decisionPage?.body).toContain("- Records: 0");
      expect(rebuilt.index.pages.find((page) => page.soil_id === "decision/recent")?.summary).toBe("0 records");
    } finally {
      cleanupTempDir(baseDir);
    }
  });
});

describe("Soil importer", () => {
  it("detects manual overlay blocks and records approve/reject decisions", async () => {
    const rootDir = makeTempDir("soil-importer-");
    try {
      await SoilCompiler.create({ rootDir }, { clock: fixedClock }).write({
        frontmatter: SoilPageFrontmatterSchema.parse({
          soil_id: "memory/preferences",
          kind: "memory",
          status: "confirmed",
          title: "Preferences",
          route: "memory",
          source: "compiled",
          version: "1",
          created_at: "2026-04-11T09:00:00.000Z",
          updated_at: "2026-04-11T09:00:00.000Z",
          generated_at: "2026-04-11T09:00:00.000Z",
          source_refs: [],
          generation_watermark: {
            scope: "memory/preferences",
            source_paths: [],
            source_hashes: [],
            generated_at: "2026-04-11T09:00:00.000Z",
            projection_version: "soil-v1",
          },
          stale: false,
          manual_overlay: { enabled: false, status: "candidate" },
          import_status: "none",
          approval_status: "none",
          supersedes: [],
        }),
        body: [
          "# Preferences",
          "",
          "<!-- soil:overlay-begin -->",
          "- Prefer shorter reports.",
          "<!-- soil:overlay-end -->",
          "",
        ].join("\n"),
      });

      const queue = await scanAndStoreSoilOverlays({ rootDir }, { clock: fixedClock });
      expect(queue.overlays).toHaveLength(1);
      expect(queue.overlays[0]?.status).toBe("candidate");

      const approved = await updateSoilOverlayStatus(
        queue.overlays[0]!.overlay_id,
        "approved",
        { rootDir },
        { clock: fixedClock, decisionNote: "Safe preference candidate" }
      );
      expect(approved.overlays[0]?.status).toBe("approved");
      expect(approved.overlays[0]?.decision_note).toBe("Safe preference candidate");

      const loaded = await loadSoilOverlayQueue({ rootDir });
      expect(loaded.overlays[0]?.status).toBe("approved");
    } finally {
      cleanupTempDir(rootDir);
    }
  });
});
