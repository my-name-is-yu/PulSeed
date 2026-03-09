#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { StateManager } from './state/manager.js';
import { Goal, MotiveState } from './state/models.js';

const program = new Command();

function getManager(project?: string): StateManager {
  return new StateManager(project ? resolve(project) : process.cwd());
}

program
  .name('motive')
  .description('Motive Layer CLI — motivation framework for AI agents')
  .option('-p, --project <path>', 'Project root directory');

program
  .command('init')
  .description('Initialize .motive/ directory with default state')
  .action(() => {
    const mgr = getManager(program.opts().project);
    const state = mgr.init();
    console.log(`Initialized .motive/ in ${mgr.projectRoot}`);
    console.log(`Session: ${state.session_id}`);
  });

program
  .command('status')
  .description('Show current motive state summary')
  .action(() => {
    const mgr = getManager(program.opts().project);
    const state = mgr.loadState();
    const goals = mgr.loadActiveGoals();
    console.log(`Session: ${state.session_id}`);
    console.log(`Trust: ${state.trust_balance.global.toFixed(2)}`);
    console.log(`Active goals: ${goals.length}`);
    for (const g of goals) {
      console.log(`  [${g.id}] ${g.title} (score: ${g.motivation_score.toFixed(2)}, status: ${g.status})`);
    }
  });

program
  .command('goals')
  .description('List all goals')
  .action(() => {
    const mgr = getManager(program.opts().project);
    const allGoals = mgr.listGoals();
    if (allGoals.length === 0) {
      console.log('No goals defined.');
      return;
    }
    const icons: Record<string, string> = { active: '●', completed: '✓', paused: '⏸', abandoned: '✗' };
    for (const g of allGoals) {
      console.log(`  ${icons[g.status] ?? '?'} [${g.id}] ${g.title} (${g.type})`);
    }
  });

program
  .command('add-goal')
  .description('Add a new goal')
  .requiredOption('-t, --title <title>', 'Goal title')
  .option('-d, --description <desc>', 'Goal description', '')
  .option('--type <type>', 'Motivation type (deadline|dissatisfaction|opportunity)', 'dissatisfaction')
  .action((opts) => {
    const mgr = getManager(program.opts().project);
    const goal = Goal.parse({
      title: opts.title,
      description: opts.description,
      type: opts.type,
      state_vector: {
        progress: { value: 0.0, confidence: 0.5 },
      },
    });
    mgr.addGoal(goal);
    console.log(`Added goal: ${goal.id} — ${goal.title}`);
  });

program
  .command('log')
  .description('Show recent action log entries')
  .action(() => {
    const mgr = getManager(program.opts().project);
    try {
      const content = readFileSync(mgr.logPath, 'utf-8').trim();
      if (!content) { console.log('No log entries.'); return; }
      const lines = content.split('\n');
      for (const line of lines.slice(-10)) {
        const entry = JSON.parse(line);
        console.log(`  [${entry.timestamp ?? '?'}] ${entry.action?.tool ?? '?'} → ${entry.outcome ?? '?'}`);
      }
    } catch {
      console.log('No log entries.');
    }
  });

program
  .command('reset')
  .description('Reset motive state (keeps goals)')
  .action(() => {
    const mgr = getManager(program.opts().project);
    const current = mgr.loadState();
    const fresh = MotiveState.parse({
      ...current,
      session_id: crypto.randomUUID(),
      last_updated: new Date().toISOString(),
    });
    mgr.saveState(fresh);
    console.log('State reset.');
  });

program
  .command('gc')
  .description('Garbage collect old log entries')
  .option('--days <n>', 'Keep logs newer than N days', '30')
  .action((opts) => {
    const mgr = getManager(program.opts().project);
    try {
      const content = readFileSync(mgr.logPath, 'utf-8').trim();
      if (!content) { console.log('No logs to clean.'); return; }
      const lines = content.split('\n');
      const cutoff = new Date(Date.now() - parseInt(opts.days) * 86400000);
      const kept = lines.filter(line => {
        try {
          const entry = JSON.parse(line);
          return new Date(entry.timestamp ?? '2000-01-01') > cutoff;
        } catch { return false; }
      });
      writeFileSync(mgr.logPath, kept.length ? kept.join('\n') + '\n' : '');
      console.log(`Removed ${lines.length - kept.length} old entries, kept ${kept.length}.`);
    } catch {
      console.log('No logs to clean.');
    }
  });

program.parse();
