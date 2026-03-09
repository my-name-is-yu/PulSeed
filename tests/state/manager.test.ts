import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateManager } from '../../src/state/manager.js';
import { Goal, MotiveState } from '../../src/state/models.js';

function makeGoal(overrides: Partial<{ title: string; id: string }> = {}): Goal {
  return Goal.parse({ title: 'Test Goal', ...overrides });
}

let tmpDir: string;
let manager: StateManager;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'motive-test-'));
  manager = new StateManager(tmpDir);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('StateManager.init', () => {
  it('creates .motive/ directory and state.json', () => {
    manager.init();
    expect(existsSync(manager.motiveDir)).toBe(true);
    expect(existsSync(manager.goalsDir)).toBe(true);
    expect(existsSync(manager.statePath)).toBe(true);
  });

  it('returns a valid MotiveState', () => {
    const state = manager.init();
    expect(state.version).toBe('1.0.0');
    expect(state.trust_balance.global).toBe(0.7);
    expect(Array.isArray(state.active_goal_ids)).toBe(true);
  });

  it('is idempotent: calling init twice preserves state', () => {
    const first = manager.init();
    const second = manager.init();
    // session_id must be the same on second call (state already exists)
    expect(second.session_id).toBe(first.session_id);
  });
});

describe('StateManager save/load state roundtrip', () => {
  it('saves and reloads state with same values', () => {
    const state = manager.init();
    state.active_goal_ids.push('goal-abc');
    state.trust_balance.global = 0.85;
    manager.saveState(state);

    const loaded = manager.loadState();
    expect(loaded.active_goal_ids).toContain('goal-abc');
    expect(loaded.trust_balance.global).toBe(0.85);
    expect(loaded.session_id).toBe(state.session_id);
  });

  it('loadState returns default MotiveState when file does not exist', () => {
    // no init called — state.json does not exist
    const state = manager.loadState();
    expect(state.trust_balance.global).toBe(0.7);
  });

  it('saveState writes a valid ISO timestamp to last_updated', () => {
    const state = manager.init();
    // Force a known past timestamp so saveState must overwrite it
    state.last_updated = '1970-01-01T00:00:00.000Z';
    manager.saveState(state);
    const loaded = manager.loadState();
    expect(loaded.last_updated).not.toBe('1970-01-01T00:00:00.000Z');
    expect(() => new Date(loaded.last_updated)).not.toThrow();
    expect(isNaN(new Date(loaded.last_updated).getTime())).toBe(false);
  });
});

describe('StateManager goal operations', () => {
  beforeEach(() => {
    manager.init();
  });

  it('addGoal saves goal file and adds id to active_goal_ids', () => {
    const goal = makeGoal({ title: 'My Goal' });
    manager.addGoal(goal);

    const goalFile = join(manager.goalsDir, `${goal.id}.json`);
    expect(existsSync(goalFile)).toBe(true);

    const state = manager.loadState();
    expect(state.active_goal_ids).toContain(goal.id);
  });

  it('addGoal does not duplicate active_goal_ids on repeated calls', () => {
    const goal = makeGoal();
    manager.addGoal(goal);
    manager.addGoal(goal);

    const state = manager.loadState();
    const occurrences = state.active_goal_ids.filter(id => id === goal.id);
    expect(occurrences.length).toBe(1);
  });

  it('listGoals returns all saved goals', () => {
    const g1 = makeGoal({ title: 'G1' });
    const g2 = makeGoal({ title: 'G2' });
    manager.addGoal(g1);
    manager.addGoal(g2);

    const goals = manager.listGoals();
    const ids = goals.map(g => g.id);
    expect(ids).toContain(g1.id);
    expect(ids).toContain(g2.id);
  });

  it('listGoals returns empty array when no goals exist', () => {
    expect(manager.listGoals()).toEqual([]);
  });

  it('loadGoal returns null for unknown id', () => {
    expect(manager.loadGoal('nonexistent-goal')).toBeNull();
  });

  it('loadGoal returns goal for known id', () => {
    const goal = makeGoal({ title: 'Known Goal' });
    manager.addGoal(goal);
    const loaded = manager.loadGoal(goal.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.title).toBe('Known Goal');
  });

  it('removeGoal removes file and strips id from active_goal_ids', () => {
    const goal = makeGoal();
    manager.addGoal(goal);
    manager.removeGoal(goal.id);

    expect(existsSync(join(manager.goalsDir, `${goal.id}.json`))).toBe(false);
    const state = manager.loadState();
    expect(state.active_goal_ids).not.toContain(goal.id);
  });

  it('loadActiveGoals returns only goals listed in active_goal_ids', () => {
    const g1 = makeGoal({ title: 'Active' });
    const g2 = makeGoal({ title: 'Inactive' });
    manager.addGoal(g1);
    manager.addGoal(g2);
    // Manually remove g2 from active list without deleting file
    const state = manager.loadState();
    state.active_goal_ids = state.active_goal_ids.filter(id => id !== g2.id);
    manager.saveState(state);
    // Keep g2 file on disk by saving it directly
    manager.saveGoal(g2);

    const active = manager.loadActiveGoals();
    const ids = active.map(g => g.id);
    expect(ids).toContain(g1.id);
    expect(ids).not.toContain(g2.id);
  });
});

describe('StateManager.appendLog', () => {
  it('creates log.jsonl and appends valid JSON lines', () => {
    manager.appendLog({ event: 'test', value: 42 });
    manager.appendLog({ event: 'second', value: 99 });

    expect(existsSync(manager.logPath)).toBe(true);
    const lines = readFileSync(manager.logPath, 'utf-8').trim().split('\n');
    expect(lines.length).toBe(2);
    const first = JSON.parse(lines[0]);
    expect(first.event).toBe('test');
    expect(first.value).toBe(42);
    const second = JSON.parse(lines[1]);
    expect(second.event).toBe('second');
  });
});

describe('StateManager atomicWrite', () => {
  it('leaves no .tmp files after successful write', () => {
    manager.init();
    const state = manager.loadState();
    manager.saveState(state);

    const tmpFiles = readdirSync(manager.motiveDir).filter(f => f.endsWith('.tmp'));
    expect(tmpFiles.length).toBe(0);
  });

  it('written file is readable and valid JSON', () => {
    manager.init();
    const raw = readFileSync(manager.statePath, 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});
