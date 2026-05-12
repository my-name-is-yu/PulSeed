import type { TraceEvent, TraceSurface } from "./types.js";

export class EventRecorder {
  private readonly recorded: TraceEvent[] = [];

  record(event: TraceEvent): void {
    this.recorded.push(structuredClone(event));
  }

  events(): TraceEvent[] {
    return this.recorded.map((event) => structuredClone(event));
  }

  surface(): TraceSurface {
    return {
      visible_events: this.recorded
        .filter((event) => event.visible === true)
        .map((event) => structuredClone(event)),
    };
  }
}
