export interface ShutdownMarker {
  goal_ids: string[];
  loop_index: number;
  timestamp: string;
  reason: "signal" | "stop" | "max_retries" | "startup";
  state: "running" | "clean_shutdown";
}
