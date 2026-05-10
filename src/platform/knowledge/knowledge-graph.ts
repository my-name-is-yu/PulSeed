import * as path from "node:path";
import { type KnowledgeEdge, KnowledgeEdgeSchema } from "../../base/types/knowledge.js";
import type { RuntimeControlDbStoreOptions } from "../../runtime/store/control-db/index.js";
import {
  KnowledgeGraphNodeSchema,
  KnowledgeGraphStateStore,
  type KnowledgeGraphNode,
} from "./knowledge-graph-state-store.js";

export { KnowledgeGraphNodeSchema, type KnowledgeGraphNode };
export interface KnowledgeGraphOptions extends RuntimeControlDbStoreOptions {}
export interface GraphData {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeEdge[];
}

/**
 * KnowledgeGraph stores cross-goal concept relationships as a directed graph.
 * Nodes represent KnowledgeEntry IDs; edges carry typed semantic relations.
 *
 * Persisted as typed control DB rows. Legacy JSON graph files are explicit
 * doctor/repair import inputs, not runtime fallback state.
 */
export class KnowledgeGraph {
  private nodes: Map<string, KnowledgeGraphNode> = new Map();
  private edges: KnowledgeEdge[] = [];
  private readonly stateStore: KnowledgeGraphStateStore;

  constructor(legacyGraphFilePath: string, options: KnowledgeGraphOptions = {}) {
    const baseDir = options.controlBaseDir ?? path.dirname(legacyGraphFilePath);
    this.stateStore = new KnowledgeGraphStateStore(baseDir, options);
  }

  /**
   * Factory method: constructs a KnowledgeGraph and loads typed store data.
   * The path argument is retained for compatibility; normal runtime does not read or write it.
   */
  static async create(
    legacyGraphFilePath: string,
    options: KnowledgeGraphOptions = {},
  ): Promise<KnowledgeGraph> {
    const graph = new KnowledgeGraph(legacyGraphFilePath, options);
    await graph._load();
    return graph;
  }

  static async createForControlDb(
    baseDir: string,
    options: KnowledgeGraphOptions = {},
  ): Promise<KnowledgeGraph> {
    const graph = new KnowledgeGraph(path.join(baseDir, "control.sqlite"), {
      ...options,
      controlBaseDir: options.controlBaseDir ?? baseDir,
    });
    await graph._load();
    return graph;
  }

  // ─── Node CRUD ───

  /**
   * Add a node for a KnowledgeEntry. If a node with the same entry_id already
   * exists, it is replaced (update semantics).
   */
  async addNode(entryId: string, goalId: string, tags: string[]): Promise<void> {
    const node: KnowledgeGraphNode = {
      entry_id: entryId,
      goal_id: goalId,
      tags: [...tags],
      added_at: new Date().toISOString(),
    };
    const parsed = KnowledgeGraphNodeSchema.parse(node);
    this.nodes.set(entryId, parsed);
    await this.stateStore.saveNode(parsed);
  }

  /**
   * Remove a node and all edges that reference it.
   */
  async removeNode(entryId: string): Promise<void> {
    if (!this.nodes.has(entryId)) return;
    this.nodes.delete(entryId);
    this.edges = this.edges.filter(
      (e) => e.from_id !== entryId && e.to_id !== entryId
    );
    await this.stateStore.removeNode(entryId);
  }

  getNode(entryId: string): KnowledgeGraphNode | undefined {
    return this.nodes.get(entryId);
  }

  getAllNodes(): KnowledgeGraphNode[] {
    return Array.from(this.nodes.values());
  }

  // ─── Edge CRUD ───

  /**
   * Add an edge. created_at is set automatically to the current timestamp.
   * Duplicate edges (same from_id, to_id, relation) are replaced.
   */
  async addEdge(edge: Omit<KnowledgeEdge, "created_at">): Promise<void> {
    // Remove existing edge with same from/to/relation to avoid duplicates
    this.edges = this.edges.filter(
      (e) =>
        !(
          e.from_id === edge.from_id &&
          e.to_id === edge.to_id &&
          e.relation === edge.relation
        )
    );
    const full = KnowledgeEdgeSchema.parse({
      ...edge,
      created_at: new Date().toISOString(),
    });
    this.edges.push(full);
    await this.stateStore.saveEdge(full);
  }

  /**
   * Remove all edges between fromId and toId (regardless of relation type).
   */
  async removeEdge(fromId: string, toId: string): Promise<void> {
    const before = this.edges.length;
    this.edges = this.edges.filter(
      (e) => !(e.from_id === fromId && e.to_id === toId)
    );
    if (this.edges.length !== before) {
      await this.stateStore.removeEdgesBetween(fromId, toId);
    }
  }

  getEdgesFrom(entryId: string): KnowledgeEdge[] {
    return this.edges.filter((e) => e.from_id === entryId);
  }

  getEdgesTo(entryId: string): KnowledgeEdge[] {
    return this.edges.filter((e) => e.to_id === entryId);
  }

  getAllEdges(): KnowledgeEdge[] {
    return [...this.edges];
  }

  // ─── Queries ───

  /**
   * Returns all nodes reachable from entryId via a single outgoing edge,
   * paired with the connecting edge.
   */
  getRelated(
    entryId: string
  ): { node: KnowledgeGraphNode; edge: KnowledgeEdge }[] {
    const outgoing = this.getEdgesFrom(entryId);
    const result: { node: KnowledgeGraphNode; edge: KnowledgeEdge }[] = [];
    for (const edge of outgoing) {
      const node = this.nodes.get(edge.to_id);
      if (node) {
        result.push({ node, edge });
      }
    }
    return result;
  }

  /**
   * Returns all edges with relation = "contradicts".
   */
  getContradictions(): KnowledgeEdge[] {
    return this.edges.filter((e) => e.relation === "contradicts");
  }

  // ─── Cycle Detection (DFS) ───

  /**
   * Detect all simple cycles in the directed graph.
   * Returns an array of node-ID arrays, each representing one cycle.
   * Uses DFS with a recursion stack.
   */
  detectCycles(): string[][] {
    const visited = new Set<string>();
    const recStack = new Set<string>();
    const cycles: string[][] = [];
    const path: string[] = [];

    const dfs = (nodeId: string): void => {
      visited.add(nodeId);
      recStack.add(nodeId);
      path.push(nodeId);

      for (const edge of this.getEdgesFrom(nodeId)) {
        const neighbor = edge.to_id;
        if (!visited.has(neighbor)) {
          dfs(neighbor);
        } else if (recStack.has(neighbor)) {
          // Found a cycle: extract the cycle portion from path
          const cycleStart = path.indexOf(neighbor);
          if (cycleStart !== -1) {
            cycles.push([...path.slice(cycleStart), neighbor]);
          }
        }
      }

      path.pop();
      recStack.delete(nodeId);
    };

    for (const nodeId of this.nodes.keys()) {
      if (!visited.has(nodeId)) {
        dfs(nodeId);
      }
    }

    return cycles;
  }

  // ─── Stats ───

  get nodeCount(): number {
    return this.nodes.size;
  }

  get edgeCount(): number {
    return this.edges.length;
  }

  // ─── Persistence ───

  async _load(): Promise<void> {
    this.nodes.clear();
    this.edges = [];
    try {
      for (const node of await this.stateStore.listNodes()) {
        this.nodes.set(node.entry_id, node);
      }
      this.edges = await this.stateStore.listEdges();
    } catch {
      // Corrupt typed rows or unavailable store: start with an empty in-memory graph.
    }
  }

  async close(): Promise<void> {
    await this.stateStore.close();
  }

  /**
   * Remove all nodes and edges and persist the empty state.
   */
  async clear(): Promise<void> {
    this.nodes.clear();
    this.edges = [];
    await this.stateStore.clear();
  }
}
