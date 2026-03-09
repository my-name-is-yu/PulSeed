import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  existsSync,
  appendFileSync,
  renameSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { MotiveState, Goal } from './models.js';

export class StateManager {
  readonly projectRoot: string;
  readonly motiveDir: string;
  readonly goalsDir: string;
  readonly statePath: string;
  readonly logPath: string;
  readonly configPath: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
    this.motiveDir = join(projectRoot, '.motive');
    this.goalsDir = join(this.motiveDir, 'goals');
    this.statePath = join(this.motiveDir, 'state.json');
    this.logPath = join(this.motiveDir, 'log.jsonl');
    this.configPath = join(this.motiveDir, 'config.yaml');
  }

  init(): MotiveState {
    mkdirSync(this.goalsDir, { recursive: true });
    if (!existsSync(this.statePath)) {
      const state = MotiveState.parse({});
      this.atomicWrite(this.statePath, JSON.stringify(state, null, 2));
      return state;
    }
    return this.loadState();
  }

  loadState(): MotiveState {
    if (!existsSync(this.statePath)) {
      return MotiveState.parse({});
    }
    const data = readFileSync(this.statePath, 'utf-8');
    return MotiveState.parse(JSON.parse(data));
  }

  saveState(state: MotiveState): void {
    state.last_updated = new Date().toISOString();
    this.atomicWrite(this.statePath, JSON.stringify(state, null, 2));
  }

  loadGoal(goalId: string): Goal | null {
    const path = join(this.goalsDir, `${goalId}.json`);
    if (!existsSync(path)) return null;
    return Goal.parse(JSON.parse(readFileSync(path, 'utf-8')));
  }

  saveGoal(goal: Goal): void {
    const path = join(this.goalsDir, `${goal.id}.json`);
    this.atomicWrite(path, JSON.stringify(goal, null, 2));
  }

  listGoals(): Goal[] {
    if (!existsSync(this.goalsDir)) return [];
    return readdirSync(this.goalsDir)
      .filter(f => f.endsWith('.json'))
      .sort()
      .map(f => Goal.parse(JSON.parse(readFileSync(join(this.goalsDir, f), 'utf-8'))));
  }

  loadActiveGoals(): Goal[] {
    const state = this.loadState();
    return state.active_goal_ids
      .map(id => this.loadGoal(id))
      .filter((g): g is Goal => g !== null);
  }

  addGoal(goal: Goal): void {
    this.saveGoal(goal);
    const state = this.loadState();
    if (!state.active_goal_ids.includes(goal.id)) {
      state.active_goal_ids.push(goal.id);
    }
    this.saveState(state);
  }

  removeGoal(goalId: string): void {
    const state = this.loadState();
    state.active_goal_ids = state.active_goal_ids.filter(id => id !== goalId);
    this.saveState(state);
    const path = join(this.goalsDir, `${goalId}.json`);
    if (existsSync(path)) unlinkSync(path);
  }

  appendLog(entry: Record<string, unknown>): void {
    mkdirSync(dirname(this.logPath), { recursive: true });
    appendFileSync(this.logPath, JSON.stringify(entry) + '\n');
  }

  private atomicWrite(filePath: string, content: string): void {
    mkdirSync(dirname(filePath), { recursive: true });
    const tmpPath = `${filePath}.${randomUUID().slice(0, 8)}.tmp`;
    try {
      writeFileSync(tmpPath, content, 'utf-8');
      renameSync(tmpPath, filePath);
    } catch (err) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // ignore cleanup error
      }
      throw err;
    }
  }
}
