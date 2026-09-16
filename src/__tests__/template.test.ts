import { describe, it, expect } from "vitest";
import { interpolate } from "../template.js";

describe("interpolate", () => {
  it("replaces flat params", () => {
    const result = interpolate(
      { name: "{{params.agent}}", other: "static" },
      { params: { agent: "claude" } },
    );
    expect(result).toEqual({ name: "claude", other: "static" });
  });

  it("replaces dot-notation paths to upstream node results", () => {
    const result = interpolate(
      { session: "{{nodes.reset.result.previousSession}}" },
      { params: {}, nodes: { reset: { result: { previousSession: "abc-123" } } } },
    );
    expect(result).toEqual({ session: "abc-123" });
  });

  it("preserves type for full-replacement templates", () => {
    const result = interpolate(
      { count: "{{params.count}}" },
      { params: { count: 42 } },
    );
    expect(result).toEqual({ count: 42 });
  });

  it("handles partial string interpolation", () => {
    const result = interpolate(
      { msg: "Hello {{params.name}}, session {{params.id}}" },
      { params: { name: "Kevin", id: "s-123" } },
    );
    expect(result).toEqual({ msg: "Hello Kevin, session s-123" });
  });

  it("leaves unresolved templates intact", () => {
    const result = interpolate(
      { name: "{{params.missing}}" },
      { params: {} },
    );
    expect(result).toEqual({ name: "{{params.missing}}" });
  });

  it("resolves run.correlationId / workflowId / workflowName in notify-style strings", () => {
    const result = interpolate(
      {
        msg: "done — {{run.workflowName}} ({{run.workflowId}}) cid={{run.correlationId}}",
      },
      {
        run: {
          correlationId: "wf-abc",
          workflowId: "goal-x-validate",
          workflowName: "goal-x goal-validation",
        },
      },
    );
    expect(result).toEqual({
      msg: "done — goal-x goal-validation (goal-x-validate) cid=wf-abc",
    });
  });

  it("leaves {{run.status}} literal — status is intentionally not in RunScope mid-graph",
    () => {
      const result = interpolate(
        { msg: "status={{run.status}} cid={{run.correlationId}}" },
        {
          run: {
            correlationId: "wf-abc",
            workflowId: "goal-x",
            workflowName: "goal-x",
          },
        },
      );
      // Partial resolve: known fields expand; unknown stay as visible typos.
      expect(result).toEqual({ msg: "status={{run.status}} cid=wf-abc" });
    },
  );

  it("handles nested objects", () => {
    const result = interpolate(
      { config: { name: "{{params.agent}}", timeout: 5000 } },
      { params: { agent: "claude" } },
    );
    expect(result).toEqual({ config: { name: "claude", timeout: 5000 } });
  });

  it("full-match template resolving to null yields null, not the literal template", () => {
    const result = interpolate(
      { x: "{{nodes.a.result}}" },
      { nodes: { a: { result: null } } },
    );
    expect(result).toEqual({ x: null });
  });

  it("partial template resolving to null coerces to the string 'null'", () => {
    const result = interpolate(
      { msg: "value={{nodes.a.result}}" },
      { nodes: { a: { result: null } } },
    );
    expect(result).toEqual({ msg: "value=null" });
  });

  it("does not re-interpolate templates inside resolved objects (single-pass)", () => {
    const result = interpolate(
      { out: "{{nodes.a.result}}" },
      {
        nodes: {
          a: { result: { msg: "{{nodes.secret.result}}" } },
          secret: { result: "LEAKED" },
        },
      },
    );
    // Node output is data: a "{{...}}" inside it stays literal.
    expect(result).toEqual({ out: { msg: "{{nodes.secret.result}}" } });
  });

  it("does not re-interpolate a resolved string containing a template", () => {
    const result = interpolate(
      { out: "{{nodes.a.result}}" },
      {
        nodes: {
          a: { result: "{{nodes.secret.result}}" },
          secret: { result: "LEAKED" },
        },
      },
    );
    expect(result).toEqual({ out: "{{nodes.secret.result}}" });
  });

  it("deep-copies resolved objects so params never alias scope results", () => {
    const scope = { nodes: { a: { result: { items: [1, 2] } } } };
    const result = interpolate({ out: "{{nodes.a.result}}" }, scope);
    (result.out as { items: number[] }).items.push(3);
    expect(scope.nodes.a.result.items).toEqual([1, 2]);
  });
});
