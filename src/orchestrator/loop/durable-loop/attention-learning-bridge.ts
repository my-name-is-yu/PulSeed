export interface AttentionLearningBridgePort {
  loadAttentionSignalsForIteration(input: {
    goalId: string;
    runId?: string;
    loopIndex?: number;
    runtimeEvidenceRefs: string[];
  }): Promise<{
    attentionRefs: string[];
    salienceBoosts: Array<{
      reason: string;
      evidenceRef: string;
      strength: number;
    }>;
  }>;
}

export class NoopAttentionLearningBridge implements AttentionLearningBridgePort {
  async loadAttentionSignalsForIteration(): Promise<{
    attentionRefs: string[];
    salienceBoosts: Array<{ reason: string; evidenceRef: string; strength: number }>;
  }> {
    return { attentionRefs: [], salienceBoosts: [] };
  }
}
