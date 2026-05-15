import { beforeEach, describe, expect, it, vi } from "vitest";
import { GetScheduleTool } from "../GetScheduleTool/GetScheduleTool.js";
import type { ScheduleEntry } from "../../../runtime/types/schedule.js";
import type { ScheduleEngine } from "../../../runtime/schedule-engine.js";
import { makeToolCallContext } from "../../../../tests/helpers/tool-call-context.js";
import { makeScheduleEntry } from "../../../../tests/helpers/schedule-fixtures.js";

const makeContext = makeToolCallContext;
const makeEntry = makeScheduleEntry;

describe("GetScheduleTool", () => {
  let scheduleEngine: ScheduleEngine;
  let tool: GetScheduleTool;

  beforeEach(() => {
    scheduleEngine = {
      getEntries: vi.fn().mockReturnValue([]),
    } as unknown as ScheduleEngine;
    tool = new GetScheduleTool(scheduleEngine);
  });

  it("returns metadata with schedule tags", () => {
    expect(tool.metadata.name).toBe("get_schedule");
    expect(tool.metadata.tags).toContain("schedule");
    expect(tool.metadata.isReadOnly).toBe(true);
  });

  it("description returns non-empty string", () => {
    expect(tool.description()).toContain("schedule");
  });

  it("checkPermissions returns allowed", async () => {
    const result = await tool.checkPermissions({ schedule_id: "abc" }, makeContext());
    expect(result.status).toBe("allowed");
  });

  it("isConcurrencySafe returns true", () => {
    expect(tool.isConcurrencySafe({ schedule_id: "abc" })).toBe(true);
  });

  it("returns the full entry for an exact id match", async () => {
    vi.mocked(scheduleEngine.getEntries).mockReturnValue([
      makeEntry("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", {
        layer: "cron",
        trigger: { type: "cron", expression: "0 * * * *", timezone: "UTC" },
        cron: {
          job_kind: "prompt",
          prompt_template: "Summarize status",
          context_sources: ["notes"],
          output_format: "report",
          max_tokens: 2000,
        },
        heartbeat: undefined,
      }),
    ]);

    const result = await tool.call(
      { schedule_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" },
      makeContext(),
    );

    expect(result.success).toBe(true);
    const data = result.data as { entry: ScheduleEntry };
    expect(data.entry.id).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(data.entry.layer).toBe("cron");
  });

  it("resolves a unique id prefix", async () => {
    vi.mocked(scheduleEngine.getEntries).mockReturnValue([
      makeEntry("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
      makeEntry("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
    ]);

    const result = await tool.call({ schedule_id: "bbbbbbbb" }, makeContext());

    expect(result.success).toBe(true);
    const data = result.data as { entry: ScheduleEntry };
    expect(data.entry.id).toBe("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  });

  it("returns failure when the schedule is missing", async () => {
    vi.mocked(scheduleEngine.getEntries).mockReturnValue([
      makeEntry("dddddddd-dddd-4ddd-8ddd-dddddddddddd"),
    ]);

    const result = await tool.call({ schedule_id: "missing" }, makeContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain("missing");
  });

  it("returns failure when the schedule id prefix is ambiguous", async () => {
    vi.mocked(scheduleEngine.getEntries).mockReturnValue([
      makeEntry("eeee0000-0000-4000-8000-000000000000"),
      makeEntry("eeee1111-1111-4111-8111-111111111111"),
    ]);

    const result = await tool.call({ schedule_id: "eeee" }, makeContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain("ambiguous");
  });

  it("handles schedule engine errors gracefully", async () => {
    vi.mocked(scheduleEngine.getEntries).mockImplementation(() => {
      throw new Error("engine unavailable");
    });

    const result = await tool.call({ schedule_id: "abc" }, makeContext());

    expect(result.success).toBe(false);
    expect(result.error).toContain("engine unavailable");
  });
});
