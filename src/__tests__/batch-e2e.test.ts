import { describe, it, expect, vi } from "vitest";
import { createMcpServer, BatchOutputSchema } from "../index";
import { createMockEnv } from "./helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// WARNING: Accesses SDK internals (_registeredTools). If this breaks after an SDK update,
// check McpServer's internal structure for the new property name.
function getToolHandler(env: Env, toolName: string) {
  const server = createMcpServer(env);
  const tools = (server as any)._registeredTools;
  const tool = tools[toolName];
  if (!tool) throw new Error(`Tool "${toolName}" not registered`);
  return tool.handler;
}

// ---------------------------------------------------------------------------
// BATCH-10: committed fast e2e — 3-task mixed batch through createMcpServer
// ---------------------------------------------------------------------------

describe("BATCH-10: committed fast e2e — 3-task mixed batch through createMcpServer", () => {
  it(
    "returns order-preserving partial results with all three statuses (timeout / validation / ok)",
    async () => {
      // Task ordering (proves completion order != input order):
      //   index 0: TIMEOUT task  — quickTask, AI mock hangs 100ms >> 20ms BATCH_TASK_TIMEOUT_MS
      //                           → withTimeout(20ms) fires first → status:'error', error_type:'timeout'
      //   index 1: VALIDATION-FAIL task — transformCode with >8000-byte input
      //                           → TASK_SPECS.transformCode.validate() throws ValidationError("INPUT_TOO_LARGE")
      //                           → synchronous, no AI call, completes first → error_type:'validation'
      //   index 2: OK task        — quickTask, AI mock returns instantly → status:'ok'
      //
      // Completion order: task 1 (sync), task 2 (instant async), task 0 (after 20ms timeout)
      // Output order: [0, 1, 2] always — results[i].index === i regardless of completion order

      const env = {
        ...createMockEnv(),
        AI: {
          run: vi.fn()
            // First AI call = task 0 (timeout task): hangs 100ms >> 20ms BATCH_TASK_TIMEOUT_MS
            .mockImplementationOnce(
              () => new Promise((r) => setTimeout(() => r({ response: "late" }), 100))
            )
            // Second AI call = task 2 (ok task): resolves instantly
            .mockImplementationOnce(async () => ({ response: "generated output" })),
        } as unknown as Ai,
        // readBatchConfig reads BATCH_TASK_TIMEOUT_MS as a string via env cast.
        // This is NOT on the Env type — intentional, picked up via
        // `env as unknown as Record<string, string | undefined>` in runBatch.
        BATCH_TASK_TIMEOUT_MS: "20",
      } as unknown as Env;

      const handler = getToolHandler(env, "code_assist_batch");
      const result = await handler({
        tasks: [
          // index 0: TIMEOUT — AI mock hangs, withTimeout(20ms) fires first
          { id: "timeout-task", kind: "quickTask", input: { instruction: "hang" } },
          // index 1: VALIDATION-FAIL — transformCode validate() throws INPUT_TOO_LARGE before AI call
          { id: "validate-task", kind: "transformCode", input: { code: "x".repeat(8001), instruction: "add types" } },
          // index 2: OK — AI mock returns instantly
          { id: "ok-task", kind: "quickTask", input: { instruction: "say hello" } },
        ],
      });

      // ---- Structural shape ----
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content[0].type).toBe("text");
      expect(result.structuredContent).toBeDefined();
      const sc = result.structuredContent as any;

      // ---- Schema parse — exercises the Zod contract itself ----
      expect(() => BatchOutputSchema.parse(sc)).not.toThrow();

      // ---- Totals ----
      expect(sc.total).toBe(3);
      expect(sc.succeeded).toBe(1);
      expect(sc.failed).toBe(2);

      // ---- Order-preservation — results[i].index === i regardless of completion order ----
      expect(sc.results[0].index).toBe(0);
      expect(sc.results[1].index).toBe(1);
      expect(sc.results[2].index).toBe(2);

      // ---- Statuses ----
      expect(sc.results[0].status).toBe("error");
      expect(sc.results[1].status).toBe("error");
      expect(sc.results[2].status).toBe("ok");

      // ---- error_type classification ----
      // timeout: withTimeout throws "Task exceeded 20ms timeout" → deriveErrorType → "timeout"
      expect(sc.results[0].error_type).toBe("timeout");
      // validation: ValidationError("INPUT_TOO_LARGE") → deriveErrorType → "validation"
      expect(sc.results[1].error_type).toBe("validation");

      // ---- latency_ms on timeout entry: parsed from "Task exceeded 20ms timeout" → 20 ----
      expect(sc.results[0].latency_ms).toBe(20);

      // ---- ok result ----
      expect(sc.results[2].result).toBe("generated output");

      // ---- failedIds — preserves input order (not completion order) ----
      expect(sc.failedIds).toEqual(["timeout-task", "validate-task"]);

      // ---- summary reflects failures ----
      expect(sc.summary).toContain("1/3");
      expect(sc.summary).toContain("2 failed");

      // ---- Pool dispatch guard: validation-fail task never calls AI ----
      // Only task 0 (timeout) and task 2 (ok) reach env.AI.run. Task 1 short-circuits at validate().
      expect((env as any).AI.run).toHaveBeenCalledTimes(2);
    },
    5000, // 5s wall-clock ceiling — withTimeout fires at 20ms, test is sub-100ms
  );
});

// ---------------------------------------------------------------------------
// BATCH-10 opt-in: real-wait 45s timeout race
// ---------------------------------------------------------------------------

// NOTE TO FUTURE READER:
// This block exercises the real 45s wall-clock timeout race. Un-skip to run it by hand.
// (a) It uses a hanging AI mock — OFFLINE, no real Workers AI, no charges, no network/credentials.
// (b) WHY THE ASSERTION IS LOOSE (D-04b from 08-CONTEXT.md):
//     callModel's internal AbortController fires at AI_TIMEOUT_MS = 45_000ms.
//     withTimeout in executeBatch also fires at BATCH_TASK_TIMEOUT_MS = 45_000ms (default).
//     Both deadlines fire at the same wall-clock instant; which settles first is nondeterministic.
//     In both cases error_type resolves to "timeout", but the exact error message and settlement
//     order vary across environments. Do NOT tighten this to assert error_type — it will flake
//     on slow CI runners or under different OS timer precision.
// (c) To run manually: change `describe.skip` to `describe` and run `npm test -- -t "opt-in"`.
describe.skip("BATCH-10 opt-in: real-wait 45s timeout race (un-skip to run manually)", () => {
  it(
    "hanging AI mock races with both 45s deadlines; batch settles with status:error, no hang",
    async () => {
      const env = {
        ...createMockEnv(),
        AI: {
          // Hangs indefinitely — never resolves. Both 45s deadlines will race.
          run: vi.fn(() => new Promise(() => { /* intentional infinite hang */ })),
        } as unknown as Ai,
        // BATCH_TASK_TIMEOUT_MS not overridden — use the real 45s default so the production
        // race is faithful: withTimeout(45s) vs callModel's internal AbortController(45s).
      } as unknown as Env;

      const handler = getToolHandler(env, "code_assist_batch");
      const result = await handler({
        tasks: [
          // index 0: hanging task — AI mock never resolves; both 45s deadlines race
          { id: "hang-task", kind: "quickTask", input: { instruction: "hang indefinitely" } },
          // index 1: trivial task — will also wait since concurrency pool includes the hang
          { id: "ok-task", kind: "quickTask", input: { instruction: "say hello" } },
        ],
      });

      const sc = result.structuredContent as any;

      // ---- Presence in input order (index-by-index) ----
      expect(sc.results).toHaveLength(2);
      expect(sc.results[0].index).toBe(0);

      // ---- Loose assertion only — see comment above re: the 45s race (D-04b) ----
      // Do NOT assert error_type:'timeout' specifically — the 45s race is nondeterministic.
      // Asserting status:'error' and no unhandled rejection is sufficient proof the batch settled.
      expect(sc.results[0].status).toBe("error");
      // Do NOT add: expect(sc.results[0].error_type).toBe("timeout");
    },
    60_000, // 60s per-test timeout — 45s deadline + 15s margin
  );
});
