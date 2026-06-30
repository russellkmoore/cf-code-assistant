# Phase 6: Batch Core + Bounded Pool + Timeout - Pattern Map

**Mapped:** 2026-06-26
**Files analyzed:** 2 (1 new module, 1 new test file)
**Analogs found:** 2 / 2

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/batch.ts` | service/utility | batch, event-driven | `.planning/batch.ts` | exact (direct design template) |
| `src/__tests__/batch.test.ts` | test | batch | `src/__tests__/runtask.test.ts` | role-match (same project, same vitest setup, same import-from-src pattern; batch tests need no Worker env where runtask.test.ts does) |

---

## Pattern Assignments

### `src/batch.ts` (service/utility, batch)

**Analog:** `.planning/batch.ts`

**Key adaptation delta (must differ from analog):**
- Drop `import { z } from "zod"` and all Zod schemas (`BatchTaskSchema`, `BatchInputShape`, `BatchOutputShape`, `TaskResultSchema`) — plain TS types only in Phase 6
- Drop `registerBatchTool` and `import type { McpServer }` — Phase 7 concern
- Change `taskTimeoutMs` default: `60_000` → `45_000` (D-01)
- Replace the 5-value placeholder `kind` enum with `import type { TaskKind } from "./index"` and use it on `BatchTask.kind` (D-03c)
- Emit concrete-typed discriminated union for `TaskResult` as hand-written TS types (D-03)

---

**Imports pattern** — what to keep from analog (`.planning/batch.ts` lines 1-17), stripped of Zod:

```typescript
// src/batch.ts — NO zod import, NO McpServer import
import type { TaskKind } from "./index";
```

**Type declarations pattern** — plain TS replacing the Zod-derived types (`.planning/batch.ts` lines 20-60, adapted):

```typescript
export interface BatchConfig {
  concurrency: number;   // max tasks in flight at once
  maxTasks: number;      // max tasks accepted per call
  taskTimeoutMs: number; // per-task wall-clock bound
}

export interface BatchTask {
  id?: string;
  kind: TaskKind;                   // real 11-kind union from Phase 5 — NOT the 5-value placeholder
  input: Record<string, unknown>;
}

export type RunTask = (task: BatchTask, signal: AbortSignal) => Promise<unknown>;

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

export type TaskResult = TaskResultOk | TaskResultError;
```

**`readBatchConfig` pattern** — copy from analog (`.planning/batch.ts` lines 26-39), change only the timeout default:

```typescript
// Source: .planning/batch.ts lines 26-39 — adapt default 60_000 → 45_000
export function readBatchConfig(env: Record<string, string | undefined>): BatchConfig {
  const int = (v: string | undefined, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : d;
  };
  return {
    concurrency:    int(env.BATCH_CONCURRENCY,       6),
    maxTasks:       int(env.BATCH_MAX_TASKS,         50),
    taskTimeoutMs:  int(env.BATCH_TASK_TIMEOUT_MS,   45_000),  // D-01: 45000, NOT 60000
  };
}
```

**`mapWithConcurrency` pattern** — copy verbatim from analog (`.planning/batch.ts` lines 98-115):

```typescript
// Source: .planning/batch.ts lines 98-115 — copy unchanged
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
```

**`withTimeout` pattern** — copy verbatim from analog (`.planning/batch.ts` lines 119-131); the two-handler form is load-bearing:

```typescript
// Source: .planning/batch.ts lines 119-131 — copy unchanged; DO NOT refactor to .then().catch()
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
```

**`executeBatch` core pattern** — copy from analog (`.planning/batch.ts` lines 136-163); types change to use `BatchTask` and `TaskResult`:

```typescript
// Source: .planning/batch.ts lines 136-163 — copy, update signature to typed BatchTask
export async function executeBatch(
  tasks: BatchTask[],
  cfg: BatchConfig,
  runTask: RunTask,
): Promise<{ total: number; succeeded: number; failed: number; results: TaskResult[] }> {
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
```

**Named-export pattern** — follow `src/index.ts` line 871 convention (grouped named exports at file end):

```typescript
// Source: src/index.ts line 871 — same named-export grouping at end of file
export { executeBatch, mapWithConcurrency, withTimeout, readBatchConfig };
export type { BatchConfig, BatchTask, RunTask, TaskResult };
```

---

### `src/__tests__/batch.test.ts` (test, batch)

**Analog:** `src/__tests__/runtask.test.ts`

**Key differences from analog:**
- No `createMockEnv` needed — batch tests are env-free; inject a plain fake `runTask` function directly
- No `createMcpServer` / `_registeredTools` access — test `executeBatch`, `mapWithConcurrency`, `withTimeout`, `readBatchConfig` as named exports directly
- Four headline test shapes (in-flight counter, zero-dispatch spy, inverted-duration order, late-settle) use real short timeouts (10ms) rather than `vi.useFakeTimers()` — avoids cloudflarePool + fake-timer interaction risk

**Imports pattern** — copy from `src/__tests__/runtask.test.ts` lines 1-3, strip unused imports:

```typescript
// Source: src/__tests__/runtask.test.ts lines 1-3
import { describe, it, expect, vi } from "vitest";
import {
  executeBatch,
  mapWithConcurrency,
  withTimeout,
  readBatchConfig,
} from "../batch";
import type { BatchTask, BatchConfig, RunTask } from "../batch";
```

**`vi.fn()` spy pattern** — copy from `src/__tests__/tool-handlers.test.ts` lines 33-35:

```typescript
// Source: src/__tests__/tool-handlers.test.ts lines 33-35
const spy = vi.fn();
// ...
expect(spy).not.toHaveBeenCalled();
// or:
expect(spy).toHaveBeenCalledTimes(N);
```

**Describe/it test structure** — copy from `src/__tests__/runtask.test.ts` lines 22-25:

```typescript
// Source: src/__tests__/runtask.test.ts lines 22-25
describe("BATCH-03: bounded pool", () => {
  it("peak in-flight count never exceeds concurrency cap", async () => {
    // ...
  });
});
```

**Test Shape 1 — In-flight cap counter (BATCH-03):**

```typescript
// Anchored on: CONTEXT.md D-04a; test shape from 06-RESEARCH.md Code Examples
describe("BATCH-03: bounded pool", () => {
  it("peak in-flight count never exceeds concurrency cap", async () => {
    let inFlight = 0;
    let peakInFlight = 0;
    const resolvers: Array<() => void> = [];

    const runTask: RunTask = (_task, _signal) =>
      new Promise<unknown>((resolve) => {
        inFlight++;
        peakInFlight = Math.max(peakInFlight, inFlight);
        resolvers.push(() => { inFlight--; resolve("ok"); });
      });

    const tasks = Array.from({ length: 10 }, (_, i) => ({
      id: String(i),
      kind: "quickTask" as BatchTask["kind"],
      input: { instruction: "x" },
    }));

    const batchPromise = executeBatch(
      tasks,
      { concurrency: 3, maxTasks: 50, taskTimeoutMs: 5000 },
      runTask,
    );

    // Drain resolvers in batches to allow the pool to fill and be measured
    await new Promise(r => setTimeout(r, 0)); // flush microtasks
    expect(peakInFlight).toBeLessThanOrEqual(3);
    resolvers.forEach(fn => fn());
    await batchPromise;
    expect(peakInFlight).toBeLessThanOrEqual(3);
  });
});
```

**Test Shape 2 — Zero-dispatch spy on over-cap (BATCH-04):**

```typescript
// Anchored on: CONTEXT.md D-04b; 06-RESEARCH.md Code Examples
describe("BATCH-04: fast cap", () => {
  it("rejects before any runTask call when tasks.length > maxTasks", async () => {
    const spy = vi.fn();
    const tasks = Array.from({ length: 51 }, (_, i) => ({
      id: String(i),
      kind: "quickTask" as BatchTask["kind"],
      input: { instruction: "x" },
    }));
    await expect(
      executeBatch(tasks, { concurrency: 6, maxTasks: 50, taskTimeoutMs: 45_000 }, spy as unknown as RunTask),
    ).rejects.toThrow(/split/i);
    expect(spy).not.toHaveBeenCalled();
  });
});
```

**Test Shape 3 — Order preservation + failure isolation (BATCH-06):**

```typescript
// Anchored on: CONTEXT.md D-04c — inverted durations; 06-RESEARCH.md Code Examples
describe("BATCH-06: order + failure isolation", () => {
  it("results[i].index === i with inverted durations; one error does not abort siblings", async () => {
    const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
    const tasks: BatchTask[] = [
      { id: "slow", kind: "quickTask", input: {} },
      { id: "fast", kind: "quickTask", input: {} },
      { id: "fail", kind: "quickTask", input: {} },
    ];
    const runTask: RunTask = async (task, _signal) => {
      if (task.id === "slow") await delay(50);
      if (task.id === "fast") await delay(5);
      if (task.id === "fail") throw new Error("task failed");
      return "ok";
    };
    const { results } = await executeBatch(
      tasks,
      { concurrency: 3, maxTasks: 50, taskTimeoutMs: 5000 },
      runTask,
    );
    expect(results[0].index).toBe(0);
    expect(results[1].index).toBe(1);
    expect(results[2].index).toBe(2);
    expect(results[0].status).toBe("ok");
    expect(results[1].status).toBe("ok");
    expect(results[2].status).toBe("error");
  });
});
```

**Test Shape 4 — Late-settle no-double-settle, no unhandled rejection (BATCH-05):**

```typescript
// Anchored on: CONTEXT.md D-04d; the headline guard for withTimeout's two-handler form
describe("BATCH-05: timeout + late-settle guard", () => {
  it("timed-out task yields status:error entry", async () => {
    const tasks: BatchTask[] = [{ id: "t0", kind: "quickTask", input: {} }];
    const runTask: RunTask = (_task, _signal) => new Promise(() => {}); // never resolves
    const { results } = await executeBatch(
      tasks,
      { concurrency: 1, maxTasks: 50, taskTimeoutMs: 10 },
      runTask,
    );
    expect(results[0].status).toBe("error");
    expect(results[0].error).toMatch(/timeout/i);
  });

  it("late resolve after timeout produces no double-settle and no unhandled rejection", async () => {
    let lateResolve!: (v: unknown) => void;
    const runTask: RunTask = (_task, _signal) =>
      new Promise((resolve) => { lateResolve = resolve; });

    const tasks: BatchTask[] = [{ id: "t0", kind: "quickTask", input: {} }];
    const { results } = await executeBatch(
      tasks,
      { concurrency: 1, maxTasks: 50, taskTimeoutMs: 10 },
      runTask,
    );
    expect(results[0].status).toBe("error");

    // Late-resolve the orphaned promise — must be silent (no error, no crash)
    lateResolve("late value");
    await new Promise(r => setTimeout(r, 0)); // flush microtasks
    // Reaching here without an unhandled rejection event = test passes
  });
});
```

---

## Shared Patterns

### AbortController + setTimeout timeout pattern
**Source:** `src/index.ts` lines 130-166 (`callModel`)
**Apply to:** `withTimeout` in `src/batch.ts` — same Web API globals (`AbortController`, `setTimeout`, `clearTimeout`), same pattern of clearing the timer in both branches

```typescript
// Source: src/index.ts lines 136-137 — same globals used in withTimeout
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
// ... finally { clearTimeout(timeoutId); }
```

**Critical difference for `batch.ts`:** `callModel` uses `Promise.race([aiPromise, timeoutPromise])` and cleans up in `finally`. `withTimeout` uses the two-handler `.then(onResolve, onReject)` form instead — this is intentional. The two-handler form is the load-bearing guard against unhandled rejections from orphaned late-settling promises. Do NOT port `callModel`'s `Promise.race` shape into `withTimeout`.

### Error message pattern (`.message ?? String(err)`)
**Source:** `src/index.ts` lines 418-419, 477-478 (error handling in tool handlers)
**Apply to:** `executeBatch`'s per-task catch block in `src/batch.ts`

```typescript
// Source: src/index.ts lines 418-419
const msg = err instanceof Error ? err.message : "";
// Batch form (from .planning/batch.ts line 156):
error: err instanceof Error ? err.message : String(err),
```

### Named export at end of file
**Source:** `src/index.ts` line 871
**Apply to:** `src/batch.ts` — group all named exports in a single block at the end of the file

```typescript
// Source: src/index.ts line 871
export { resolveModel, isAllowedModel, timingSafeEqual, callModel, makeToolError,
         createMcpServer, authHandler, runAIWithMetrics, ALLOWED_MODELS, DEFAULT_MODELS,
         runTask, TASK_SPECS, ValidationError };
export type { ModelTier, ErrorCode, AIResult, TaskKind };
```

### vitest `describe` / `it` / `expect` test structure
**Source:** `src/__tests__/runtask.test.ts` lines 1-2
**Apply to:** `src/__tests__/batch.test.ts` — same import style, same `describe`-wraps-`it` nesting, `async () => {}` handlers

```typescript
// Source: src/__tests__/runtask.test.ts lines 1-2
import { describe, it, expect } from "vitest";
// batch.test.ts adds vi for spies:
import { describe, it, expect, vi } from "vitest";
```

### `vi.fn()` mock/spy declaration
**Source:** `src/__tests__/tool-handlers.test.ts` lines 1, 32-35
**Apply to:** BATCH-04 zero-dispatch spy in `src/__tests__/batch.test.ts`

```typescript
// Source: src/__tests__/tool-handlers.test.ts line 1
import { describe, it, expect, vi, beforeEach } from "vitest";
// Usage:
const spy = vi.fn();
expect(spy).not.toHaveBeenCalled();
```

---

## No Analog Found

No files in this phase are without a codebase analog. All patterns have direct matches:

| File | Analog | Notes |
|------|--------|-------|
| `src/batch.ts` | `.planning/batch.ts` | Direct design template — adapt, do not copy verbatim |
| `src/__tests__/batch.test.ts` | `src/__tests__/runtask.test.ts` | Closest test analog; batch tests are env-free (no `createMockEnv` needed) |

---

## Metadata

**Analog search scope:** `src/`, `.planning/`, `src/__tests__/`
**Files scanned:** 6 (`.planning/batch.ts`, `src/index.ts`, `src/__tests__/runtask.test.ts`, `src/__tests__/helpers.ts`, `src/__tests__/tool-handlers.test.ts`, `vitest.config.mts`)
**Pattern extraction date:** 2026-06-26

**What to copy vs. what to adapt:**

| Element | Action | Source |
|---------|--------|--------|
| `mapWithConcurrency` function body | Copy verbatim | `.planning/batch.ts` lines 98-115 |
| `withTimeout` function body | Copy verbatim — never refactor `.then(a,b)` to `.then(a).catch(b)` | `.planning/batch.ts` lines 119-131 |
| `executeBatch` function body | Copy verbatim | `.planning/batch.ts` lines 136-163 |
| `readBatchConfig` body | Copy, change `60_000` → `45_000` | `.planning/batch.ts` lines 26-39 |
| `BatchConfig` interface | Copy verbatim | `.planning/batch.ts` lines 20-24 |
| `BatchTask` type | Replace Zod schema with plain TS interface; use `TaskKind` for `kind` | Adapted from `.planning/batch.ts` lines 46-57 |
| `RunTask` type | Copy verbatim | `.planning/batch.ts` line 60 |
| `TaskResult` discriminated union | Write as plain TS types (no Zod) | D-03, 06-RESEARCH.md Code Examples |
| `BatchInputShape`, `BatchOutputShape`, `TaskResultSchema` | Drop entirely — Phase 7 | `.planning/batch.ts` lines 62-92 |
| `registerBatchTool` | Drop entirely — Phase 7 | `.planning/batch.ts` lines 168-215 |
| `import { z } from "zod"` | Drop — Phase 7 | `.planning/batch.ts` line 14 |
| `import type { McpServer }` | Drop — Phase 7 | `.planning/batch.ts` line 15 |
| Test file imports and structure | Copy from `runtask.test.ts` | `src/__tests__/runtask.test.ts` lines 1-4 |
| Four headline test shapes | Implement per 06-RESEARCH.md Code Examples section | 06-RESEARCH.md lines 413-495 |
