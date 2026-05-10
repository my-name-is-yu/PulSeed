import * as fs from "node:fs";
import {
  CuriosityProposalSchema,
  CuriosityStateSchema,
  LearningRecordSchema,
  type CuriosityProposal,
  type CuriosityState,
  type LearningRecord,
} from "../../base/types/curiosity.js";
import {
  openControlDatabase,
  openControlDatabaseSync,
  resolveControlDbPath,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
  type SqliteDatabase,
} from "./control-db/index.js";

export interface CuriosityStateStoreOptions extends RuntimeControlDbStoreOptions {}

export interface CuriosityStateStorePort {
  load(): Promise<CuriosityState | null>;
  saveSync(state: CuriosityState): CuriosityState;
}

interface CuriosityStateMetadataRow {
  state_json: string;
}

interface CuriosityProposalRow {
  proposal_json: string;
}

interface CuriosityLearningRow {
  record_json: string;
}

interface CuriosityRejectedHashRow {
  proposal_hash: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

export class CuriosityStateStore implements CuriosityStateStorePort {
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    private readonly baseDir: string,
    private readonly options: CuriosityStateStoreOptions = {},
  ) {}

  async load(): Promise<CuriosityState | null> {
    if (!this.options.controlDb && !fs.existsSync(resolveControlDbPath({
      baseDir: this.options.controlBaseDir ?? this.baseDir,
      dbPath: this.options.controlDbPath,
    }))) {
      return null;
    }
    const db = await this.database();
    return db.read((sqlite) => readCuriosityState(sqlite));
  }

  saveSync(state: CuriosityState): CuriosityState {
    const parsed = CuriosityStateSchema.parse(state);
    const db = this.options.controlDb ?? openControlDatabaseSync({
      baseDir: this.options.controlBaseDir ?? this.baseDir,
      dbPath: this.options.controlDbPath,
    });
    try {
      db.transaction((sqlite) => replaceCuriosityState(sqlite, parsed));
    } finally {
      if (!this.options.controlDb) {
        db.close();
      }
    }
    return parsed;
  }

  async save(state: CuriosityState): Promise<CuriosityState> {
    const parsed = CuriosityStateSchema.parse(state);
    const db = await this.database();
    db.transaction((sqlite) => replaceCuriosityState(sqlite, parsed));
    return parsed;
  }

  private async database(): Promise<ControlDatabase> {
    if (this.options.controlDb) {
      return this.options.controlDb;
    }
    this.dbPromise ??= openControlDatabase({
      baseDir: this.options.controlBaseDir ?? this.baseDir,
      dbPath: this.options.controlDbPath,
    });
    return this.dbPromise;
  }
}

function readCuriosityState(sqlite: SqliteDatabase): CuriosityState | null {
  const metadata = sqlite.prepare(`
    SELECT state_json
    FROM curiosity_state_metadata
    WHERE state_id = 'current'
  `).get() as CuriosityStateMetadataRow | undefined;

  if (!metadata) {
    return null;
  }

  const proposals = sqlite.prepare(`
    SELECT proposal_json
    FROM curiosity_proposals
    ORDER BY sort_order ASC, created_at ASC, proposal_id ASC
  `).all() as CuriosityProposalRow[];

  const learningRecords = sqlite.prepare(`
    SELECT record_json
    FROM curiosity_learning_records
    ORDER BY sort_order ASC, recorded_at ASC, record_sequence ASC
  `).all() as CuriosityLearningRow[];

  const rejectedHashes = sqlite.prepare(`
    SELECT proposal_hash
    FROM curiosity_rejected_proposal_hashes
    ORDER BY sort_order ASC, proposal_hash ASC
  `).all() as CuriosityRejectedHashRow[];

  const metadataState = CuriosityStateSchema.parse(parseJson<unknown>(metadata.state_json));
  return CuriosityStateSchema.parse({
    proposals: proposals.map((row) => CuriosityProposalSchema.parse(parseJson<CuriosityProposal>(row.proposal_json))),
    learning_records: learningRecords.map((row) => LearningRecordSchema.parse(parseJson<LearningRecord>(row.record_json))),
    last_exploration_at: metadataState.last_exploration_at,
    rejected_proposal_hashes: rejectedHashes.map((row) => row.proposal_hash),
  });
}

function replaceCuriosityState(sqlite: SqliteDatabase, state: CuriosityState): void {
  const updatedAt = nowIso();

  sqlite.prepare("DELETE FROM curiosity_proposals").run();
  sqlite.prepare("DELETE FROM curiosity_learning_records").run();
  sqlite.prepare("DELETE FROM curiosity_rejected_proposal_hashes").run();

  sqlite.prepare(`
    INSERT INTO curiosity_state_metadata (
      state_id,
      last_exploration_at,
      updated_at,
      state_json
    )
    VALUES ('current', ?, ?, json(?))
    ON CONFLICT(state_id) DO UPDATE SET
      last_exploration_at = excluded.last_exploration_at,
      updated_at = excluded.updated_at,
      state_json = excluded.state_json
  `).run(state.last_exploration_at, updatedAt, stringifyJson(state));

  const insertProposal = sqlite.prepare(`
    INSERT INTO curiosity_proposals (
      proposal_id,
      status,
      goal_id,
      created_at,
      expires_at,
      reviewed_at,
      rejection_cooldown_until,
      loop_count,
      trigger_type,
      trigger_source_goal_id,
      sort_order,
      updated_at,
      proposal_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, json(?))
  `);
  state.proposals.forEach((proposal, index) => {
    insertProposal.run(
      proposal.id,
      proposal.status,
      proposal.goal_id,
      proposal.created_at,
      proposal.expires_at,
      proposal.reviewed_at,
      proposal.rejection_cooldown_until,
      proposal.loop_count,
      proposal.trigger.type,
      proposal.trigger.source_goal_id,
      index,
      updatedAt,
      stringifyJson(proposal),
    );
  });

  const insertLearningRecord = sqlite.prepare(`
    INSERT INTO curiosity_learning_records (
      goal_id,
      dimension_name,
      outcome,
      recorded_at,
      sort_order,
      record_json
    ) VALUES (?, ?, ?, ?, ?, json(?))
  `);
  state.learning_records.forEach((record, index) => {
    insertLearningRecord.run(
      record.goal_id,
      record.dimension_name,
      record.outcome,
      record.recorded_at,
      index,
      stringifyJson(record),
    );
  });

  const insertRejectedHash = sqlite.prepare(`
    INSERT INTO curiosity_rejected_proposal_hashes (
      proposal_hash,
      sort_order,
      updated_at
    ) VALUES (?, ?, ?)
    ON CONFLICT(proposal_hash) DO UPDATE SET
      sort_order = excluded.sort_order,
      updated_at = excluded.updated_at
  `);
  state.rejected_proposal_hashes.forEach((proposalHash, index) => {
    insertRejectedHash.run(proposalHash, index, updatedAt);
  });
}
