import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
} from "../../runtime/store/control-db/index.js";
import {
  StrategyTemplateSchema,
  type StrategyTemplate,
} from "../../base/types/cross-portfolio.js";

export interface StrategyTemplateStateStoreOptions extends RuntimeControlDbStoreOptions {}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

export class StrategyTemplateStateStore {
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    private readonly baseDir: string,
    private readonly options: StrategyTemplateStateStoreOptions = {},
  ) {}

  async save(template: StrategyTemplate): Promise<StrategyTemplate> {
    const [parsed] = await this.saveMany([template]);
    return parsed;
  }

  async saveMany(templates: readonly StrategyTemplate[]): Promise<StrategyTemplate[]> {
    const parsed = templates.map((template) => StrategyTemplateSchema.parse(template));
    const db = await this.database();
    db.transaction((sqlite) => {
      const statement = sqlite.prepare(`
        INSERT INTO strategy_templates (
          template_id,
          source_goal_id,
          source_strategy_id,
          effectiveness_score,
          embedding_id,
          created_at,
          template_json
        ) VALUES (?, ?, ?, ?, ?, ?, json(?))
        ON CONFLICT(template_id) DO UPDATE SET
          source_goal_id = excluded.source_goal_id,
          source_strategy_id = excluded.source_strategy_id,
          effectiveness_score = excluded.effectiveness_score,
          embedding_id = excluded.embedding_id,
          created_at = excluded.created_at,
          template_json = excluded.template_json
      `);
      for (const template of parsed) {
        statement.run(
          template.template_id,
          template.source_goal_id,
          template.source_strategy_id,
          template.effectiveness_score,
          template.embedding_id,
          template.created_at,
          stringifyJson(template),
        );
      }
    });
    return parsed;
  }

  async load(templateId: string): Promise<StrategyTemplate | null> {
    const db = await this.database();
    return db.read((sqlite) => {
      const row = sqlite.prepare(`
        SELECT template_json
        FROM strategy_templates
        WHERE template_id = ?
      `).get(templateId) as { template_json: string } | undefined;
      if (!row) return null;
      return StrategyTemplateSchema.parse(parseJson(row.template_json));
    });
  }

  async list(): Promise<StrategyTemplate[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT template_json
        FROM strategy_templates
        ORDER BY created_at ASC, template_id ASC
      `).all() as Array<{ template_json: string }>;
      return rows.map((row) => StrategyTemplateSchema.parse(parseJson(row.template_json)));
    });
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
