import { z } from "zod";

const PositiveSafeIntegerSchema = z.number().finite().int().safe().positive();
const NonNegativeSafeIntegerSchema = z.number().finite().int().safe().min(0);
const WarningThresholdSchema = z.number().finite().min(0).max(1);

export const IterationBudgetSchema = z.object({
  total: PositiveSafeIntegerSchema,
  consumed: NonNegativeSafeIntegerSchema,
  per_node_limit: PositiveSafeIntegerSchema.optional(),
  warning_thresholds: z.array(WarningThresholdSchema).default([0.7, 0.9]),
}).superRefine((budget, ctx) => {
  if (budget.consumed > budget.total) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["consumed"],
      message: "consumed iteration budget cannot exceed total",
    });
  }
});
export type IterationBudgetData = z.infer<typeof IterationBudgetSchema>;

const IterationBudgetConstructorSchema = z.object({
  total: PositiveSafeIntegerSchema,
  per_node_limit: PositiveSafeIntegerSchema.optional(),
});

export class IterationBudget {
  private _total: number;
  private _consumed: number;
  private _perNodeLimit: number | undefined;
  private _warningThresholds: number[];
  private _emittedWarnings: Set<number> = new Set();

  constructor(total: number, perNodeLimit?: number) {
    const parsed = IterationBudgetConstructorSchema.parse({ total, per_node_limit: perNodeLimit });
    this._total = parsed.total;
    this._consumed = 0;
    this._perNodeLimit = parsed.per_node_limit;
    this._warningThresholds = [0.7, 0.9];
  }

  get total(): number { return this._total; }
  get consumed(): number { return this._consumed; }
  get remaining(): number { return this._total - this._consumed; }
  get perNodeLimit(): number | undefined { return this._perNodeLimit; }
  get exhausted(): boolean { return this._consumed >= this._total; }
  get utilizationRatio(): number { return this._consumed / this._total; }

  consume(count: number = 1): { allowed: boolean; warnings: string[] } {
    const parsedCount = PositiveSafeIntegerSchema.parse(count);
    const warnings: string[] = [];
    if (parsedCount > this.remaining) {
      return { allowed: false, warnings: [`Budget exhausted: ${this._consumed}/${this._total} iterations consumed`] };
    }
    this._consumed += parsedCount;
    if (this._emittedWarnings.size < this._warningThresholds.length) {
      for (const threshold of this._warningThresholds) {
        if (this.utilizationRatio >= threshold && !this._emittedWarnings.has(threshold)) {
          this._emittedWarnings.add(threshold);
          warnings.push(`Budget warning: ${Math.round(this.utilizationRatio * 100)}% consumed (${this._consumed}/${this._total})`);
        }
      }
    }
    return { allowed: true, warnings };
  }

  toJSON(): IterationBudgetData {
    return {
      total: this._total,
      consumed: this._consumed,
      per_node_limit: this._perNodeLimit,
      warning_thresholds: this._warningThresholds,
    };
  }

  static fromJSON(data: IterationBudgetData): IterationBudget {
    const parsed = IterationBudgetSchema.parse(data);
    const budget = new IterationBudget(parsed.total, parsed.per_node_limit);
    budget._consumed = parsed.consumed;
    budget._warningThresholds = parsed.warning_thresholds;
    return budget;
  }
}
