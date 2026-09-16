import type {
  TaskGraph,
  GraphEdge,
  ExecutionContext,
  EngineExecutionTrace,
  NodeResult,
  ExecutionCallbacks,
  ExecuteOptions,
} from "./types.js";
import type { NodeRegistry } from "./registry.js";
import { validate, type ValidatedGraph } from "./graph.js";
import { interpolate } from "./template.js";
import type { CompiledCondition } from "./condition.js";

const DEFAULT_TIMEOUT_MS = 30_000;

function generateId(): string {
  return `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function edgeBehavior(edge: GraphEdge): "success" | "failure" | "always" {
  return edge.on || "success";
}

export async function execute(
  graph: TaskGraph,
  params: Record<string, unknown>,
  registry: NodeRegistry,
  callbacks?: ExecutionCallbacks,
  opts?: ExecuteOptions,
): Promise<EngineExecutionTrace> {
  const validated = validate(graph);
  return executeValidated(validated, params, registry, callbacks, opts);
}

export async function executeValidated(
  validated: ValidatedGraph,
  params: Record<string, unknown>,
  registry: NodeRegistry,
  callbacks?: ExecutionCallbacks,
  opts?: ExecuteOptions,
): Promise<EngineExecutionTrace> {
  const { graph, levels, compiledConditions } = validated;
  const correlationId = opts?.correlationId ?? generateId();
  const traceStart = Date.now();

  // Resume support: nodes that COMPLETED in a prior run can be carried forward —
  // their result reused, the node not re-executed. Candidates are the completed
  // prior results; the ancestry fixpoint below narrows them to the ones it's
  // actually SOUND to reuse. See ExecuteOptions.
  const priorCompleted = new Map<string, NodeResult>();
  for (const r of opts?.priorResults ?? []) {
    if (r.status === "completed") priorCompleted.set(r.nodeId, r);
  }

  const nodeMap = new Map(graph.nodes.map(n => [n.id, n]));
  const incomingEdges = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    const list = incomingEdges.get(edge.to) || [];
    list.push(edge);
    incomingEdges.set(edge.to, list);
  }

  // Carry-forward soundness: only reuse a completed node if its ENTIRE upstream
  // is also carried forward. If any parent is being re-run (it failed/skipped
  // last run, or is dropped here), this node's inputs may differ, so it must
  // re-run too — re-evaluating its edges. Otherwise an on:"failure"/on:"always"
  // node downstream of a re-run parent would keep a STALE "completed" (a failure
  // branch that no longer fires; an aggregator that never sees the new result).
  // Iterate to a fixpoint: dropping a parent cascades to its carried children.
  let droppedAny = true;
  while (droppedAny) {
    droppedAny = false;
    for (const nodeId of [...priorCompleted.keys()]) {
      const incoming = incomingEdges.get(nodeId) || [];
      if (incoming.some(e => !priorCompleted.has(e.from))) {
        priorCompleted.delete(nodeId);
        droppedAny = true;
      }
    }
  }

  const ctx: ExecutionContext = {
    params,
    nodes: {},
    run: {
      correlationId,
      // graph.id / graph.name are mandatory on the envelope; never blank in scope
      // so a template that names the run can resolve both axes (id + Runs label).
      workflowId: graph.id,
      workflowName: graph.name,
    },
  };
  const nodeResults: NodeResult[] = [];

  for (const level of levels) {
    const tasks = level.map(async (nodeId) => {
      // Halted (paused/cancelled): don't dispatch, don't record — an unrecorded node
      // reads as never-run to the resume carry-forward, so it re-runs on resume.
      // Checked per node (not per level) so a pause landing mid-level still stops
      // the sibling nodes that haven't started yet.
      if (opts?.halted?.()) return;

      const node = nodeMap.get(nodeId)!;

      // Resume: a completed prior node whose full ancestry is also carried (per
      // the fixpoint above) is reused, not re-executed. Seed ctx so dependents
      // interpolate its stored result and shouldRun sees it completed. No callback
      // fires — it did not run THIS time (the store pre-seeds these on resume).
      const prior = priorCompleted.get(nodeId);
      if (prior) {
        ctx.nodes[nodeId] = { result: prior.result, status: "completed" };
        nodeResults.push(prior);
        return;
      }

      const incoming = incomingEdges.get(nodeId) || [];

      // Check if this node should run based on incoming edges
      if (incoming.length > 0 && !shouldRun(incoming, ctx, compiledConditions)) {
        const skipped: NodeResult = {
          nodeId,
          status: "skipped",
          startedAt: Date.now(),
          completedAt: Date.now(),
          durationMs: 0,
          attempt: 0,
        };
        ctx.nodes[nodeId] = { status: "skipped" };
        nodeResults.push(skipped);
        callbacks?.onNodeSkipped?.(nodeId, correlationId, skipped);
        return;
      }

      const handler = registry.get(node.type);
      if (!handler) {
        const failed: NodeResult = {
          nodeId,
          status: "failed",
          error: `No handler registered for node type: "${node.type}"`,
          startedAt: Date.now(),
          completedAt: Date.now(),
          durationMs: 0,
          attempt: 0,
        };
        ctx.nodes[nodeId] = { status: "failed", error: failed.error };
        nodeResults.push(failed);
        callbacks?.onNodeFailed?.(nodeId, correlationId, failed);
        return;
      }

      const maxAttempts = (node.retries ?? 0) + 1;
      const timeoutMs = node.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const resolvedParams = interpolate(node.params, ctx as unknown as Record<string, unknown>);

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const start = Date.now();
        callbacks?.onNodeStart?.(nodeId, correlationId);

        // Hold the raw promise: on a timed-out attempt withTimeout rejects at the
        // deadline but THIS keeps running — it must settle before the retry starts.
        const attemptPromise = handler(resolvedParams, ctx, { nodeId, correlationId });
        try {
          const result = await withTimeout(
            attemptPromise,
            timeoutMs,
            nodeId,
          );
          const end = Date.now();
          const nodeResult: NodeResult = {
            nodeId,
            status: "completed",
            result,
            startedAt: start,
            completedAt: end,
            durationMs: end - start,
            attempt,
          };
          ctx.nodes[nodeId] = { result, status: "completed" };
          nodeResults.push(nodeResult);
          callbacks?.onNodeComplete?.(nodeId, correlationId, nodeResult);
          return;
        } catch (err) {
          const end = Date.now();
          const isTimeout = err instanceof TimeoutError;
          if (attempt === maxAttempts) {
            const nodeResult: NodeResult = {
              nodeId,
              status: isTimeout ? "timed_out" : "failed",
              error: err instanceof Error ? err.message : String(err),
              startedAt: start,
              completedAt: end,
              durationMs: end - start,
              attempt,
            };
            ctx.nodes[nodeId] = { status: nodeResult.status, error: nodeResult.error };
            nodeResults.push(nodeResult);
            callbacks?.onNodeFailed?.(nodeId, correlationId, nodeResult);
            return;
          }
          // Intermediate failure — a retry follows. Fire attempt-failed NOW so the
          // runner can kill this attempt's tracked exec child and charge its burned
          // receipt BEFORE the next attempt records its own under the same
          // ${cid}:${nodeId} slots (issue #654: between attempts nothing was killed
          // or logged). Then settle the abandoned execution before dispatching the
          // retry: two concurrent executions of one node share those slots, and the
          // first child's clearChild would delete the SECOND's orphan-tracking
          // record. Process-backed handlers settle fast (their child was just
          // killed); the wait is bounded by one more timeout window so a handler
          // that never settles delays the retry by the grace, not forever.
          // Attaching these settlement handlers also swallows the loser's late
          // rejection — withTimeout already rejected our await, so a later failure
          // of the abandoned work must not surface as unhandledRejection.
          callbacks?.onNodeAttemptFailed?.(nodeId, correlationId, {
            nodeId,
            status: isTimeout ? "timed_out" : "failed",
            error: err instanceof Error ? err.message : String(err),
            startedAt: start,
            completedAt: end,
            durationMs: end - start,
            attempt,
          });
          await new Promise<void>((resolve) => {
            const grace = setTimeout(resolve, timeoutMs);
            attemptPromise.then(
              () => { clearTimeout(grace); resolve(); },
              () => { clearTimeout(grace); resolve(); },
            );
          });
        }
      }
    });

    await Promise.all(tasks);
  }

  const traceEnd = Date.now();
  const hasFailure = nodeResults.some(r => r.status === "failed" || r.status === "timed_out");
  // A SKIPPED node is a branch that was not taken, not work left undone — so it does not
  // demote the run. `allComplete` used to mean every-node-completed, which made a graph
  // with any conditional branch permanently unable to report success: the untaken side is
  // always skipped, so the happy path settled "partial" forever.
  //
  // That cost real things. `review-gauntlet` could not gate with an edge condition, because
  // a BLOCKED run and a benign unfired branch both produced "partial" — indistinguishable —
  // which is why its blocked-branch notify had to be deleted and the gate had to be one that
  // THROWS (genesis 8acd0df9, commits e066258e + 6f60770e). `new-session` and
  // `new-session-oriented` exist as two near-identical files for the same reason: a
  // conditional anchor would skip the unused node, `POST /workflow` answers ok:false on
  // partial, and the panel then reports "session NOT reset" on a reset that succeeded
  // (src/__tests__/new-session-definitions.test.ts explains the duplication as the cheaper
  // evil). And `web-signal-harvest`'s happy path has always reported partial.
  //
  // `partial` now means what it says: a node is still pending/running/paused/cancelled —
  // genuinely unfinished. A failure is still `failed`, because a failed node is neither
  // completed nor skipped and `hasFailure` is checked next.
  const allComplete = nodeResults.every(r => r.status === "completed" || r.status === "skipped");

  return {
    workflowId: graph.id,
    correlationId,
    status: allComplete ? "completed" : hasFailure ? "failed" : "partial",
    startedAt: traceStart,
    completedAt: traceEnd,
    durationMs: traceEnd - traceStart,
    nodeResults,
    params,
  };
}

function shouldRun(
  incoming: GraphEdge[],
  ctx: ExecutionContext,
  compiled: Map<string, CompiledCondition>,
): boolean {
  for (const edge of incoming) {
    const parentStatus = ctx.nodes[edge.from]?.status;
    const behavior = edgeBehavior(edge);

    // Check edge behavior against parent status
    if (behavior === "success" && parentStatus !== "completed") return false;
    if (behavior === "failure" && parentStatus !== "failed" && parentStatus !== "timed_out") return false;
    // "always" runs regardless of parent status (but parent must have executed)
    if (behavior === "always" && !parentStatus) return false;

    // Check compiled condition
    const key = `${edge.from}->${edge.to}`;
    const condition = compiled.get(key);
    if (condition && !condition(ctx as unknown as Record<string, unknown>)) return false;
  }
  return true;
}

class TimeoutError extends Error {
  constructor(nodeId: string, timeoutMs: number) {
    super(`Node "${nodeId}" timed out after ${timeoutMs}ms`);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, nodeId: string): Promise<T> {
  if (ms <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(nodeId, ms)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}
