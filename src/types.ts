export interface NodeMeta {
  package?: string;
  file?: string;
  line?: number;
  description?: string;
}

export interface GraphNode {
  id: string;
  type: string;
  params: Record<string, unknown>;
  meta?: NodeMeta;
  retries?: number;
  timeoutMs?: number;
}

export type EdgeBehavior = "success" | "failure" | "always";

export interface GraphEdge {
  from: string;
  to: string;
  condition?: string;
  on?: EdgeBehavior;
}

export interface TaskGraph {
  id: string;
  name: string;
  description: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /**
   * The output contract (2026-08-05, Kevin): which node's result IS the
   * workflow's answer when a caller wants the result instead of the trace
   * (run_workflow_result). Optional — without it, callers fall back to
   * sole-terminal derivation, exactly as workflow:run does.
   */
  resultNode?: string;
}

export interface NodeResult {
  nodeId: string;
  status: "completed" | "failed" | "skipped" | "timed_out";
  result?: unknown;
  error?: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  attempt: number;
}

/** Full status vocabulary a trace may carry once it leaves this package. */
export type TraceStatus = "completed" | "failed" | "partial" | "cancelled" | "paused";

/**
 * A trace straight out of execute()/executeValidated() — before the supervisor
 * runner stamps operator control-state onto it. Narrowing the engine's return
 * type is what lets callers (runner.ts → store.finish) keep the store's
 * natural-settle argument honest without casts.
 */
export interface EngineExecutionTrace extends ExecutionTrace {
  status: Exclude<TraceStatus, "cancelled" | "paused">;
}

export interface ExecutionTrace {
  workflowId: string;
  correlationId: string;
  /**
   * The ENGINE only ever produces completed|failed|partial — computed purely from
   * recorded node results (executeValidated), so nodes a halt gate stopped are
   * absent from it. The supervisor's WorkflowRunner.execGraph may additionally
   * STAMP "cancelled"/"paused"/"failed" onto the returned trace when operator
   * control-state (cancel/pause/budget) halted dispatch mid-run — without the
   * stamp, such a half-run whose dispatched nodes all completed would read
   * "completed" and a nested workflow:run would surface it as legitimate
   * success (issue #655). Consumers must treat anything but "completed" as
   * not-successful; a stamped trace is resumable under its correlationId.
   */
  status: TraceStatus;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  nodeResults: NodeResult[];
  params: Record<string, unknown>;
}

/**
 * Interpolation scope for `{{run.*}}` inside node params (notify messages, prompts).
 *
 * Available mid-graph (always true while a node is interpolating):
 *   - correlationId — which run this is
 *   - workflowId    — graph.id
 *   - workflowName  — graph.name (Runs-tab label)
 *
 * NOT available (and MUST NOT be added without thought):
 *   - status — at interpolate time the run is still in-flight (the store says
 *     "running" until finish() after the last node). Surfacing that as
 *     `{{run.status}}` would make every agent:notify lie "running" while the
 *     message claims settlement. Terminal status belongs to the POST /workflow
 *     settle notify (`fireNotify`), which runs AFTER finish(). Unresolved
 *     `{{run.status}}` is left literal on purpose so a conductor typo is
 *     visible rather than a confident wrong value (goal-runs-tab residual,
 *     2026-08-09: `status={{run.status}}` leaked; cid resolved).
 */
export interface RunScope {
  correlationId: string;
  workflowId: string;
  workflowName: string;
}

export interface ExecutionContext {
  params: Record<string, unknown>;
  nodes: Record<string, { result?: unknown; error?: string; status: string }>;
  /**
   * Run identity for templates — see RunScope. Handlers also get correlationId
   * via NodeExecMeta; this is the interpolation path for notify/prompt strings.
   */
  run: RunScope;
}

/** Per-execution identity passed to a handler so it can tag side-channels (e.g.
 *  live output) with the run + node it belongs to. Optional 3rd arg — handlers
 *  that don't need it ignore it; the engine always supplies it. */
export interface NodeExecMeta {
  nodeId: string;
  correlationId: string;
}

export type NodeHandler = (
  params: Record<string, unknown>,
  ctx: ExecutionContext,
  meta?: NodeExecMeta,
) => Promise<unknown>;

export interface ExecutionCallbacks {
  onNodeStart?: (nodeId: string, correlationId: string) => void;
  onNodeComplete?: (nodeId: string, correlationId: string, result: NodeResult) => void;
  onNodeFailed?: (nodeId: string, correlationId: string, result: NodeResult) => void;
  /** Fired when an ATTEMPT fails but a retry will follow (attempt < maxAttempts).
   *  Distinct from onNodeFailed, which fires only on the terminal attempt: between
   *  attempts the runner must react NOW — tree-kill the exec child an abandoned
   *  timed-out attempt recorded (its handler keeps running past the deadline; see
   *  withTimeout) and charge the receipt that attempt burned. Without this, the
   *  retry overlaps the abandoned execution and both share the cid:nodeId receipt
   *  slot and per-node child record — the first close clears the SECOND attempt's
   *  orphan-tracking record (issue #654). */
  onNodeAttemptFailed?: (nodeId: string, correlationId: string, result: NodeResult) => void;
  /** Fired when a node is skipped because its incoming edges did not permit it to
   * run (e.g. it sits downstream of a failure). Lets a live observer paint skipped
   * nodes as they happen instead of only reconciling from the final trace. */
  onNodeSkipped?: (nodeId: string, correlationId: string, result: NodeResult) => void;
}

/**
 * Options for execute()/executeValidated().
 *
 * - `correlationId`: caller-supplied run id. Pass this when the id must be known
 *   BEFORE the run finishes (async start + live progress + resume); when omitted a
 *   fresh id is generated, preserving the original behaviour.
 * - `priorResults`: node results from a PREVIOUS run of the SAME graph. Every node
 *   that `completed` in `priorResults` is carried forward — its stored result is
 *   reused and the node is NOT re-executed; dependents interpolate that result.
 *   Everything else (failed / timed_out / skipped / never-run) executes normally.
 *   This is "resume from before the failure": upstream success is reused, the failed
 *   node and its dependents re-run. Only `completed` is carried — a previously
 *   `skipped` node re-evaluates its edges, so once its parent re-runs to success it
 *   now runs too.
 */
export interface ExecuteOptions {
  correlationId?: string;
  priorResults?: NodeResult[];
  /**
   * Dispatch gate, polled immediately before each node would start. Return true to
   * halt: the node is NOT executed and NOT recorded (no callback fires), leaving it
   * eligible for a later resume via `priorResults` carry-forward. Nodes already
   * in flight are unaffected — they drain and record normally. This is how the
   * caller implements pause (graceful: only the gate) and strengthens cancel
   * (gate + abort signal to in-flight handlers).
   */
  halted?: () => boolean;
}
