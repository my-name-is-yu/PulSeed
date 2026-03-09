import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { StateManager } from '../state/manager.js';
import { GapAnalysisEngine } from '../engines/gap-analysis.js';

export class ContextInjector {
  private static readonly MAX_CHARS = 2000; // ~500 tokens
  private manager: StateManager;
  private gapEngine: GapAnalysisEngine;
  readonly outputPath: string;

  constructor(manager: StateManager) {
    this.manager = manager;
    this.gapEngine = new GapAnalysisEngine();
    this.outputPath = join(manager.projectRoot, '.claude', 'rules', 'motive.md');
  }

  generate(): string {
    const state = this.manager.loadState();
    const goals = this.manager.loadActiveGoals();

    if (goals.length === 0) {
      return '# Motive Context\n\nNo active goals. Awaiting user direction.\n';
    }

    const lines: string[] = ['# Motive Context\n'];
    lines.push(`Trust: ${state.trust_balance.global.toFixed(2)}\n`);

    const sorted = [...goals].sort((a, b) => b.motivation_score - a.motivation_score);
    for (const goal of sorted) {
      const gaps = this.gapEngine.computeGaps(goal);
      const topGaps = gaps.filter(g => g.magnitude > 0.05).slice(0, 3);

      lines.push(`## ${goal.title} (score: ${goal.motivation_score.toFixed(2)})`);
      if (goal.deadline) {
        lines.push(`Deadline: ${goal.deadline}`);
      }
      if (topGaps.length > 0) {
        lines.push('Gaps:');
        for (const g of topGaps) {
          const magPct = (g.magnitude * 100).toFixed(0);
          const confPct = (g.confidence * 100).toFixed(0);
          lines.push(`  - ${g.dimension}: ${g.current.toFixed(1)}/${g.target.toFixed(1)} (gap: ${magPct}%, conf: ${confPct}%)`);
        }
      }
      lines.push('');
    }

    let content = lines.join('\n');
    if (content.length > ContextInjector.MAX_CHARS) {
      content = content.slice(0, ContextInjector.MAX_CHARS) + '\n...(truncated)\n';
    }
    return content;
  }

  write(): string {
    const content = this.generate();
    mkdirSync(dirname(this.outputPath), { recursive: true });
    writeFileSync(this.outputPath, content);
    return this.outputPath;
  }
}
