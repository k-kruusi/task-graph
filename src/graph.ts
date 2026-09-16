import type { TaskGraph, GraphNode, GraphEdge } from "./types.js";
import { compileCondition, type CompiledCondition } from "./condition.js";

export interface ValidatedGraph {
  graph: TaskGraph;
  levels: string[][];
  compiledConditions: Map<string, CompiledCondition>;
}

export class GraphBuilder {
  private nodes: GraphNode[] = [];
  private edges: GraphEdge[] = [];

  constructor(
    private id: string,
    private name: string,
    private description: string,
  ) {}

  addNode(node: GraphNode): this {
    this.nodes.push(node);
    return this;
  }

  addEdge(edge: GraphEdge): this {
    this.edges.push(edge);
    return this;
  }

  build(): TaskGraph {
    return {
      id: this.id,
      name: this.name,
      description: this.description,
      nodes: this.nodes,
      edges: this.edges,
    };
  }
}

export function validate(graph: TaskGraph): ValidatedGraph {
  const nodeIds = new Set<string>();
  const duplicates = new Set<string>();
  for (const node of graph.nodes) {
    if (nodeIds.has(node.id)) duplicates.add(node.id);
    nodeIds.add(node.id);
  }
  if (duplicates.size > 0) {
    // Without this check, topoSort's id-keyed Maps dedup silently (one node is
    // dropped) and the length mismatch is misreported as a cycle with an empty
    // node list.
    throw new Error(
      `Duplicate node id(s): ${[...duplicates].join(", ")} — node ids must be unique`,
    );
  }

  for (const edge of graph.edges) {
    if (!nodeIds.has(edge.from)) {
      throw new Error(`Edge references unknown node: "${edge.from}"`);
    }
    if (!nodeIds.has(edge.to)) {
      throw new Error(`Edge references unknown node: "${edge.to}"`);
    }
  }

  const compiledConditions = new Map<string, CompiledCondition>();
  for (const edge of graph.edges) {
    if (edge.condition) {
      const key = `${edge.from}->${edge.to}`;
      compiledConditions.set(key, compileCondition(edge.condition));
    }
  }

  const levels = topoSort(graph.nodes, graph.edges);
  return { graph, levels, compiledConditions };
}

// Assumes unique node ids — validate() rejects duplicates before calling.
function topoSort(nodes: GraphNode[], edges: GraphEdge[]): string[][] {
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  for (const n of nodes) {
    inDegree.set(n.id, 0);
    adjacency.set(n.id, []);
  }
  for (const e of edges) {
    inDegree.set(e.to, (inDegree.get(e.to) || 0) + 1);
    adjacency.get(e.from)!.push(e.to);
  }

  const levels: string[][] = [];
  let queue = [...inDegree.entries()].filter(([, d]) => d === 0).map(([id]) => id);

  while (queue.length > 0) {
    levels.push(queue);
    const next: string[] = [];
    for (const id of queue) {
      for (const neighbor of adjacency.get(id) || []) {
        const d = inDegree.get(neighbor)! - 1;
        inDegree.set(neighbor, d);
        if (d === 0) next.push(neighbor);
      }
    }
    queue = next;
  }

  const sorted = levels.flat();
  if (sorted.length !== nodes.length) {
    const missing = nodes.filter(n => !sorted.includes(n.id)).map(n => n.id);
    throw new Error(`Cycle detected involving nodes: ${missing.join(", ")}`);
  }

  return levels;
}
