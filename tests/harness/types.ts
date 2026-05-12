export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface TraceEvent {
  type: string;
  at?: string;
  source?: string;
  visible?: boolean;
  payload?: JsonObject;
}

export interface TraceSurface {
  visible_events: TraceEvent[];
  final?: JsonObject;
  approvals?: JsonObject[];
}

export interface TraceArtifactTreeEntry {
  path: string;
  type: "file" | "directory";
  size?: number;
  sha256?: string;
}

export interface NormalizerSpec {
  root?: string;
  timestamp?: string;
  ids?: Record<string, string>;
}

export interface ScriptedLlmTurn {
  request_phase: string;
  expected_messages?: JsonObject[];
  response: JsonObject;
}

export interface ScriptedToolStep {
  name: string;
  args?: JsonObject;
  approval_required?: boolean;
  approved?: boolean;
  result: JsonObject;
  side_effect_artifact?: JsonObject;
}

export interface GoldenTraceFixture {
  schema_version: "pulseed.golden-trace.v1";
  contract_name: string;
  domain: string;
  p0_failure_mode: string;
  production_boundary: string;
  input: {
    entrypoint: string;
    fake_now: string;
    seed: string;
    allow_network?: boolean;
    allow_real_llm?: boolean;
    steps: TraceEvent[];
  };
  llm_script?: ScriptedLlmTurn[];
  tool_script?: ScriptedToolStep[];
  initial_state?: JsonObject;
  expected: {
    events: TraceEvent[];
    surface: TraceSurface;
    control_db_export: JsonObject;
    artifact_tree: TraceArtifactTreeEntry[];
    stdout?: string;
    stderr?: string;
  };
  normalizers?: NormalizerSpec;
}

export interface ReplayFixture {
  schema_version: "pulseed.replay.v1";
  contract_name: string;
  domain: string;
  p0_failure_mode: string;
  production_boundary: string;
  input: {
    entrypoint: string;
    fake_now: string;
    seed: string;
    allow_network?: boolean;
    allow_real_llm?: boolean;
  };
  initial_state: JsonObject;
  expected: {
    fresh_state: JsonObject;
    restarted_state: JsonObject;
    audit: JsonObject[];
    artifact_tree: TraceArtifactTreeEntry[];
  };
  normalizers?: NormalizerSpec;
}
