// batch.ts — concurrent fan-out tool for the code-assist MCP server.
//
// Adds ONE new tool ("code_assist_batch") that runs many bounded tasks in
// parallel in a single call. It deliberately does NOT touch your existing
// single-task tools or reimplement the Workers AI call — you inject your
// existing per-kind executor as `runTask`, so there's one source of truth.
//
// Design contract:
//   - Bounded concurrency (default 6 in-flight) — never an unbounded Promise.all.
//   - Partial results — one task failing never aborts the others.
//   - Per-task timeout — one hung Qwen call can't stall the whole batch return.
//   - Order-preserving, id-correlated results.

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// ---------------------------------------------------------------------------
// Config (env-overridable, sane defaults)
// ---------------------------------------------------------------------------
export interface BatchConfig {
  concurrency: number;   // max tasks in flight at once
  maxTasks: number;      // max tasks accepted per call
  taskTimeoutMs: number; // per-task wall-clock bound
}

export function readBatchConfig(env: Record<string, string | undefined>): BatchConfig {
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
    taskTimeoutMs: int(env.BATCH_TASK_TIMEOUT_MS, 60_000),
  };
}

// ---------------------------------------------------------------------------
// Task contract — reuse your EXISTING single-task executor here.
// If your current handlers don't accept an AbortSignal, just ignore the arg;
// withTimeout() still bounds wall-clock via the race below.
// ---------------------------------------------------------------------------
export const BatchTaskSchema = z.object({
  id: z
    .string()
    .optional()
    .describe("Optional caller id echoed back so you can correlate results. Defaults to the array index."),
  kind: z
    .enum(["generate-tests", "scaffold", "transform", "generate-code", "fix-bug"])
    .describe("Which bounded code-assist operation to run. Mirror your single-task tool kinds here."),
  input: z
    .record(z.unknown())
    .describe("Operation-specific payload — same shape as the matching single-task tool's input."),
});
export type BatchTask = z.infer<typeof BatchTaskSchema>;

export type RunTask = (task: BatchTask, signal: AbortSignal) => Promise<unknown>;

const TaskResultSchema = z.discriminatedUnion("status", [
  z.object({
    id: z.string(),
    index: z.number().int(),
    kind: z.string(),
    status: z.literal("ok"),
    result: z.unknown(),
  }),
  z.object({
    id: z.string(),
    index: z.number().int(),
    kind: z.string(),
    status: z.literal("error"),
    error: z.string(),
  }),
]);

// Raw shapes (the TS SDK's registerTool wants ZodRawShape, not z.object()).
export const BatchInputShape = {
  tasks: z
    .array(BatchTaskSchema)
    .min(1)
    .describe("Bounded tasks to run concurrently. Each runs independently; failures are reported per-task, never aborting the batch."),
};

export const BatchOutputShape = {
  total: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  results: z.array(TaskResultSchema),
};

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
export async function executeBatch(tasks: BatchTask[], cfg: BatchConfig, runTask: RunTask) {
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
// MCP tool registration
// ---------------------------------------------------------------------------
export function registerBatchTool(
  server: McpServer,
  deps: { runTask: RunTask; env: Record<string, string | undefined> },
) {
  const cfg = readBatchConfig(deps.env);

  server.registerTool(
    "code_assist_batch",
    {
      title: "Code-assist batch",
      description:
        "Run many BOUNDED code-assist tasks concurrently in one call. " +
        "Use for fan-out of independent, machine-verifiable work (test generation, " +
        "scaffolding, mechanical transforms) where issuing N separate tool calls " +
        `would be slow. Tasks run in parallel (up to ${cfg.concurrency} in flight); ` +
        "one task failing never aborts the others — failures come back as " +
        "{status:'error'} entries you can re-issue. Max " + cfg.maxTasks +
        " tasks per call. Prefer the single-task tools for one-offs (a batch " +
        "round-trip isn't worth it for a single trivial edit).",
      inputSchema: BatchInputShape,
      outputSchema: BatchOutputShape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ tasks }) => {
      const summary = await executeBatch(tasks, cfg, deps.runTask);
      return {
        structuredContent: summary,
        content: [
          {
            type: "text",
            text:
              `Batch complete: ${summary.succeeded}/${summary.total} ok, ` +
              `${summary.failed} failed.` +
              (summary.failed
                ? " Failed task ids: " +
                  summary.results.filter((r) => r.status === "error").map((r) => r.id).join(", ")
                : ""),
          },
        ],
      };
    },
  );
}

// ---------------------------------------------------------------------------
// WIRING (example) — paste into your server setup, then delete this block.
// Map each kind to the SAME function your existing single-task tool calls.
// ---------------------------------------------------------------------------
//
// const runTask: RunTask = async (task, signal) => {
//   switch (task.kind) {
//     case "generate-tests": return runGenerateTests(task.input, signal);
//     case "scaffold":       return runScaffold(task.input, signal);
//     case "transform":      return runTransform(task.input, signal);
//     case "generate-code":  return runGenerateCode(task.input, signal);
//     case "fix-bug":        return runFixBug(task.input, signal);
//   }
// };
//
// registerBatchTool(server, { runTask, env });
