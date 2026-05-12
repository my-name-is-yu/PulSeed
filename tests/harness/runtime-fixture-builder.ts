import type { GoldenTraceFixture, JsonObject, TraceEvent } from "./types.js";

export class RuntimeFixtureBuilder {
  private readonly events: TraceEvent[] = [];
  private controlDbExport: JsonObject = {};
  private artifactTree: GoldenTraceFixture["expected"]["artifact_tree"] = [];
  private surfaceFinal: JsonObject | undefined;

  constructor(
    private readonly contractName: string,
    private readonly domain: string,
    private readonly p0FailureMode: string,
    private readonly productionBoundary: string,
  ) {}

  event(event: TraceEvent): this {
    this.events.push(event);
    return this;
  }

  final(value: JsonObject): this {
    this.surfaceFinal = value;
    return this;
  }

  controlDb(value: JsonObject): this {
    this.controlDbExport = value;
    return this;
  }

  artifacts(entries: GoldenTraceFixture["expected"]["artifact_tree"]): this {
    this.artifactTree = entries;
    return this;
  }

  build(): GoldenTraceFixture {
    return {
      schema_version: "pulseed.golden-trace.v1",
      contract_name: this.contractName,
      domain: this.domain,
      p0_failure_mode: this.p0FailureMode,
      production_boundary: this.productionBoundary,
      input: {
        entrypoint: this.productionBoundary,
        fake_now: "2026-05-13T00:00:00.000Z",
        seed: this.contractName,
        steps: this.events,
      },
      expected: {
        events: this.events,
        surface: {
          visible_events: this.events.filter((event) => event.visible === true),
          final: this.surfaceFinal,
        },
        control_db_export: this.controlDbExport,
        artifact_tree: this.artifactTree,
        stdout: "",
        stderr: "",
      },
    };
  }
}
