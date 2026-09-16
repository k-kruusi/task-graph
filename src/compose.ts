import type { TaskGraph, GraphNode, GraphEdge } from "./types.js";

export function merge(a: TaskGraph, b: TaskGraph, connecting?: GraphEdge[]): TaskGraph {
  const aIds = new Set(a.nodes.map(n => n.id));
  const bIds = new Set(b.nodes.map(n => n.id));
  const overlap = [...bIds].filter(id => aIds.has(id));
  if (overlap.length > 0) {
    throw new Error(`Node ID collision between graphs: ${overlap.join(", ")}`);
  }
  return {
    id: `${a.id}+${b.id}`,
    name: `${a.name} + ${b.name}`,
    description: `Merged: ${a.description} | ${b.description}`,
    nodes: [...a.nodes, ...b.nodes],
    edges: [...a.edges, ...b.edges, ...(connecting || [])],
  };
}

export function insertBefore(
  graph: TaskGraph,
  targetNodeId: string,
  newNode: GraphNode,
): TaskGraph {
  const incoming = graph.edges.filter(e => e.to === targetNodeId);
  const edges = graph.edges.filter(e => e.to !== targetNodeId);
  for (const edge of incoming) {
    edges.push({ ...edge, to: newNode.id });
  }
  edges.push({ from: newNode.id, to: targetNodeId });
  return { ...graph, nodes: [...graph.nodes, newNode], edges };
}

export function insertAfter(
  graph: TaskGraph,
  targetNodeId: string,
  newNode: GraphNode,
): TaskGraph {
  const outgoing = graph.edges.filter(e => e.from === targetNodeId);
  const edges = graph.edges.filter(e => e.from !== targetNodeId);
  edges.push({ from: targetNodeId, to: newNode.id });
  for (const edge of outgoing) {
    edges.push({ ...edge, from: newNode.id });
  }
  return { ...graph, nodes: [...graph.nodes, newNode], edges };
}

export function removeNode(graph: TaskGraph, nodeId: string): TaskGraph {
  const incoming = graph.edges.filter(e => e.to === nodeId);
  const outgoing = graph.edges.filter(e => e.from === nodeId);
  const edges = graph.edges.filter(e => e.from !== nodeId && e.to !== nodeId);
  for (const inEdge of incoming) {
    for (const outEdge of outgoing) {
      edges.push({ from: inEdge.from, to: outEdge.to, on: inEdge.on });
    }
  }
  return {
    ...graph,
    nodes: graph.nodes.filter(n => n.id !== nodeId),
    edges,
  };
}
