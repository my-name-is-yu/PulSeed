import {
  openControlDatabase,
  type ControlDatabase,
  type RuntimeControlDbStoreOptions,
} from "../../runtime/store/control-db/index.js";
import { type KnowledgeEdge, KnowledgeEdgeSchema } from "../../base/types/knowledge.js";
import { z } from "zod/v3";

export const KnowledgeGraphNodeSchema = z.object({
  entry_id: z.string().min(1),
  goal_id: z.string().min(1),
  tags: z.array(z.string()),
  added_at: z.string().min(1),
});
export type KnowledgeGraphNode = z.infer<typeof KnowledgeGraphNodeSchema>;

export interface KnowledgeGraphStateStoreOptions extends RuntimeControlDbStoreOptions {}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(value);
}

export class KnowledgeGraphStateStore {
  private dbPromise: Promise<ControlDatabase> | null = null;

  constructor(
    private readonly baseDir: string,
    private readonly options: KnowledgeGraphStateStoreOptions = {},
  ) {}

  async saveNode(node: KnowledgeGraphNode): Promise<KnowledgeGraphNode> {
    const parsed = KnowledgeGraphNodeSchema.parse(node);
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT INTO knowledge_graph_nodes (
          entry_id,
          goal_id,
          tags_json,
          added_at,
          node_json
        ) VALUES (?, ?, json(?), ?, json(?))
        ON CONFLICT(entry_id) DO UPDATE SET
          goal_id = excluded.goal_id,
          tags_json = excluded.tags_json,
          added_at = excluded.added_at,
          node_json = excluded.node_json
      `).run(
        parsed.entry_id,
        parsed.goal_id,
        stringifyJson(parsed.tags),
        parsed.added_at,
        stringifyJson(parsed),
      );
    });
    return parsed;
  }

  async saveEdge(edge: KnowledgeEdge): Promise<KnowledgeEdge> {
    const parsed = KnowledgeEdgeSchema.parse(edge);
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare(`
        INSERT INTO knowledge_graph_edges (
          from_id,
          to_id,
          relation,
          confidence,
          created_at,
          edge_json
        ) VALUES (?, ?, ?, ?, ?, json(?))
        ON CONFLICT(from_id, to_id, relation) DO UPDATE SET
          confidence = excluded.confidence,
          created_at = excluded.created_at,
          edge_json = excluded.edge_json
      `).run(
        parsed.from_id,
        parsed.to_id,
        parsed.relation,
        parsed.confidence,
        parsed.created_at,
        stringifyJson(parsed),
      );
    });
    return parsed;
  }

  async listNodes(): Promise<KnowledgeGraphNode[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT node_json
        FROM knowledge_graph_nodes
        ORDER BY added_at ASC, entry_id ASC
      `).all() as Array<{ node_json: string }>;
      return rows.map((row) => KnowledgeGraphNodeSchema.parse(parseJson(row.node_json)));
    });
  }

  async listEdges(): Promise<KnowledgeEdge[]> {
    const db = await this.database();
    return db.read((sqlite) => {
      const rows = sqlite.prepare(`
        SELECT edge_json
        FROM knowledge_graph_edges
        ORDER BY created_at ASC, from_id ASC, to_id ASC, relation ASC
      `).all() as Array<{ edge_json: string }>;
      return rows.map((row) => KnowledgeEdgeSchema.parse(parseJson(row.edge_json)));
    });
  }

  async removeNode(entryId: string): Promise<boolean> {
    const db = await this.database();
    return db.transaction((sqlite) => {
      const result = sqlite.prepare(`
        DELETE FROM knowledge_graph_nodes
        WHERE entry_id = ?
      `).run(entryId);
      sqlite.prepare(`
        DELETE FROM knowledge_graph_edges
        WHERE from_id = ? OR to_id = ?
      `).run(entryId, entryId);
      return result.changes > 0;
    });
  }

  async removeEdgesBetween(fromId: string, toId: string): Promise<boolean> {
    const db = await this.database();
    return db.transaction((sqlite) => {
      const result = sqlite.prepare(`
        DELETE FROM knowledge_graph_edges
        WHERE from_id = ? AND to_id = ?
      `).run(fromId, toId);
      return result.changes > 0;
    });
  }

  async clear(): Promise<void> {
    const db = await this.database();
    db.transaction((sqlite) => {
      sqlite.prepare("DELETE FROM knowledge_graph_edges").run();
      sqlite.prepare("DELETE FROM knowledge_graph_nodes").run();
    });
  }

  async close(): Promise<void> {
    if (this.options.controlDb || !this.dbPromise) return;
    const db = await this.dbPromise;
    db.close();
    this.dbPromise = null;
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
