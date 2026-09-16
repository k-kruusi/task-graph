/**
 * resolveResultNode — the output contract's resolution order and every way it
 * must fail LOUD: explicit override > declared resultNode > sole terminal,
 * with available node ids named on any ambiguity.
 */
import { describe, it, expect } from "vitest";
import { resolveResultNode } from "../result-node.js";
import type { TaskGraph } from "../types.js";

const g = (over: Partial<TaskGraph> = {}): TaskGraph => ({
  id: "g",
  name: "g",
  description: "",
  nodes: [
    { id: "a", type: "t", params: {} },
    { id: "b", type: "t", params: {} },
  ],
  edges: [{ from: "a", to: "b" }],
  ...over,
});

describe("resolveResultNode", () => {
  it("an explicit override wins — and must name a real node", () => {
    expect(resolveResultNode(g(), "a")).toBe("a");
    expect(() => resolveResultNode(g(), "nope")).toThrow(/does not exist.*available: a, b/);
  });

  it("a declared resultNode beats terminal derivation", () => {
    expect(resolveResultNode(g({ resultNode: "a" }))).toBe("a");
  });

  it("a declared resultNode naming no node fails at resolution, naming the graph", () => {
    expect(() => resolveResultNode(g({ resultNode: "ghost" }))).toThrow(/declares resultNode "ghost"/);
  });

  it("a sole terminal derives; multiple terminals demand an explicit choice", () => {
    expect(resolveResultNode(g())).toBe("b");
    expect(() => resolveResultNode(g({ edges: [] }))).toThrow(/2 terminal node\(s\)/);
  });
});
