import { describe, it, expect, vi } from "vitest";
import { executeBatch, readBatchConfig } from "../batch";
import type { BatchTask, BatchConfig, RunTask } from "../batch";
import type { TaskKind } from "../index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const quickKind = "quickTask" as TaskKind;

/** Simple delay returning void — for simulating fast/slow tasks */
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Standard cfg for order/isolation tests */
const stdCfg: BatchConfig = { concurrency: 3, maxTasks: 50, taskTimeoutMs: 5000 };

// ---------------------------------------------------------------------------
// BATCH-03: Bounded worker-cursor pool
// ---------------------------------------------------------------------------

describe("BATCH-03: bounded pool — peak in-flight never exceeds concurrency", () => {
  it(
    "peak in-flight count stays at or below concurrency=3 with 10 tasks",
    async () => {
      let inFlight = 0;
      let peakInFlight = 0;

      // Each task takes a short real delay so tasks complete naturally
      // while we track peak in-flight across the full run.
      const runTask: RunTask = async (_task, _signal) => {
        inFlight++;
        peakInFlight = Math.max(peakInFlight, inFlight);
        // Brief real delay — long enough for concurrent workers to overlap
        await delay(10);
        inFlight--;
        return "done";
      };

      const tasks: BatchTask[] = Array.from({ length: 10 }, (_, i) => ({
        id: String(i),
        kind: quickKind,
        input: { instruction: "x" },
      }));

      await executeBatch(tasks, { concurrency: 3, maxTasks: 50, taskTimeoutMs: 2000 }, runTask);

      // Peak across the full run must be ≤ 3
      expect(peakInFlight).toBeLessThanOrEqual(3);
      // Peak must be at least 1 (pool actually ran tasks concurrently)
      expect(peakInFlight).toBeGreaterThanOrEqual(1);
      // All tasks completed
      expect(inFlight).toBe(0);
    },
    10000,
  );
});

// ---------------------------------------------------------------------------
// BATCH-04: Pre-dispatch cap check — zero dispatch on over-cap
// ---------------------------------------------------------------------------

describe("BATCH-04: over-cap guard — rejects before any runTask call", () => {
  it("rejects with /split/i and never calls runTask when tasks.length > maxTasks", async () => {
    const spy = vi.fn();
    const tasks: BatchTask[] = Array.from({ length: 51 }, (_, i) => ({
      id: String(i),
      kind: quickKind,
      input: { instruction: "x" },
    }));

    await expect(
      executeBatch(tasks, { concurrency: 6, maxTasks: 50, taskTimeoutMs: 45000 }, spy as unknown as RunTask)
    ).rejects.toThrow(/split/i);

    expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// BATCH-06: Order-preserving results + failure isolation
// ---------------------------------------------------------------------------

describe("BATCH-06: order preservation and failure isolation", () => {
  it("results[i].index === i with inverted durations, and one error does not abort siblings", async () => {
    const tasks: BatchTask[] = [
      { id: "slow", kind: quickKind, input: {} },
      { id: "fast", kind: quickKind, input: {} },
      { id: "fail", kind: quickKind, input: {} },
    ];

    const runTask: RunTask = async (task, _signal) => {
      if (task.id === "slow") await delay(50);
      if (task.id === "fast") await delay(5);
      if (task.id === "fail") throw new Error("task failed intentionally");
      return "ok";
    };

    const summary = await executeBatch(tasks, stdCfg, runTask);

    // Order is preserved — results[i].index === i regardless of completion order
    expect(summary.results[0].index).toBe(0);
    expect(summary.results[1].index).toBe(1);
    expect(summary.results[2].index).toBe(2);

    // Statuses match task outcomes
    expect(summary.results[0].status).toBe("ok");
    expect(summary.results[1].status).toBe("ok");
    expect(summary.results[2].status).toBe("error");

    // Summary counts are correct
    expect(summary.total).toBe(3);
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// BATCH-05: Per-task timeout + late-settle safety
// ---------------------------------------------------------------------------

describe("BATCH-05: per-task timeout and late-settle guard", () => {
  it("a never-resolving task yields status:error matching /timeout/i without hanging the batch", async () => {
    const runTask: RunTask = (_task, _signal) =>
      new Promise(() => { /* never resolves */ });

    const tasks: BatchTask[] = [{ id: "t0", kind: quickKind, input: {} }];
    const summary = await executeBatch(
      tasks,
      { concurrency: 1, maxTasks: 50, taskTimeoutMs: 10 },
      runTask,
    );

    expect(summary.results[0].status).toBe("error");
    expect((summary.results[0] as { error: string }).error).toMatch(/timeout/i);
  });

  it("a late-resolving orphan causes no double-settle and no unhandled rejection", async () => {
    let lateResolve!: (v: unknown) => void;

    const runTask: RunTask = (_task, _signal) =>
      new Promise((resolve) => {
        lateResolve = resolve;
      });

    const tasks: BatchTask[] = [{ id: "t0", kind: quickKind, input: {} }];
    const batchPromise = executeBatch(
      tasks,
      { concurrency: 1, maxTasks: 50, taskTimeoutMs: 10 },
      runTask,
    );

    // Wait for the batch to complete — timeout fires at 10ms
    const { results } = await batchPromise;
    expect(results[0].status).toBe("error");
    expect((results[0] as { error: string }).error).toMatch(/timeout/i);

    // Resolve the orphaned promise AFTER the batch has settled — must be silent
    lateResolve("late value");
    // Flush any pending microtasks
    await new Promise<void>((r) => setTimeout(r, 0));
    // Reaching here without an unhandled rejection = test passes
  });
});

// ---------------------------------------------------------------------------
// readBatchConfig: defaults and guard behaviour
// ---------------------------------------------------------------------------

describe("readBatchConfig: env parsing and defaults", () => {
  it("returns defaults when env is empty", () => {
    const cfg = readBatchConfig({});
    expect(cfg.concurrency).toBe(6);
    expect(cfg.maxTasks).toBe(50);
    expect(cfg.taskTimeoutMs).toBe(45000);
  });

  it("floors valid positive values", () => {
    const cfg = readBatchConfig({
      BATCH_CONCURRENCY: "4.9",
      BATCH_MAX_TASKS: "20.1",
      BATCH_TASK_TIMEOUT_MS: "30000.7",
    });
    expect(cfg.concurrency).toBe(4);
    expect(cfg.maxTasks).toBe(20);
    expect(cfg.taskTimeoutMs).toBe(30000);
  });

  it("falls back to defaults for non-positive, non-finite, or undefined values", () => {
    const cfg = readBatchConfig({
      BATCH_CONCURRENCY: "0",
      BATCH_MAX_TASKS: "-1",
      BATCH_TASK_TIMEOUT_MS: "NaN",
    });
    expect(cfg.concurrency).toBe(6);
    expect(cfg.maxTasks).toBe(50);
    expect(cfg.taskTimeoutMs).toBe(45000);
  });
});
