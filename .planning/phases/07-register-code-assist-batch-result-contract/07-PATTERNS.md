# Phase 7: Register `code_assist_batch` + Result Contract - Pattern Map

**Mapped:** 2026-06-26
**Files analyzed:** 2 (1 edit, 1 new)
**Analogs found:** 2 / 2

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/index.ts` (edit) | tool-registration, utility | request-response, batch | `src/index.ts` lines 401-693 (existing `registerTool` calls) | exact (same file — partial, see divergence note) |
| `src/__tests__/batch-tool.test.ts` | test | batch, transform | `src/__tests__/batch.test.ts` (executeBatch unit tests) + `src/__tests__/runtask.test.ts` (handler invocation pattern) | role-match |

---

## Pattern Assignments

### `src/index.ts` — additions (tool-registration, request-response + batch)

**Analog:** `src/index.ts` — the 11 standard `server.registerTool` calls (e.g., `generateCode`, `transformCode`)

#### Imports pattern

No new imports needed. All symbols are already in scope inside `createMcpServer`:
- `z` from `"zod"` — already imported (line 4)
- `runTask`, `ValidationError`, `AIResult`, `TaskKind` — already defined in the same file
- `executeBatch`, `readBatchConfig`, `BatchTask`, `RunTask` — must be imported from `"./batch"`

The one new import line to add at the top of the file (after existing imports):

```typescript
// Add after line 5 (after logger import):
import { executeBatch, readBatchConfig } from "./batch";
import type { BatchTask, RunTask } from "./batch";
```

#### Closest `registerTool` skeleton analog (lines 401-425 — `generateCode`)

```typescript
// src/index.ts lines 401-425 — the CLOSEST full analog for the registration skeleton
server.registerTool(
  "generateCode",
  {
    description: "Generate production-ready code from a prompt. ...",
    inputSchema: {
      prompt: z.string().max(20_000).trim().describe("What code to generate"),
      context: z.string().max(50_000).trim().optional().describe("..."),
      language: z.string().max(100).trim().optional().describe("..."),
      style: z.string().max(100).trim().optional().describe("..."),
    },
  },
  async ({ prompt, context, language, style }) => {
    try {
      const result = await runTask(env, "generateCode", { prompt, context, language, style });
      logToolInvocation({ tool: "generateCode", tier: "standard", model: result.model, latency_ms: result.latency_ms });
      return { content: [{ type: "text", text: result.text }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      const errorType = msg === "AI_TIMEOUT" ? "AI_TIMEOUT" : "AI_ERROR";
      const inputSize = new TextEncoder().encode(prompt + (context ?? "")).byteLength;
      logToolError({ tool: "generateCode", error_type: errorType, input_size_bytes: inputSize });
      return makeToolError(errorType as ErrorCode, "generateCode");
    }
  },
);
```

**DIVERGENCE — where `code_assist_batch` MUST extend this analog:**

| Aspect | Existing tools (analog) | `code_assist_batch` (must differ) |
|--------|------------------------|-----------------------------------|
| `outputSchema` | Not present — no existing tool has one | Required: `outputSchema: BatchOutputSchema` in the config object |
| `annotations` | Not present on any existing tool | Required: `annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }` |
| Handler return | `{ content: [{ type: "text", text }] }` only | `{ content: [{ type: "text", text: summary }], structuredContent: enrichedBatchResult }` |
| `isError: true` path | Used via `makeToolError(...)` | Same `makeToolError` call works — `isError:true` skips outputSchema validation |
| AI call | Direct `runTask(env, kind, input)` per tool | `executeBatch(tasks, cfg, adapter)` fan-out via the `runBatch` wrapper |

#### `transformCode` error handling analog — ValidationError catch (lines 451-484)

```typescript
// src/index.ts lines 466-484 — two-branch catch pattern; code_assist_batch
// mirrors the over-cap throw path using the same isError:true escape
async ({ code, instruction }) => {
  try {
    const result = await runTask(env, "transformCode", { code, instruction });
    // ...
    return { content: [{ type: "text", text: result.text }] };
  } catch (err) {
    if (err instanceof ValidationError) {
      // specific typed error → custom isError:true response
      return {
        content: [{ type: "text" as const, text: `[ERROR: INPUT_TOO_LARGE] ...` }],
        isError: true as const,
      };
    }
    // fallthrough → makeToolError
    const msg = err instanceof Error ? err.message : "";
    const errorType = msg === "AI_TIMEOUT" ? "AI_TIMEOUT" : "AI_ERROR";
    return makeToolError(errorType as ErrorCode, "transformCode");
  }
},
```

The `code_assist_batch` catch block must use the same `makeToolError(...)` + `isError: true` pattern so the SDK skips `outputSchema` validation on error paths.

#### `makeToolError` helper pattern (lines 191-201)

```typescript
// src/index.ts lines 191-201 — already handles isError:true for all error codes
function makeToolError(code: ErrorCode, toolName: string) {
  const messages: Record<ErrorCode, string> = {
    AI_TIMEOUT: `[ERROR: AI_TIMEOUT] ...`,
    AI_ERROR: `[ERROR: AI_ERROR] ...`,
    INTERNAL_ERROR: `[ERROR: INTERNAL_ERROR] ...`,
  };
  return {
    content: [{ type: "text" as const, text: messages[code] }],
    isError: true as const,
  };
}
```

`code_assist_batch` uses `makeToolError("INTERNAL_ERROR", "code_assist_batch")` for both over-cap throws and unexpected errors.

#### Named test-export block (line 871-872)

```typescript
// src/index.ts lines 871-872 — all testable symbols are in this one export line
export { resolveModel, isAllowedModel, timingSafeEqual, callModel, makeToolError, createMcpServer,
         authHandler, runAIWithMetrics, ALLOWED_MODELS, DEFAULT_MODELS, runTask, TASK_SPECS, ValidationError };
export type { ModelTier, ErrorCode, AIResult, TaskKind };
```

Phase 7 adds to the value export line: `BatchOutputSchema`, `deriveErrorType`
No new `export type` line is required (all new types are inferred from Zod schemas or are `z.infer<...>` callsites).

#### Zod schema pattern — all existing inputSchema fields use inline raw shape (lines 405-410)

```typescript
// src/index.ts lines 405-410 — raw shape object (NOT z.object(...)) for inputSchema
inputSchema: {
  prompt: z.string().max(20_000).trim().describe("What code to generate"),
  context: z.string().max(50_000).trim().optional().describe("..."),
},
```

`code_assist_batch` `inputSchema` follows this same flat-object convention. `outputSchema` must be a `z.object(...)` (not a raw shape) because the SDK calls `.parse()` on `structuredContent` against it — this is the one case where the named schema variable is required.

---

### `src/__tests__/batch-tool.test.ts` — new test file (test, batch + transform)

**Primary analog:** `src/__tests__/batch.test.ts` — the executeBatch unit test file  
**Secondary analog:** `src/__tests__/runtask.test.ts` — handler invocation via `_registeredTools` + `createMockEnv`

#### Imports pattern (batch.test.ts lines 1-4)

```typescript
// src/__tests__/batch.test.ts lines 1-4 — import style for all batch tests
import { describe, it, expect, vi } from "vitest";
import { executeBatch, readBatchConfig } from "../batch";
import type { BatchTask, BatchConfig, RunTask } from "../batch";
import type { TaskKind } from "../index";
```

`batch-tool.test.ts` extends this with imports from `../index` for schemas and server:

```typescript
// Additional imports needed for batch-tool.test.ts (not in the analog):
import { BatchOutputSchema, deriveErrorType, createMcpServer } from "../index";
import { createMockEnv } from "./helpers";
```

#### Mock RunTask pattern (batch.test.ts lines 31-38)

```typescript
// src/__tests__/batch.test.ts lines 31-38 — canonical RunTask mock returning a value
const runTask: RunTask = async (_task, _signal) => {
  inFlight++;
  peakInFlight = Math.max(peakInFlight, inFlight);
  await delay(10);
  inFlight--;
  return "done";
};
```

For `batch-tool.test.ts`, the RunTask mock must return an `AIResult`-shaped object (not a bare string) because `runBatch` casts `entry.result as AIResult` on the ok path:

```typescript
// batch-tool.test.ts ok-path RunTask mock — returns AIResult shape
const runTask: RunTask = async (_task, _signal) => ({
  text: "generated output",
  model: "@cf/qwen/qwen3-30b-a3b-fp8",
  latency_ms: 100,
});
```

#### Error-path RunTask mock (batch.test.ts lines 93-96)

```typescript
// src/__tests__/batch.test.ts lines 93-96 — throwing RunTask for error isolation
const runTask: RunTask = async (task, _signal) => {
  if (task.id === "slow") await delay(50);
  if (task.id === "fast") await delay(5);
  if (task.id === "fail") throw new Error("task failed intentionally");
  return "ok";
};
```

`batch-tool.test.ts` mirrors this pattern to exercise `error_type` derivation — throw `new Error("AI_TIMEOUT")` for timeout, `new Error("INPUT_TOO_LARGE")` for validation, and a generic error for `ai_error`.

#### BatchConfig helper (batch.test.ts lines 16)

```typescript
// src/__tests__/batch.test.ts line 16 — standard config constant used across tests
const stdCfg: BatchConfig = { concurrency: 3, maxTasks: 50, taskTimeoutMs: 5000 };
```

`batch-tool.test.ts` uses the same inline config pattern rather than `readBatchConfig`, since the tests call `executeBatch` directly (not through the tool handler).

#### Handler invocation via `_registeredTools` (runtask.test.ts lines 8-14)

```typescript
// src/__tests__/runtask.test.ts lines 8-14 — SDK internal access pattern
// WARNING: Accesses SDK internals (_registeredTools). If this breaks after an SDK update,
// check McpServer's internal structure for the new property name.
function getToolHandler(env: Env, toolName: string) {
  const server = createMcpServer(env);
  const tools = (server as any)._registeredTools;
  const tool = tools[toolName];
  if (!tool) throw new Error(`Tool "${toolName}" not registered`);
  return tool.handler;
}
```

Copy this helper verbatim into `batch-tool.test.ts` for the registration smoke test (BATCH-09). Prefer testing `BatchOutputSchema.parse(enriched)` directly over going through the handler when possible, to avoid SDK version brittleness (per RESEARCH.md Pitfall 6).

#### createMockEnv helper usage (runtask.test.ts lines 298-301)

```typescript
// src/__tests__/runtask.test.ts lines 298-301 — mock env for handler tests
const env = createMockEnv({ aiResponse: "mock AI output" });
const result = await runTask(env, "generateCode" as TaskKind, { prompt: "hi" });
expect(result.text).toBe("mock AI output");
```

`batch-tool.test.ts` uses `createMockEnv()` from `./helpers` (same pattern) for the BATCH-09 registration test that goes through the handler. For the schema-parse tests (BATCH-07/08), no env is needed — they call `executeBatch` directly with a fake `RunTask` and then apply the enrichment function.

#### describe/it/expect structure (batch.test.ts lines 22-56)

```typescript
// src/__tests__/batch.test.ts lines 22-56 — req-ID-anchored describe blocks
describe("BATCH-03: bounded pool — peak in-flight never exceeds concurrency", () => {
  it("peak in-flight count stays at or below concurrency=3 with 10 tasks", async () => {
    // ...
    expect(peakInFlight).toBeLessThanOrEqual(3);
  }, 10000);
});
```

`batch-tool.test.ts` follows the same `describe("BATCH-07: ...", ...)` naming convention anchored to requirement IDs. No custom timeout needed — the fake RunTask resolves immediately.

#### Schema parse assertion pattern

The test file's core assertion style (no analog in the existing tests — this is new for Phase 7):

```typescript
// Pattern for all-ok batch — verifies schema conformance
expect(() => BatchOutputSchema.parse(enriched)).not.toThrow();

// Pattern for field-level assertions after schema parse
const parsed = BatchOutputSchema.parse(enriched);
expect(parsed.failedIds).toHaveLength(0);
expect(parsed.results[0].status).toBe("ok");
expect((parsed.results[0] as any).latency_ms).toBe(100);
```

The `as any` cast for discriminated union narrowing is the same pattern used in `batch.test.ts` line 135: `(summary.results[0] as { error: string }).error`.

---

## Shared Patterns

### Error Escape with `isError: true`
**Source:** `src/index.ts` lines 191-201 (`makeToolError`) and lines 466-475 (`transformCode` ValidationError branch)
**Apply to:** The `code_assist_batch` handler's catch block

```typescript
// Both paths must use isError:true to skip outputSchema validation
return makeToolError("INTERNAL_ERROR", "code_assist_batch");
// — OR —
return { content: [{ type: "text" as const, text: "..." }], isError: true as const };
```

### Logging at Tool Level (not per-task)
**Source:** `src/index.ts` lines 415-416 (all 11 standard tools)
**Apply to:** `code_assist_batch` handler — log once at batch completion, not per task

```typescript
// Existing tool log pattern (one log per tool invocation):
logToolInvocation({ tool: "generateCode", tier: "standard", model: result.model, latency_ms: result.latency_ms });
```

For `code_assist_batch`, log total wall-clock latency and counts. The per-task model and tier vary, so log `tool: "code_assist_batch"` with `succeeded`/`failed` counts (not model/tier, which are per-task details).

### Named Export Block Extension
**Source:** `src/index.ts` line 871
**Apply to:** Adding `BatchOutputSchema` and `deriveErrorType` to the existing export line

```typescript
// Current line 871 — append new symbols to this line, do not create a second export block
export { ..., runTask, TASK_SPECS, ValidationError, BatchOutputSchema, deriveErrorType };
```

### Mock Env in Tests
**Source:** `src/__tests__/helpers.ts` lines 42-54 (`createMockEnv`)
**Apply to:** `batch-tool.test.ts` registration/handler tests

```typescript
// helpers.ts lines 42-54 — complete mock env factory
export function createMockEnv(overrides: {
  kvData?: Record<string, string | null>;
  aiResponse?: string;
  mcpSecret?: string;
  rateLimitSuccess?: boolean;
} = {}): Env {
  return {
    OAUTH_KV: createMockKV(overrides.kvData ?? {}),
    AI: createMockAI(overrides.aiResponse ?? "mock-response"),
    MCP_SECRET: overrides.mcpSecret ?? "test-secret-pin",
    AUTH_RATE_LIMITER: createMockRateLimiter(overrides.rateLimitSuccess ?? true),
  } as Env;
}
```

---

## No Analog Found

No files in this phase lack an analog. However, the following aspects have no existing codebase precedent and must be built from the RESEARCH.md specification:

| Aspect | Why No Analog | Where to Find the Pattern |
|--------|---------------|---------------------------|
| `outputSchema` in `registerTool` | Zero existing tools use `outputSchema` | RESEARCH.md Pattern 1 (SDK type signatures, verified) |
| `annotations` in `registerTool` | Zero existing tools use `annotations` | RESEARCH.md Pattern 1 (`ToolAnnotations` type) |
| `structuredContent` in handler return | Zero existing tools return `structuredContent` | RESEARCH.md Pattern 1 + SDK `mcp.d.ts` v1.29.0 |
| `z.discriminatedUnion` | Not used anywhere in current codebase | RESEARCH.md Pattern 3 (verified against zod@4.3.6) |
| `z.record(z.string(), z.unknown())` | Not used anywhere in current codebase | RESEARCH.md Pattern 2 (verified — single-arg form crashes) |
| `deriveErrorType` helper | No error-message-to-classification logic exists yet | RESEARCH.md Pattern 4 (verified against actual error strings) |
| Result enrichment wrapper (`runBatch`) | No batch enrichment wrapper exists yet | RESEARCH.md Pattern 4 (complete skeleton provided) |

---

## Critical Divergence Callout

The most important divergence between the analog and the new tool: **every existing `registerTool` call in `src/index.ts` returns only `{ content: [...] }` — no `outputSchema`, no `structuredContent`, no `annotations`.** The `code_assist_batch` tool is the repo's first structured-output tool. The planner must:

1. Add `outputSchema: BatchOutputSchema` to the config object (between `inputSchema` and the handler)
2. Add `annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }` to the config object
3. Return `{ content: [{ type: "text", text: summary }], structuredContent: enrichedResult }` from the non-error path
4. Ensure every `isError: true` return path does NOT include `structuredContent` (the SDK skips validation only when `isError: true` is set)

If any non-error return path omits `structuredContent`, the SDK throws `ProtocolError` before sending the response. The existing pattern (content-only return) is correct for the other 12 tools and WRONG for this one.

---

## Metadata

**Analog search scope:** `src/index.ts` (all 12 `registerTool` calls), `src/batch.ts`, `src/__tests__/batch.test.ts`, `src/__tests__/runtask.test.ts`, `src/__tests__/helpers.ts`
**Files scanned:** 5
**Pattern extraction date:** 2026-06-26
