import { describe, it, expect } from "vitest";
import { execute, NodeRegistry, type TaskGraph, type NodeResult } from "../index.js";

// A -> [b, c] -> gate -> tail
// `gate` fails until a sentinel flips, mirroring a transient failure that a
// resume should retry without re-running the completed upstream nodes.
function makeGraph(): TaskGraph {
  return {
    id: "resume-test",
    name: "Resume",
    description: "A -> [b,c] -> gate -> tail",
    nodes: [
      { id: "a", type: "count", params: {} },
      { id: "b", type: "count", params: {} },
      { id: "c", type: "count", params: {} },
      { id: "gate", type: "gate", params: {} },
      { id: "tail", type: "count", params: {} },
    ],
    edges: [
      { from: "a", to: "b" },
      { from: "a", to: "c" },
      { from: "b", to: "gate" },
      { from: "c", to: "gate" },
      { from: "gate", to: "tail" },
    ],
  };
}

describe("execute — resume (priorResults)", () => {
  it("carries completed nodes forward and re-runs only the failure + downstream", async () => {
    const runCounts: Record<string, number> = {};
    const sentinel = { open: false };
    const reg = new NodeRegistry();
    // "count" is shared by a/b/c/tail; each execution bumps a single counter so we
    // can prove carried-forward nodes are NOT re-run on resume.
    reg.register("count", async () => {
      runCounts.count = (runCounts.count ?? 0) + 1;
      return { ran: true };
    });
    reg.register("gate", async () => {
      runCounts.gate = (runCounts.gate ?? 0) + 1;
      if (!sentinel.open) throw new Error("gate closed");
      return { gate: "open" };
    });

    const graph = makeGraph();

    // ── Run 1: gate closed -> a,b,c complete, gate fails, tail skipped ──
    const t1 = await execute(graph, {}, reg, undefined, { correlationId: "run-1" });
    expect(t1.correlationId).toBe("run-1"); // injected id honored
    expect(t1.status).toBe("failed");
    const byId1 = new Map(t1.nodeResults.map(r => [r.nodeId, r]));
    expect(byId1.get("a")!.status).toBe("completed");
    expect(byId1.get("b")!.status).toBe("completed");
    expect(byId1.get("c")!.status).toBe("completed");
    expect(byId1.get("gate")!.status).toBe("failed");
    expect(byId1.get("tail")!.status).toBe("skipped");
    const countAfterRun1 = runCounts.count; // a,b,c each ran once = 3
    expect(countAfterRun1).toBe(3);
    expect(runCounts.gate).toBe(1);

    // ── Fix the transient cause, then resume from the prior results ──
    sentinel.open = true;
    const t2 = await execute(graph, {}, reg, undefined, {
      correlationId: "run-1",
      priorResults: t1.nodeResults,
    });

    expect(t2.status).toBe("completed");
    expect(t2.correlationId).toBe("run-1");
    // a,b,c carried forward -> NOT re-executed (count handler unchanged at 3 + tail's 1 = 4)
    expect(runCounts.count).toBe(countAfterRun1 + 1); // only tail ran this time
    // gate re-ran (failure retried)
    expect(runCounts.gate).toBe(2);

    const byId2 = new Map(t2.nodeResults.map(r => [r.nodeId, r]));
    expect(byId2.get("gate")!.status).toBe("completed");
    expect(byId2.get("tail")!.status).toBe("completed");
    // carried results preserve their original timing (proof they weren't recomputed)
    expect(byId2.get("a")!.startedAt).toBe(byId1.get("a")!.startedAt);
  });

  it("fires onNodeSkipped for skipped nodes", async () => {
    const reg = new NodeRegistry();
    reg.register("ok", async () => ({ ok: true }));
    reg.register("boom", async () => { throw new Error("boom"); });
    const skipped: string[] = [];
    const graph: TaskGraph = {
      id: "skip-cb",
      name: "Skip callback",
      description: "a -> boom -> c",
      nodes: [
        { id: "a", type: "ok", params: {} },
        { id: "boom", type: "boom", params: {} },
        { id: "c", type: "ok", params: {} },
      ],
      edges: [
        { from: "a", to: "boom" },
        { from: "boom", to: "c" },
      ],
    };
    await execute(graph, {}, reg, {
      onNodeSkipped: (nodeId) => { skipped.push(nodeId); },
    });
    expect(skipped).toEqual(["c"]);
  });

  it("resume re-evaluates edges: a failure-branch node SKIPS when its parent now succeeds", async () => {
    // root --on:failure--> recover. Run 1: root fails → recover runs. Resume with
    // root now succeeding: recover must NOT be carried forward as completed — its
    // failure edge no longer fires, so it should be skipped.
    let rootShouldFail = true;
    let recoverRuns = 0;
    const reg = new NodeRegistry();
    reg.register("root", async () => { if (rootShouldFail) throw new Error("root failed"); return { ok: true }; });
    reg.register("recover", async () => { recoverRuns++; return { recovered: true }; });
    const graph: TaskGraph = {
      id: "fail-edge", name: "Fail edge", description: "root --failure--> recover",
      nodes: [{ id: "root", type: "root", params: {} }, { id: "recover", type: "recover", params: {} }],
      edges: [{ from: "root", to: "recover", on: "failure" }],
    };

    const t1 = await execute(graph, {}, reg, undefined, { correlationId: "r1" });
    const m1 = new Map(t1.nodeResults.map(r => [r.nodeId, r]));
    expect(m1.get("root")!.status).toBe("failed");
    expect(m1.get("recover")!.status).toBe("completed");
    expect(recoverRuns).toBe(1);

    rootShouldFail = false;
    const t2 = await execute(graph, {}, reg, undefined, { correlationId: "r1", priorResults: t1.nodeResults });
    const m2 = new Map(t2.nodeResults.map(r => [r.nodeId, r]));
    expect(m2.get("root")!.status).toBe("completed");
    expect(m2.get("recover")!.status).toBe("skipped"); // re-evaluated, NOT stale-completed
    expect(recoverRuns).toBe(1); // skipped, not re-executed
  });

  it("resume re-runs an always-edge aggregator so it sees the NEW upstream result", async () => {
    // up --on:always--> agg. Run 1: up fails, agg runs + records up=failed. Resume
    // with up succeeding: agg must re-run and record up=completed, not carry stale.
    let upFail = true;
    let aggRuns = 0;
    const reg = new NodeRegistry();
    reg.register("up", async () => { if (upFail) throw new Error("up failed"); return { v: 42 }; });
    reg.register("agg", async (_p, ctx) => { aggRuns++; return { saw: ctx.nodes["up"]?.status }; });
    const graph: TaskGraph = {
      id: "always-edge", name: "Always", description: "up --always--> agg",
      nodes: [{ id: "up", type: "up", params: {} }, { id: "agg", type: "agg", params: {} }],
      edges: [{ from: "up", to: "agg", on: "always" }],
    };

    const t1 = await execute(graph, {}, reg, undefined, { correlationId: "a1" });
    const m1 = new Map(t1.nodeResults.map(r => [r.nodeId, r]));
    expect(m1.get("up")!.status).toBe("failed");
    expect(m1.get("agg")!.status).toBe("completed");
    expect((m1.get("agg")!.result as { saw: string }).saw).toBe("failed");
    expect(aggRuns).toBe(1);

    upFail = false;
    const t2 = await execute(graph, {}, reg, undefined, { correlationId: "a1", priorResults: t1.nodeResults });
    const m2 = new Map(t2.nodeResults.map(r => [r.nodeId, r]));
    expect(m2.get("up")!.status).toBe("completed");
    expect(aggRuns).toBe(2); // re-ran (its upstream changed)
    expect((m2.get("agg")!.result as { saw: string }).saw).toBe("completed"); // fresh, not stale
  });

  it("generates a fresh id when no correlationId is supplied (back-compat)", async () => {
    const reg = new NodeRegistry();
    reg.register("ok", async () => ({ ok: true }));
    const graph: TaskGraph = {
      id: "noid", name: "No id", description: "single",
      nodes: [{ id: "a", type: "ok", params: {} }], edges: [],
    };
    const t = await execute(graph, {}, reg);
    expect(t.correlationId).toMatch(/^wf-/);
  });
});
