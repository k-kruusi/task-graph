/**
 * result-node.ts — the output contract: which node's result IS the graph's
 * answer (Kevin, 2026-08-05). A workflow called like a tool should return its
 * answer, not its execution trace; the trace stays in the run store for
 * whoever actually wants per-node detail.
 *
 * Resolution order, same rule as the workflow:run node: an explicit override
 * beats the definition's declared resultNode, which beats sole-terminal
 * derivation. Any ambiguity throws naming the available node ids — a contract
 * that can't resolve must fail at call time, never return a silent trace.
 */
import type { TaskGraph } from "./types.js";

export function resolveResultNode(graph: TaskGraph, explicit?: string): string {
  const ids = graph.nodes.map((n) => n.id);
  if (explicit !== undefined) {
    if (!ids.includes(explicit)) {
      throw new Error(`resultNode "${explicit}" does not exist in graph "${graph.id}" (available: ${ids.join(", ")})`);
    }
    return explicit;
  }
  if (graph.resultNode !== undefined) {
    if (!ids.includes(graph.resultNode)) {
      throw new Error(`graph "${graph.id}" declares resultNode "${graph.resultNode}" which does not exist (available: ${ids.join(", ")})`);
    }
    return graph.resultNode;
  }
  const fromSet = new Set(graph.edges.map((e) => e.from));
  const terminals = ids.filter((id) => !fromSet.has(id));
  if (terminals.length !== 1) {
    throw new Error(
      `graph "${graph.id}" has ${terminals.length} terminal node(s) (${terminals.join(", ") || "none"}) — pass resultNode to say which one is the answer`,
    );
  }
  return terminals[0];
}
