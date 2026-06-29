// batch.ts — pure, env-free batch engine for the code-assist MCP server.
//
// Exports a bounded concurrent fan-out engine that runs many tasks in parallel
// with hard in-flight cap, per-task wall-clock timeout, order-preserving
// results, and failure isolation. No AI bindings, no env dependency, no Zod.
//
// Design contract:
//   - Bounded concurrency (default 6 in-flight) — never an unbounded Promise.all.
//   - Partial results — one task failing never aborts the others.
//   - Per-task timeout — one hung task can't stall the whole batch return.
//   - Order-preserving, id-correlated results.
//
// Phase 7 wires this to the MCP tool registration and Zod schemas.
// Phase 6 delivers the pure engine only.

import type { TaskKind, ModelTier } from "./index";

// ---------------------------------------------------------------------------
// Config (env-overridable, sane defaults)
// ---------------------------------------------------------------------------
interface BatchConfig {
  concurrency: number;   // max tasks in flight at once
  maxTasks: number;      // max tasks accepted per call
  taskTimeoutMs: number; // per-task wall-clock bound
}

function readBatchConfig(env: Record<string, string | undefined>): BatchConfig {
  const int = (v: string | undefined, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
  };
  return {
    // 6 in-flight: ~6x over sequential while staying clear of Workers AI 429s.
    concurrency: int(env.BATCH_CONCURRENCY, 6),
    // 50 keeps you under the Workers subrequest limit on ANY plan (free=50,
    // paid=1000). Each Workers AI call is one subrequest. Raise only on paid.
    maxTasks: int(env.BATCH_MAX_TASKS, 50),
    // 45000 = AI_TIMEOUT_MS — matches callModel's internal abort deadline.
    taskTimeoutMs: int(env.BATCH_TASK_TIMEOUT_MS, 45_000),
  };
}

// ---------------------------------------------------------------------------
// Task contract — reuse your EXISTING single-task executor here.
// If your current handlers don't accept an AbortSignal, just ignore the arg;
// withTimeout() still bounds wall-clock via the race below.
// ---------------------------------------------------------------------------
interface BatchTask {
  id?: string;
  kind: TaskKind;
  input: Record<string, unknown>;
  tier?: ModelTier;
}

type RunTask = (task: BatchTask, signal: AbortSignal) => Promise<unknown>;

type TaskResultOk = {
  id: string;
  index: number;
  kind: TaskKind;
  status: "ok";
  result: unknown;
};

type TaskResultError = {
  id: string;
  index: number;
  kind: TaskKind;
  status: "error";
  error: string;
};

type TaskResult = TaskResultOk | TaskResultError;

// ---------------------------------------------------------------------------
// Concurrency pool — a fixed set of workers pull from a shared cursor.
// Order-preserving (writes into results[i]), bounded at `limit` in flight.
// ---------------------------------------------------------------------------
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}

// Bounds wall-clock even if runTask ignores the AbortSignal. The abort() is
// best-effort cancellation; the rejection is the guarantee the batch returns.
// The two-handler .then(onResolve, onReject) form is mandatory: it means a
// late-settling orphaned promise hits an already-settled Promise → no
// double-settle, no unhandled rejection.
function withTimeout<R>(ms: number, run: (signal: AbortSignal) => Promise<R>): Promise<R> {
  const ctrl = new AbortController();
  return new Promise<R>((resolve, reject) => {
    const timer = setTimeout(() => {
      ctrl.abort();
      reject(new Error(`Task exceeded ${ms}ms timeout`));
    }, ms);
    run(ctrl.signal).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// ---------------------------------------------------------------------------
// Core: run the batch. Importable standalone for unit tests.
// ---------------------------------------------------------------------------
async function executeBatch(tasks: BatchTask[], cfg: BatchConfig, runTask: RunTask) {
  if (tasks.length > cfg.maxTasks) {
    throw new Error(
      `Batch has ${tasks.length} tasks but the per-call limit is ${cfg.maxTasks}. ` +
        `Split it into smaller batches. (Raise BATCH_MAX_TASKS only if your Workers ` +
        `plan's subrequest budget allows — each task is one subrequest.)`,
    );
  }

  const results = await mapWithConcurrency(tasks, cfg.concurrency, async (task, index) => {
    const id = task.id ?? String(index);
    try {
      const result = await withTimeout(cfg.taskTimeoutMs, (signal) => runTask(task, signal));
      return { id, index, kind: task.kind, status: "ok" as const, result };
    } catch (err) {
      return {
        id,
        index,
        kind: task.kind,
        status: "error" as const,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  const failed = results.filter((r) => r.status === "error").length;
  return { total: results.length, succeeded: results.length - failed, failed, results };
}

// ---------------------------------------------------------------------------
// Named exports — follows the src/index.ts grouped export convention
// ---------------------------------------------------------------------------
export { executeBatch, mapWithConcurrency, withTimeout, readBatchConfig };
export type { BatchConfig, BatchTask, RunTask, TaskResult };
