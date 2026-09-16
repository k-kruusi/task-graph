/**
 * A branch not taken is not work left undone.
 *
 * `allComplete` used to be every-node-completed, so ANY graph with a conditional branch
 * could never report success: the untaken side is always `skipped`, and the happy path
 * settled `partial` forever. That single word cost three separate things in this tree:
 *
 *  - `review-gauntlet` could not gate with an edge condition, because a BLOCKED run and a
 *    benign unfired branch both produced `partial` — indistinguishable. It had to use a
 *    gate that THROWS, and its blocked-branch notify had to be deleted for demoting the
 *    happy path (genesis 8acd0df9, e066258e + 6f60770e).
 *  - `new-session` and `new-session-oriented` exist as two near-identical files rather than
 *    one graph with a conditional anchor, because `POST /workflow` answers ok:false on
 *    partial and the panel then reports "session NOT reset" on a reset that succeeded.
 *  - `web-signal-harvest`'s happy path reported partial, permanently.
 *
 * `partial` now means genuinely unfinished — a node still pending/running/paused/cancelled.
 * These tests pin both halves: a skip does not demote, and a failure still fails.
 */
import { describe, it, expect } from "vitest";
import { execute, NodeRegistry, type TaskGraph } from "../index.js";

function registry(): NodeRegistry {
  const reg = new NodeRegistry();
  reg.register("ok", async () => ({ ok: true }));
  reg.register("boom", async () => { throw new Error("intentional failure"); });
  return reg;
}

/** work → (gate ok) → ship, plus a failure-edge branch that must NOT fire. */
const branching = (workType: string): TaskGraph => ({
  id: "branch",
  name: "branch",
  description: "work succeeds; the failure branch is skipped",
  nodes: [
    { id: "work", type: workType, params: {} },
    { id: "ship", type: "ok", params: {} },
    { id: "recover", type: "ok", params: {} },
  ],
  edges: [
    { from: "work", to: "ship", on: "success" },
    { from: "work", to: "recover", on: "failure" },
  ],
});

describe("skipped nodes do not demote a run", () => {
  it("a successful run whose failure branch was skipped reads COMPLETED, not partial", async () => {
    const trace = await execute(branching("ok"), {}, registry());
    const byId = Object.fromEntries(trace.nodeResults.map(r => [r.nodeId, r.status]));
    expect(byId).toMatchObject({ work: "completed", ship: "completed", recover: "skipped" });
    expect(trace.status).toBe("completed");
  });

  it("a FAILED node still fails the run, even though its downstream skips", async () => {
    const trace = await execute(branching("boom"), {}, registry());
    const byId = Object.fromEntries(trace.nodeResults.map(r => [r.nodeId, r.status]));
    expect(byId).toMatchObject({ work: "failed", ship: "skipped", recover: "completed" });
    expect(trace.status).toBe("failed");
  });

  it("a run where EVERY node ran normally is unaffected", async () => {
    const graph: TaskGraph = {
      id: "linear", name: "linear", description: "a -> b",
      nodes: [{ id: "a", type: "ok", params: {} }, { id: "b", type: "ok", params: {} }],
      edges: [{ from: "a", to: "b" }],
    };
    expect((await execute(graph, {}, registry())).status).toBe("completed");
  });
});
