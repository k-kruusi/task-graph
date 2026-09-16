# @agentruntime/task-graph

A small, dependency-free **DAG-based workflow engine** for composable, inspectable
multi-step operations.

You describe a workflow as a `TaskGraph` — a set of typed `nodes` and the `edges`
between them — register a handler for each node `type`, and call `execute()`. The
engine topologically sorts the graph, runs each level in parallel, threads results
from one node into the next via template interpolation, gates downstream nodes on
upstream success/failure/conditions, and returns a single auditable
`ExecutionTrace`.

This is a **pure library** in `dependencies/`: it is imported by other packages via
a `file:` path and is never spawned as a cartridge. It has no MCP server, no event
bus integration, no I/O, and no internal dependencies — the *policy* (what runs,
what gates) lives in the graph definition; this package is just the *engine*.

## Install / wire up

It's consumed via a `file:` path, e.g. from the monorepo root `package.json`:

```json
"@agentruntime/task-graph": "file:./dependencies/task-graph"
```

Then build it (TypeScript → `dist/`):

```bash
cd dependencies/task-graph && npm install && npm run build
```

## The model

- **Node** — one step. Has a stable `id`, a `type` (the key the registry dispatches
  on), and a `params` object. Optionally `retries`, `timeoutMs`, and `meta`.
- **Edge** — a directed dependency `from` → `to`. Optionally an `on` behavior
  (`"success"` | `"failure"` | `"always"`) and a string `condition`.
- **Registry** — maps a node `type` string to a handler
  `(params, ctx) => Promise<result>`. Many nodes can share one type.
- **Execution** — nodes are grouped into levels by a topological sort (cycles throw).
  Each level runs concurrently (`Promise.all`); levels run in order. A node runs
  only if **all** of its incoming edges permit it (see "Gating" below); otherwise it
  is `skipped`.
- **Trace** — `execute` returns an `ExecutionTrace`: per-node status/result/timing
  plus an overall `status` (`completed` / `failed` / `partial`) and a generated
  `correlationId`. Nothing is persisted by the library — the caller owns that.

### Context and data flow

Each handler receives an `ExecutionContext`:

```ts
{
  params: Record<string, unknown>,                 // the top-level params passed to execute()
  nodes: Record<string, { result?, error?, status }> // results of nodes that have run so far
}
```

A node's `params` are **interpolated** against this context just before the handler
runs, using `{{...}}` templates:

- `{{params.agent}}` — pulls from the top-level params.
- `{{nodes.a.result.value}}` — pulls a prior node's output.
- A string that is **entirely** one template (`"{{nodes.a.result}}"`) is replaced by
  the **raw value** (type preserved — object/number/boolean, not stringified).
- A template embedded in a larger string is stringified in place.
- An unresolved template is left literally as `{{...}}` (it is not erased).

### Gating: which nodes run

For a node with incoming edges, it runs only if **every** incoming edge passes:

| `edge.on`   | Runs when the parent (`from`) node finished as… |
|-------------|--------------------------------------------------|
| `"success"` (default) | `completed`                              |
| `"failure"` | `failed` **or** `timed_out`                      |
| `"always"`  | any terminal status (parent must have executed)  |

If the edge also has a `condition`, that boolean expression must evaluate truthy
against the context (see "Conditions"). A node that fails its gate is recorded as
`skipped` (which then propagates: its `"success"` children skip too).

### Retries and timeouts

- `node.retries` — extra attempts after the first (default `0`, so one attempt).
- `node.timeoutMs` — per-attempt timeout (default `30000`; `<= 0` disables it). A
  timeout produces status `timed_out`.

The recorded `attempt` is the attempt number that produced the final result.

## Public API

Everything is re-exported from the package root (`@agentruntime/task-graph`).

### Types (`./types.ts`)

```ts
interface GraphNode  { id; type; params; meta?; retries?; timeoutMs?; }
interface GraphEdge  { from; to; condition?; on?: EdgeBehavior; }
type     EdgeBehavior = "success" | "failure" | "always";
interface NodeMeta   { package?; file?; line?; description?; }   // provenance only
interface TaskGraph  { id; name; description; nodes; edges; }

interface NodeResult       { nodeId; status; result?; error?; startedAt; completedAt; durationMs; attempt; }
                            // status: "completed" | "failed" | "skipped" | "timed_out"
interface ExecutionTrace   { workflowId; correlationId; status; startedAt; completedAt; durationMs; nodeResults; params; }
                            // status: "completed" | "failed" | "partial"
interface ExecutionContext { params; nodes; }
type      NodeHandler        = (params, ctx) => Promise<unknown>;
interface ExecutionCallbacks { onNodeStart?; onNodeComplete?; onNodeFailed?; }
```

### Functions / classes

| Export | From | What it does |
|--------|------|--------------|
| `execute(graph, params, registry, callbacks?)` | `execute.ts` | Validate + run a graph; returns `Promise<ExecutionTrace>`. |
| `executeValidated(validated, params, registry, callbacks?)` | `execute.ts` | Run an already-validated graph (skip re-validation; reuses compiled conditions). |
| `validate(graph)` | `graph.ts` | Check edge endpoints, compile conditions, topo-sort into `levels`. Throws on unknown nodes or cycles. Returns `ValidatedGraph` (`{ graph, levels, compiledConditions }`). |
| `GraphBuilder` | `graph.ts` | Fluent builder: `new GraphBuilder(id, name, desc).addNode(...).addEdge(...).build()`. |
| `NodeRegistry` | `registry.ts` | `register(type, handler)`, `get`, `has`, `types()`. |
| `compileCondition(expr)` | `condition.ts` | Compile a condition string into `CompiledCondition = (scope) => boolean`. |
| `interpolate(params, scope)` | `template.ts` | Resolve `{{...}}` templates in a params object against a scope. |
| `merge`, `insertBefore`, `insertAfter`, `removeNode` | `compose.ts` | Pure graph-transform helpers (see below). |

### Conditions (`condition.ts`)

`condition` strings are evaluated by a tiny, **safe hand-written parser** — *not*
`eval`. Supported grammar:

- Paths: `nodes.a.result.go`, `params.flag` (dotted lookups against the context).
- Literals: `true`, `false`, `null`, `undefined`, numbers, `"..."`/`'...'` strings.
- Operators: `===`, `!==`, `&&`, `||`, unary `!`, and parentheses `( )`.

Example: `nodes.grade.result.passed === true && params.gate !== false`.
Any unsupported character throws at compile time.

### Composition helpers (`compose.ts`)

Pure functions that return a **new** `TaskGraph`:

- `merge(a, b, connecting?)` — union two graphs (throws on node-id collision),
  optionally adding `connecting` edges between them.
- `insertBefore(graph, targetId, newNode)` / `insertAfter(graph, targetId, newNode)`
  — splice a node into the existing edge wiring around a target.
- `removeNode(graph, nodeId)` — drop a node and bridge its incoming edges directly to
  its outgoing edges (preserving the incoming edge's `on` behavior).

## Minimal example

```ts
import { execute, NodeRegistry, type TaskGraph } from "@agentruntime/task-graph";

const registry = new NodeRegistry();
registry.register("echo", async (params) => params);

const graph: TaskGraph = {
  id: "demo",
  name: "Demo",
  description: "A -> B, B only runs if A said go",
  nodes: [
    { id: "a", type: "echo", params: { go: true } },
    { id: "b", type: "echo", params: { greeting: "hi {{params.agent}}" } },
  ],
  edges: [
    { from: "a", to: "b", condition: "nodes.a.result.go === true" },
  ],
};

const trace = await execute(graph, { agent: "claude" }, registry);
// trace.status === "completed"
// trace.nodeResults[1].result === { greeting: "hi claude" }
```

## Who consumes it

Two production consumers in this repo, both following the same shape — build a
`NodeRegistry`, load a `TaskGraph` JSON definition, `execute`, then best-effort POST
the returned trace to `memory-mcp` `/traces`:

- **Supervisor workflows** — `src/workflows/runner.ts` (`WorkflowRunner`). Loads all
  `src/workflows/definitions/*.json`, registers supervisor handlers
  (`src/workflows/handlers.ts`), and runs them via the `/workflow` command. Wires
  the `ExecutionCallbacks` into the supervisor logger.
- **Circulation beat** — `packages/circulation/src/runner.ts`. The genome
  self-improvement "beat" expressed as a graded DAG (`definitions/genome-beat.json`),
  with node types `organ:run` and `grade:verify`. The package README there is
  explicit that circulation is a task-graph **consumer, not a fork** — gating policy
  lives in the graph's edges, not in code.

The `file:` dependency is declared in the monorepo root `package.json`
(`"@agentruntime/task-graph": "file:./dependencies/task-graph"`); circulation
resolves it through `scripts/build-deps.mjs`.

## Testing

```bash
cd dependencies/task-graph && npm test     # vitest
```

Tests live in `src/__tests__/` and cover execution (linear/parallel order, failure
skipping, `always` edges, conditions, interpolation, timeouts, cycle detection),
condition compilation, and template interpolation.

## Notes / boundaries

- **No persistence, no logging, no network.** `execute` just returns the trace; the
  caller decides what to do with it. (The library intentionally has no logger — see
  the consumers' `persistTrace` for the best-effort audit pattern.)
- **No dynamic/streaming graph mutation at runtime.** The graph is fixed for a run;
  use `compose.ts` to build/alter graphs *before* executing.
- **Parallelism is per-level only**, bounded by the topo-sort. There is no global
  concurrency limit — every node at the same depth starts at once.
- A handler error on the final attempt is captured into the node's `error` string;
  it does not reject the overall `execute` promise. Only `validate` (unknown node /
  cycle) throws.
</content>
</invoke>
