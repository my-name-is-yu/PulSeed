export interface CheckpointTrustPort {
  setOverride(domain: string, balance: number, reason: string): Promise<void>;
}
