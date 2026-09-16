import { describe, it, expect } from "vitest";
import { validate } from "../graph.js";
import type { TaskGraph, GraphNode } from "../types.js";

function node(id: string): GraphNode {
  return { id, type: "test", params: {} };
}

function graph(nodes: GraphNode[], edges: TaskGraph["edges"]): TaskGraph {
  return { id: "g", name: "g", description: "test graph", nodes, edges };
}

describe("validate", () => {
  it("accepts a simple DAG", () => {
    const validated = validate(graph(
      [node("a"), node("b")],
      [{ from: "a", to: "b" }],
    ));
    expect(validated.levels).toEqual([["a"], ["b"]]);
  });

  it("rejects duplicate node ids by name, not as a phantom cycle", () => {
    expect(() => validate(graph(
      [node("a"), node("b"), node("a")],
      [{ from: "a", to: "b" }],
    ))).toThrow(/Duplicate node id\(s\): a/);
  });

  it("names every duplicated id", () => {
    expect(() => validate(graph(
      [node("a"), node("a"), node("b"), node("b")],
      [],
    ))).toThrow(/Duplicate node id\(s\): a, b/);
  });

  it("still detects real cycles and names the nodes involved", () => {
    expect(() => validate(graph(
      [node("a"), node("b")],
      [{ from: "a", to: "b" }, { from: "b", to: "a" }],
    ))).toThrow(/Cycle detected involving nodes: a, b/);
  });
});
