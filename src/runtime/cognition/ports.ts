import type {
  CognitionMemoryRequest,
  CognitionMemoryResult,
  CompanionCognitionOutput,
  CognitionReplayRecord,
} from "./contracts.js";

export interface CognitionMemoryPort {
  retrieveMemory(request: CognitionMemoryRequest): Promise<CognitionMemoryResult>;
}

export interface CognitionAuditSink {
  recordCognition(record: CognitionReplayRecord): Promise<void>;
}

export interface CognitionWritebackPort {
  proposeWriteback(output: CompanionCognitionOutput): Promise<void>;
}
