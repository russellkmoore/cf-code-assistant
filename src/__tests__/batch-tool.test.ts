import { describe, it, expect } from "vitest";
import { executeBatch } from "../batch";
import type { BatchTask, BatchConfig, RunTask } from "../batch";
import { BatchOutputSchema, deriveErrorType, createMcpServer, BatchTaskInputSchema, runTask, DEFAULT_MODELS } from "../index";
import { createMockEnv } from "./helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const stdCfg: BatchConfig = { concurrency: 3, maxTasks: 50, taskTimeoutMs: 5000 };

// WARNING: Accesses SDK internals (_registeredTools). If this breaks after an SDK update,
// check McpServer's internal structure for the new property name.
function getToolHandler(env: Env, toolName: string) {
  const server = createMcpServer(env);
  const tools = (server as any)._registeredTools;
  const tool = tools[toolName];
  if (!tool) throw new Error(`Tool "${toolName}" not registered`);
  return tool.handler;
}

/**
 * Enrich raw executeBatch output the same way runBatch does in src/index.ts.
 * This mirrors the enrichment logic exactly so tests validate the contract
 * without needing to export the private runBatch function.
 */
function enrich(raw: {
  total: number;
  succeeded: number;
  failed: number;
  results: Array<
    | { id: string; index: number; kind: string; status: "ok"; result: unknown }
    | { id: string; index: number; kind: string; status: "error"; error: string }
  >;
}) {
  const results = raw.results.map((entry) => {
    if (entry.status === "ok") {
      const aiResult = entry.result as { text: string; model: string; latency_ms: number };
      return {
        id: entry.id,
        index: entry.index,
        kind: entry.kind,
        status: "ok" as const,
        result: aiResult.text,
        latency_ms: aiResult.latency_ms,
      };
    } else {
      const timeoutMatch = entry.error.match(/exceeded (\d+)ms timeout/);
      const latency_ms = timeoutMatch ? parseInt(timeoutMatch[1], 10) : 0;
      return {
        id: entry.id,
        index: entry.index,
        kind: entry.kind,
        status: "error" as const,
        error: entry.error,
        error_type: deriveErrorType(entry.error),
        latency_ms,
      };
    }
  });

  const failedIds = results
    .filter((r) => r.status === "error")
    .map((r) => r.id);

  const summary =
    failedIds.length === 0
      ? `${raw.succeeded}/${raw.total} tasks succeeded.`
      : `${raw.succeeded}/${raw.total} tasks succeeded. ${raw.failed} failed: ${failedIds.join(", ")}.`;

  return { total: raw.total, succeeded: raw.succeeded, failed: raw.failed, failedIds, results, summary };
}

// ---------------------------------------------------------------------------
// BATCH-07: output schema parse
// ---------------------------------------------------------------------------

describe("BATCH-07: output schema parse", () => {
  it("all-ok batch parses against BatchOutputSchema", async () => {
    const okRunTask: RunTask = async (_task, _signal) => ({
      text: "generated output",
      model: "@cf/qwen/qwen3-30b-a3b-fp8",
      latency_ms: 100,
    });

    const tasks: BatchTask[] = [
      { id: "t0", kind: "quickTask", input: { instruction: "do x" } },
      { id: "t1", kind: "quickTask", input: { instruction: "do y" } },
    ];

    const raw = await executeBatch(tasks, stdCfg, okRunTask);
    const enriched = enrich(raw);

    expect(() => BatchOutputSchema.parse(enriched)).not.toThrow();

    const parsed = BatchOutputSchema.parse(enriched);
    expect(parsed.total).toBe(2);
    expect(parsed.succeeded).toBe(2);
    expect(parsed.failed).toBe(0);
    expect(parsed.failedIds).toHaveLength(0);
    expect(parsed.results[0].status).toBe("ok");
    expect((parsed.results[0] as any).latency_ms).toBe(100);
    expect((parsed.results[0] as any).result).toBe("generated output");
  });

  it("mixed batch (ok + error + timeout) parses against BatchOutputSchema", async () => {
    const mixedRunTask: RunTask = async (task, _signal) => {
      if (task.id === "ok-task") {
        return { text: "ok output", model: "@cf/qwen/qwen3-30b-a3b-fp8", latency_ms: 50 };
      }
      if (task.id === "error-task") {
        throw new Error("network blowup");
      }
      // timeout-task: throw a timeout error matching withTimeout's format
      throw new Error("Task exceeded 5000ms timeout");
    };

    const tasks: BatchTask[] = [
      { id: "ok-task", kind: "quickTask", input: { instruction: "ok" } },
      { id: "error-task", kind: "quickTask", input: { instruction: "fail" } },
      { id: "timeout-task", kind: "quickTask", input: { instruction: "slow" } },
    ];

    const raw = await executeBatch(tasks, stdCfg, mixedRunTask);
    const enriched = enrich(raw);

    expect(() => BatchOutputSchema.parse(enriched)).not.toThrow();

    const parsed = BatchOutputSchema.parse(enriched);
    expect(parsed.total).toBe(3);
    expect(parsed.succeeded).toBe(1);
    expect(parsed.failed).toBe(2);
    expect(parsed.results[0].status).toBe("ok");
    expect(parsed.results[1].status).toBe("error");
    expect(parsed.results[2].status).toBe("error");
    expect((parsed.results[1] as any).error_type).toBe("ai_error");
    expect((parsed.results[2] as any).error_type).toBe("timeout");
    expect((parsed.results[2] as any).latency_ms).toBe(5000);
  });

  it("error_type derivation matches expected values", () => {
    expect(deriveErrorType("Task exceeded 45000ms timeout")).toBe("timeout");
    expect(deriveErrorType("AI_TIMEOUT")).toBe("timeout");
    expect(deriveErrorType("INPUT_TOO_LARGE")).toBe("validation");
    expect(deriveErrorType("some network blowup")).toBe("ai_error");
  });
});

// ---------------------------------------------------------------------------
// BATCH-08: summary contract
// ---------------------------------------------------------------------------

describe("BATCH-08: summary contract", () => {
  it("failedIds contains the IDs of all error results in order", async () => {
    const runTask: RunTask = async (task, _signal) => {
      if (task.id === "bad1" || task.id === "bad2") throw new Error("task failed");
      return { text: "ok", model: "@cf/qwen/qwen3-30b-a3b-fp8", latency_ms: 10 };
    };

    const tasks: BatchTask[] = [
      { id: "good1", kind: "quickTask", input: { instruction: "x" } },
      { id: "bad1", kind: "quickTask", input: { instruction: "x" } },
      { id: "bad2", kind: "quickTask", input: { instruction: "x" } },
      { id: "good2", kind: "quickTask", input: { instruction: "x" } },
    ];

    const raw = await executeBatch(tasks, stdCfg, runTask);
    const enriched = enrich(raw);

    expect(enriched.failedIds).toEqual(["bad1", "bad2"]);
  });

  it("summary text reflects succeeded/failed counts", async () => {
    const allOkRunTask: RunTask = async () => ({
      text: "out", model: "@cf/qwen/qwen3-30b-a3b-fp8", latency_ms: 5,
    });

    const tasks: BatchTask[] = [
      { id: "a", kind: "quickTask", input: { instruction: "x" } },
      { id: "b", kind: "quickTask", input: { instruction: "x" } },
    ];

    const rawOk = await executeBatch(tasks, stdCfg, allOkRunTask);
    const enrichedOk = enrich(rawOk);
    expect(enrichedOk.summary).toBe("2/2 tasks succeeded.");

    const failingRunTask: RunTask = async (task) => {
      if (task.id === "b") throw new Error("oops");
      return { text: "out", model: "@cf/qwen/qwen3-30b-a3b-fp8", latency_ms: 5 };
    };

    const rawMixed = await executeBatch(tasks, stdCfg, failingRunTask);
    const enrichedMixed = enrich(rawMixed);
    expect(enrichedMixed.summary).toContain("1/2 tasks succeeded");
    expect(enrichedMixed.summary).toContain("1 failed");
    expect(enrichedMixed.summary).toContain("b");
  });
});

// ---------------------------------------------------------------------------
// BATCH-F03: tier override + schema
// ---------------------------------------------------------------------------

describe("BATCH-F03: tier override + schema", () => {

  it("BatchTaskInputSchema accepts tier:'fast' and tier:'standard' (schema)", () => {
    expect(
      BatchTaskInputSchema.safeParse({ kind: "generateCode", input: {}, tier: "fast" }).success
    ).toBe(true);
    expect(
      BatchTaskInputSchema.safeParse({ kind: "generateCode", input: {}, tier: "standard" }).success
    ).toBe(true);
  });

  it("BatchTaskInputSchema rejects tier:'premium' and other non-allowlisted strings (schema)", () => {
    expect(
      BatchTaskInputSchema.safeParse({ kind: "generateCode", input: {}, tier: "premium" }).success
    ).toBe(false);
    expect(
      BatchTaskInputSchema.safeParse({ kind: "generateCode", input: {}, tier: "turbo" }).success
    ).toBe(false);
  });

  it("batch task tier:'fast' flows through executeBatch + adapter to the fast model (tier)", async () => {
    const env = createMockEnv({ aiResponse: "fast batch output" });

    // Mirror the runBatch adapter from src/index.ts
    const adapter = (batchTask: import("../batch").BatchTask, signal: AbortSignal) =>
      runTask(env, batchTask.kind, batchTask.input, { tier: batchTask.tier, signal });

    const tasks: import("../batch").BatchTask[] = [
      { id: "t0", kind: "generateCode", tier: "fast", input: { prompt: "hello" } },
    ];

    const raw = await executeBatch(tasks, stdCfg, adapter);

    expect(raw.total).toBe(1);
    expect(raw.succeeded).toBe(1);
    expect(raw.results[0].status).toBe("ok");

    // The AIResult contains the model; assert it's the fast model
    const aiResult = (raw.results[0] as any).result as { text: string; model: string; latency_ms: number };
    expect(aiResult.model).toBe(DEFAULT_MODELS.fast);
  });

});

// ---------------------------------------------------------------------------
// BATCH-09: registration
// ---------------------------------------------------------------------------

describe("BATCH-09: registration", () => {
  it("code_assist_batch is registered in createMcpServer", () => {
    const env = createMockEnv();
    const server = createMcpServer(env);
    const tools = (server as any)._registeredTools;
    expect(tools["code_assist_batch"]).toBeDefined();
  });

  it("handler returns structuredContent alongside content text", async () => {
    const env = createMockEnv({ aiResponse: "mock ai response" });
    const handler = getToolHandler(env, "code_assist_batch");

    const result = await handler({
      tasks: [
        { kind: "quickTask", input: { instruction: "say hello" } },
      ],
    });

    // Must have content array (text summary)
    expect(result.content).toBeDefined();
    expect(Array.isArray(result.content)).toBe(true);
    expect(result.content[0].type).toBe("text");
    expect(typeof result.content[0].text).toBe("string");

    // Must have structuredContent
    expect(result.structuredContent).toBeDefined();
    const sc = result.structuredContent as any;
    expect(sc.total).toBe(1);
    expect(sc.results).toHaveLength(1);
    // The structuredContent must parse against the schema
    expect(() => BatchOutputSchema.parse(sc)).not.toThrow();
  });

  it("annotations are readOnlyHint:false destructiveHint:false idempotentHint:false openWorldHint:true", () => {
    const env = createMockEnv();
    const server = createMcpServer(env);
    const tools = (server as any)._registeredTools;
    const tool = tools["code_assist_batch"];

    expect(tool).toBeDefined();
    const annotations = tool.annotations ?? tool.definition?.annotations;
    expect(annotations).toBeDefined();
    expect(annotations.readOnlyHint).toBe(false);
    expect(annotations.destructiveHint).toBe(false);
    expect(annotations.idempotentHint).toBe(false);
    expect(annotations.openWorldHint).toBe(true);
  });
});
