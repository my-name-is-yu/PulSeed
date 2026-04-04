import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { type KnowledgeEdge, KnowledgeEdgeSchema } from "../../base/types/knowledge.js";

interface KnowledgeGraphNode {
  entry_id: string;
  goal_id: string;
  tags: string[];
  added_at: string;
}

interface GraphData {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeEdge[];
}

/**
 * KnowledgeGraph stores cross-goal concept relationships as a directed graph.
 * Nodes represent KnowledgeEntry IDs; edges carry typed semantic relations.
 *
 * Persisted as JSON at graphPath: { nodes: [...], edges: [...] }
 */
export class KnowledgeGraph {
  private nodes: Map<string, KnowledgeGraphNode> = new Map();
  private edges: KnowledgeEdge[] = [];

  constructor(private readonly graphPath: string) {
    // Sync loading removed. Use KnowledgeGraph.create() for async load on construction,
    // or call _load() manually after construction.
  }

  /**
   * Factory method: constructs a KnowledgeGraph and loads existing data from disk.
   */
  static async create(graphPath: string): Promise<KnowledgeGraph> {
    const graph = new KnowledgeGraph(graphPath);
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
    this.nodes.set(entryId, node);
    await this.save();
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
    await this.save();
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
    await this.save();
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
      await this.save();
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

  private async save(): Promise<void> {
    const dir = path.dirname(this.graphPath);
    await fsp.mkdir(dir, { recursive: true });

    const data: GraphData = {
      nodes: Array.from(this.nodes.values()),
      edges: this.edges,
    };

    const json = JSON.stringify(data, null, 2);
    const tmpPath = `${this.graphPath}.tmp`;
    await fsp.writeFile(tmpPath, json, "utf-8");
    await fsp.rename(tmpPath, this.graphPath);
  }

  async _load(): Promise<void> {
    try {
      await fsp.access(this.graphPath);
    } catch {
      return;
    }
    try {
      const raw = await fsp.readFile(this.graphPath, "utf-8");
      const parsed = JSON.parse(raw) as GraphData;

      this.nodes.clear();
      this.edges = [];

      for (const node of parsed.nodes ?? []) {
        this.nodes.set(node.entry_id, node);
      }

      for (const edge of parsed.edges ?? []) {
        const validated = KnowledgeEdgeSchema.parse(edge);
        this.edges.push(validated);
      }
    } catch {
      // Corrupt or empty file — start fresh
    }
  }

  /**
   * Remove all nodes and edges and persist the empty state.
   */
  async clear(): Promise<void> {
    this.nodes.clear();
    this.edges = [];
    await this.save();
  }
}
