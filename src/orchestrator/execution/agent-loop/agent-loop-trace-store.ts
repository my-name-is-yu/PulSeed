import type { AgentLoopEvent } from "./agent-loop-events.js";
import { redactSetupSecretsDeep } from "../../../interface/chat/setup-secret-intake.js";

export interface AgentLoopTraceStore {
  append(event: AgentLoopEvent): Promise<void>;
  list(traceId?: string): Promise<AgentLoopEvent[]>;
}

export class InMemoryAgentLoopTraceStore implements AgentLoopTraceStore {
  private readonly events: AgentLoopEvent[] = [];

  async append(event: AgentLoopEvent): Promise<void> {
    this.events.push(redactSetupSecretsDeep(event));
  }

  async list(traceId?: string): Promise<AgentLoopEvent[]> {
    return traceId
      ? this.events.filter((event) => event.traceId === traceId)
      : [...this.events];
  }
}
