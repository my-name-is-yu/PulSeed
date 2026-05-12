export class HarnessClock {
  private currentMs: number;

  constructor(startIso: string) {
    const parsed = Date.parse(startIso);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Invalid harness clock timestamp: ${startIso}`);
    }
    this.currentMs = parsed;
  }

  nowMs(): number {
    return this.currentMs;
  }

  nowIso(): string {
    return new Date(this.currentMs).toISOString();
  }

  date(): Date {
    return new Date(this.currentMs);
  }

  set(iso: string): void {
    const parsed = Date.parse(iso);
    if (!Number.isFinite(parsed)) {
      throw new Error(`Invalid harness clock timestamp: ${iso}`);
    }
    this.currentMs = parsed;
  }

  advance(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) {
      throw new Error(`Clock advance must be a non-negative finite number: ${ms}`);
    }
    this.currentMs += ms;
    return this.nowIso();
  }
}
