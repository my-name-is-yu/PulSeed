import { createHash } from "node:crypto";

export class SeededIdFactory {
  private counter = 0;

  constructor(private readonly seed: string) {}

  next(prefix: string): string {
    this.counter += 1;
    const digest = createHash("sha256")
      .update(`${this.seed}:${prefix}:${this.counter}`)
      .digest("hex")
      .slice(0, 12);
    return `${prefix}:${digest}`;
  }
}
