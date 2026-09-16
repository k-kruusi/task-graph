import { describe, it, expect } from "vitest";
import { execute, NodeRegistry, type NodeResult, type TaskGraph } from "../index.js";

function makeRegistry(): NodeRegistry {
  const reg = new NodeRegistry();
  reg.register("echo", async (params) => params);
  reg.register("add", async (params, ctx) => {
    const a = (ctx.nodes[params.left as string]?.result as any)?.value ?? 0;
    const b = (ctx.nodes[params.right as string]?.result as any)?.value ?? 0;
    return { value: a + b };
  });
  reg.register("fail", async () => { throw new Error("intentional failure"); });
  reg.register("slow", async (params) => {
    await new Promise(r => setTimeout(r, (params.ms as number) || 100));
    return { ok: true };
  });
  return reg;
}

describe("execute", () => {
  it("runs a linear graph in order", async () => {
    const graph: TaskGraph = {
      id: "test-linear",
      name: "Linear",
      description: "A -> B -> C",
      nodes: [
        { id: "a", type: "echo", params: { step: 1 } },
        { id: "b", type: "echo", params: { step: 2 } },
        { id: "c", type: "echo", params: { step: 3 } },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
    };

    const trace = await execute(graph, {}, makeRegistry());
    expect(trace.status).toBe("completed");
    expect(trace.nodeResults).toHaveLength(3);
    expect(trace.nodeResults.map(r => r.nodeId)).toEqual(["a", "b", "c"]);
    expect(trace.nodeResults.every(r => r.status === "completed")).toBe(true);
  });

  it("runs parallel nodes at the same depth", async () => {
    const graph: TaskGraph = {
      id: "test-parallel",
      name: "Parallel",
      description: "A -> [B, C] -> D",
      nodes: [
        { id: "a", type: "echo", params: {} },
        { id: "b", type: "slow", params: { ms: 50 } },
        { id: "c", type: "slow", params: { ms: 50 } },
        { id: "d", type: "echo", params: {} },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "a", to: "c" },
        { from: "b", to: "d" },
        { from: "c", to: "d" },
      ],
    };

    const start = Date.now();
    const trace = await execute(graph, {}, makeRegistry());
    const elapsed = Date.now() - start;
    expect(trace.status).toBe("completed");
    // B and C should run in parallel, so total time should be ~50ms not ~100ms
    expect(elapsed).toBeLessThan(150);
  });

  it("skips downstream nodes on failure (default success edge)", async () => {
    const graph: TaskGraph = {
      id: "test-fail",
      name: "Fail",
      description: "A -> fail -> C",
      nodes: [
        { id: "a", type: "echo", params: {} },
        { id: "b", type: "fail", params: {} },
        { id: "c", type: "echo", params: {} },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "c" },
      ],
    };

    const trace = await execute(graph, {}, makeRegistry());
    expect(trace.status).toBe("failed");
    const results = Object.fromEntries(trace.nodeResults.map(r => [r.nodeId, r.status]));
    expect(results.a).toBe("completed");
    expect(results.b).toBe("failed");
    expect(results.c).toBe("skipped");
  });

  it("runs downstream on failure when edge.on = 'always'", async () => {
    const graph: TaskGraph = {
      id: "test-always",
      name: "Always",
      description: "A(fail) -always-> B",
      nodes: [
        { id: "a", type: "fail", params: {} },
        { id: "b", type: "echo", params: { ran: true } },
      ],
      edges: [
        { from: "a", to: "b", on: "always" },
      ],
    };

    const trace = await execute(graph, {}, makeRegistry());
    const results = Object.fromEntries(trace.nodeResults.map(r => [r.nodeId, r.status]));
    expect(results.a).toBe("failed");
    expect(results.b).toBe("completed");
  });

  it("evaluates edge conditions", async () => {
    const graph: TaskGraph = {
      id: "test-condition",
      name: "Condition",
      description: "A -> B (only if A.result.go === true)",
      nodes: [
        { id: "a", type: "echo", params: { go: false } },
        { id: "b", type: "echo", params: { reached: true } },
      ],
      edges: [
        { from: "a", to: "b", condition: "nodes.a.result.go === true" },
      ],
    };

    const trace = await execute(graph, {}, makeRegistry());
    const results = Object.fromEntries(trace.nodeResults.map(r => [r.nodeId, r.status]));
    expect(results.a).toBe("completed");
    expect(results.b).toBe("skipped");
  });

  it("interpolates template params from context", async () => {
    const graph: TaskGraph = {
      id: "test-template",
      name: "Template",
      description: "Params flow through",
      nodes: [
        { id: "a", type: "echo", params: { name: "{{params.agent}}" } },
      ],
      edges: [],
    };

    const trace = await execute(graph, { agent: "claude" }, makeRegistry());
    expect(trace.status).toBe("completed");
    expect(trace.nodeResults[0].result).toEqual({ name: "claude" });
  });

  it("times out slow nodes", async () => {
    const graph: TaskGraph = {
      id: "test-timeout",
      name: "Timeout",
      description: "Node that exceeds timeout",
      nodes: [
        { id: "a", type: "slow", params: { ms: 500 }, timeoutMs: 50 },
      ],
      edges: [],
    };

    const trace = await execute(graph, {}, makeRegistry());
    expect(trace.nodeResults[0].status).toBe("timed_out");
  });

  it("detects cycles", async () => {
    const graph: TaskGraph = {
      id: "test-cycle",
      name: "Cycle",
      description: "A -> B -> A",
      nodes: [
        { id: "a", type: "echo", params: {} },
        { id: "b", type: "echo", params: {} },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    };

    await expect(execute(graph, {}, makeRegistry())).rejects.toThrow(/[Cc]ycle/);
  });
});

describe("intermediate attempt failures (issue #654)", () => {
  it("fires onNodeAttemptFailed on a timed-out intermediate attempt; the abandoned execution settles before the retry starts", async () => {
    const reg = new NodeRegistry();
    let calls = 0;
    let inflight = 0;
    let maxInflight = 0;
    reg.register("flaky", async () => {
      calls++;
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      try {
        // Attempt 1 outlives the 50ms timeout (rejected as timed_out) but settles
        // inside the grace window (~2x timeout) — the abandoned-handler shape
        // from the issue, still killable. Attempt 2 succeeds quickly.
        if (calls === 1) await new Promise((r) => setTimeout(r, 80));
        else await new Promise((r) => setTimeout(r, 5));
        return { ok: true };
      } finally {
        inflight--;
      }
    });

    const attemptFailures: NodeResult[] = [];
    const terminalFailures: NodeResult[] = [];
    const graph: TaskGraph = {
      id: "retry-timeout",
      name: "Retry timeout",
      description: "attempt 1 times out, attempt 2 succeeds",
      nodes: [{ id: "a", type: "flaky", params: {}, retries: 1, timeoutMs: 50 }],
      edges: [],
    };

    const t0 = Date.now();
    const trace = await execute(graph, {}, reg, {
      onNodeAttemptFailed: (_nodeId, _cid, r) => attemptFailures.push(r),
      onNodeFailed: (_nodeId, _cid, r) => terminalFailures.push(r),
    });
    const elapsed = Date.now() - t0;

    expect(trace.status).toBe("completed");
    expect(calls).toBe(2);
    expect(maxInflight).toBe(1); // the retry never overlapped the abandoned execution
    expect(elapsed).toBeGreaterThanOrEqual(75); // waited for the abandoned execution to settle
    expect(attemptFailures.map((r) => [r.attempt, r.status])).toEqual([[1, "timed_out"]]);
    expect(terminalFailures).toHaveLength(0); // onNodeFailed stays terminal-only
    expect(trace.nodeResults[0].attempt).toBe(2);
  });

  it("bounds the wait on an abandoned execution that never settles (grace ≈ one more timeout window)", async () => {
    const reg = new NodeRegistry();
    let calls = 0;
    reg.register("hung", async () => {
      calls++;
      if (calls === 1) return new Promise(() => {}); // never settles
      return { ok: true };
    });

    const attemptFailures: NodeResult[] = [];
    const graph: TaskGraph = {
      id: "retry-hang",
      name: "Retry hang",
      description: "abandoned attempt never settles",
      nodes: [{ id: "a", type: "hung", params: {}, retries: 1, timeoutMs: 40 }],
      edges: [],
    };

    const t0 = Date.now();
    const trace = await execute(graph, {}, reg, {
      onNodeAttemptFailed: (_nodeId, _cid, r) => attemptFailures.push(r),
    });
    const elapsed = Date.now() - t0;

    expect(trace.status).toBe("completed");
    expect(calls).toBe(2);
    expect(attemptFailures).toHaveLength(1);
    // 40ms timeout + ≤40ms grace + ε; an unbounded wait would never return.
    expect(elapsed).toBeLessThan(1000);
  });

  it("fires onNodeAttemptFailed for a non-timeout intermediate failure too", async () => {
    const reg = new NodeRegistry();
    let calls = 0;
    reg.register("err-then-ok", async () => {
      calls++;
      if (calls === 1) throw new Error("transient");
      return { ok: true };
    });

    const attemptFailures: NodeResult[] = [];
    const graph: TaskGraph = {
      id: "retry-error",
      name: "Retry error",
      description: "first attempt throws, second succeeds",
      nodes: [{ id: "a", type: "err-then-ok", params: {}, retries: 1 }],
      edges: [],
    };

    const trace = await execute(graph, {}, reg, {
      onNodeAttemptFailed: (_nodeId, _cid, r) => attemptFailures.push(r),
    });

    expect(trace.status).toBe("completed");
    expect(calls).toBe(2);
    expect(attemptFailures.map((r) => [r.attempt, r.status])).toEqual([[1, "failed"]]);
  });
});
