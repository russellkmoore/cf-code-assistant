# Phase 7: Register `code_assist_batch` + Result Contract - Research

**Researched:** 2026-06-26
**Domain:** MCP TypeScript SDK structured-output tool registration + Zod v4 schema authoring + batch result enrichment
**Confidence:** HIGH

---

## Summary

Phase 7 wires the Phase 6 `executeBatch` engine and Phase 5 `runTask` executor into a single new
`code_assist_batch` MCP tool registered inside the existing `createMcpServer` closure. It is the
repo's **first structured-output tool**: it declares both an `inputSchema` and an `outputSchema`
with Zod, returns `structuredContent` alongside a `content` text summary, and sets MCP tool
annotations. No new runtime dependencies are introduced; the implementation is additive-only to
`src/index.ts` plus a new test file.

The core technical challenge is the **enrichment gap**: `executeBatch` (Phase 6) returns
`{total, succeeded, failed, results[]}` where each result is `{id, index, kind, status, result|error}`.
The Phase 7 contract requires `latency_ms` and `error_type` on every result entry, plus
`failedIds` and a text `summary` on the batch envelope. These four additions must be computed in
the **tool handler wrapper**, not inside `executeBatch` (which must stay unmodified to keep Phase 6
tests green). The cleanest strategy: inject a `runTask` adapter that returns `AIResult` (which
already carries `latency_ms`), then post-process the results array to extract latency from the ok
path and derive `error_type` from error message strings on the error path.

The MCP SDK (v1.29.0, installed) validates `structuredContent` against `outputSchema` **before
returning the response** — it throws a `ProtocolError` if `structuredContent` is missing or
fails schema parse. This means the tool handler MUST return a fully schema-conformant
`structuredContent` object on every non-error path. The existing `isError: true` escape hatch
skips output validation entirely and is safe for over-cap rejections and unexpected throws.

**Primary recommendation:** Implement Phase 7 as a single plan that (1) adds Zod schemas and a
`runBatch` enrichment wrapper to `src/index.ts`, (2) registers `code_assist_batch` in
`createMcpServer` using the existing `server.registerTool` pattern, and (3) adds
`src/__tests__/batch-tool.test.ts` with output-schema parse tests for all-ok and mixed batches.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| MCP tool registration / OAuth gate | API / Backend (`createMcpServer`) | — | All tools live in the `createMcpServer` closure; OAuth is applied at the `OAuthProvider` layer wrapping the entire MCP handler |
| Input schema validation (batch-level) | API / Backend (`registerTool` inputSchema Zod) | — | SDK validates input automatically before the handler is called |
| Per-task input validation (kind-specific) | API / Backend (`runTask` → `TASK_SPECS[kind].validate`) | — | Deferred into `runTask` to avoid rejecting the whole batch on one bad task |
| Batch execution (pool/timeout/order) | API / Backend (`executeBatch` in `src/batch.ts`) | — | Pure function, already implemented in Phase 6 |
| Result enrichment (latency_ms, error_type, failedIds, summary) | API / Backend (tool handler wrapper in `src/index.ts`) | — | Sits between `executeBatch` return and `structuredContent` construction |
| Output schema validation | API / Backend (MCP SDK `validateToolOutput`) | — | SDK performs this automatically when `outputSchema` is declared |
| OAuth / auth gate | API / Backend (`OAuthProvider`) | — | Inherited for free — all tools in `createMcpServer` are behind the same OAuth gate |

---

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| BATCH-07 | Each task returns `{id,index,kind,status:'ok',result,latency_ms}` or `{id,index,kind,status:'error',error,error_type,latency_ms}`; `error_type ∈ {timeout,validation,ai_error}`; per-task `input` is open record, per-kind validation inside `runTask` | Zod `z.discriminatedUnion('status', [...])` with `result:z.unknown()` and `z.literal` status values; `error_type: z.enum(['timeout','validation','ai_error'])`; `input: z.record(z.string(), z.unknown())` on the input schema side; enrichment wrapper derives error_type from error message strings |
| BATCH-08 | Batch summary has `total`, `succeeded`, `failed`, `failedIds` + short human-readable text block alongside structured results | `failedIds` is computed by the tool wrapper from the error results; text summary is a `content:[{type:'text',text}]` entry alongside `structuredContent` |
| BATCH-09 | `code_assist_batch` registered with Zod input+output schemas; returns `structuredContent` + text summary; annotations `readOnlyHint:false, destructiveHint:false, idempotentHint:false, openWorldHint:true` | SDK `registerTool` with `outputSchema:` and `annotations:` in config object; handler returns `{content:[...], structuredContent: {...}}`; SDK validates structuredContent before sending |
</phase_requirements>

---

## Standard Stack

### Core (all already installed — zero new packages)

| Library | Installed Version | Purpose | Why Standard |
|---------|-----------------|---------|--------------|
| `@modelcontextprotocol/sdk` | 1.29.0 [VERIFIED: npm registry] | `McpServer.registerTool` with `outputSchema` + `annotations` | The repo's existing MCP server framework; `registerTool` is the non-deprecated API |
| `zod` | 4.3.6 [VERIFIED: npm registry] | `inputSchema` shape, `outputSchema` Zod object, discriminated union | Already used in all 12 existing tools; Zod 4 is the SDK's required schema library |
| `src/batch.ts` | Phase 6 output | `executeBatch`, `readBatchConfig`, `BatchTask`, `TaskResult` | The pure batch engine; imported and injected in Phase 7 |
| `src/index.ts` exports | Phase 5 output | `runTask`, `ValidationError`, `TaskKind`, `createMcpServer` | The real executor and the server factory; `code_assist_batch` registers inside `createMcpServer` |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `agents/mcp` | 0.10.1 [VERIFIED: npm registry] | `createMcpHandler` wrapping | Already wired — no change needed in Phase 7 |

**No new npm packages.** Phase 7 is zero new deps, consistent with the v2.0 constraint.

### Package Legitimacy Audit

Phase 7 installs **no new packages**. All dependencies are already installed from prior phases.

| Package | Registry | slopcheck | Disposition |
|---------|----------|-----------|-------------|
| `@modelcontextprotocol/sdk` | npm | [OK] | Approved (pre-installed) |
| `zod` | npm | [OK] | Approved (pre-installed) |

**Packages removed due to slopcheck [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

---

## Architecture Patterns

### System Architecture Diagram

```
Claude client
     │ MCP call: code_assist_batch({tasks:[...]})
     ▼
OAuthProvider (OAuth gate — inherited, no Phase 7 change)
     │
     ▼
createMcpHandler → McpServer
     │  SDK validates inputSchema (Zod) → rejects invalid input before handler
     ▼
code_assist_batch handler (closure over env)
     │  readBatchConfig(env) → BatchConfig
     │  build timing-aware RunTask adapter wrapping runTask(env, kind, input)
     │  call executeBatch(tasks, cfg, adapter)
     │       ├─ per-task try/catch: ok → {id,index,kind,status:'ok',result:AIResult}
     │       └─ per-task catch: error → {id,index,kind,status:'error',error:string}
     │  enrich results (see Enrichment Pattern below)
     │       ├─ ok: extract latency_ms from (result as AIResult).latency_ms, result = AIResult.text
     │       └─ error: derive error_type from error string, latency_ms approximated
     │  build failedIds, summary string
     │  construct structuredContent (BatchOutputShape)
     │  SDK validates structuredContent against outputSchema → ProtocolError if mismatch
     ▼
Response: { content:[{type:'text',text:summary}], structuredContent:BatchOutputShape }
```

### Recommended Project Structure

```
src/
├── index.ts         — add BatchTaskInputSchema, BatchTaskResultSchema, BatchOutputSchema,
│                      deriveErrorType(), buildBatchTool(), register in createMcpServer
├── batch.ts         — UNTOUCHED (Phase 6 engine; import only)
└── __tests__/
    └── batch-tool.test.ts  — NEW: output schema parse tests (all-ok + mixed)
```

No new files except the test file. All schemas, the enrichment helper, and the tool registration live in `src/index.ts`, consistent with the single-file architecture documented in `CLAUDE.md`.

---

### Pattern 1: `registerTool` with outputSchema and annotations

**What:** The SDK's `registerTool` (non-deprecated API) accepts an optional `outputSchema` and
`annotations` in its config object. The handler must return `structuredContent` matching the schema.

**Critical SDK behavior (VERIFIED from SDK source):**
- If `outputSchema` is declared and handler returns without `structuredContent` → SDK throws `ProtocolError("Output validation error: Tool X has an output schema but no structured content was provided")`
- If `structuredContent` is present but fails schema parse → SDK throws `ProtocolError("Output validation error: Invalid structured content for tool X: ...")`
- If `isError: true` is set → output schema validation is **skipped entirely** (safe escape for error paths)

**Source:** [VERIFIED: Context7 /modelcontextprotocol/typescript-sdk, SDK source mcp.ts `validateToolOutput`]

```typescript
// Source: Context7 /modelcontextprotocol/typescript-sdk + installed mcp.d.ts v1.29.0
server.registerTool(
  "code_assist_batch",
  {
    description: "...",
    inputSchema: {
      tasks: z.array(BatchTaskInputSchema).min(1).max(50).describe("..."),
    },
    outputSchema: BatchOutputSchema,   // <-- z.object(...)
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  async ({ tasks }) => {
    try {
      const structured = await runBatch(env, tasks);
      const summary = buildSummary(structured);
      return {
        content: [{ type: "text", text: summary }],
        structuredContent: structured,   // must parse against BatchOutputSchema
      };
    } catch (err) {
      // over-cap or unexpected — isError:true skips outputSchema validation
      return makeToolError("INTERNAL_ERROR", "code_assist_batch");
    }
  },
);
```

**Key details from installed SDK (v1.29.0) type signatures:**
- `registerTool<OutputArgs extends ZodRawShapeCompat | AnySchema, InputArgs ...>(name, config, cb)` — `outputSchema` is typed as `OutputArgs`
- `inputSchema` can be a raw Zod shape object (flat `{ key: z.string() }`) or a `z.object(...)` — the SDK wraps raw shapes automatically
- `annotations` accepts `ToolAnnotations = { title?, readOnlyHint?, destructiveHint?, idempotentHint?, openWorldHint? }` — all booleans, all optional
- `outputSchema` must be a **Zod object schema** (not a raw shape) because the SDK calls `.parse()` on `structuredContent` against it

[VERIFIED: Context7 /modelcontextprotocol/typescript-sdk]

---

### Pattern 2: Input Schema — Open Record for Per-Task Input

**What:** Per-task `input` must be an open record (`z.record(z.string(), z.unknown())`) so that a
malformed task does NOT fail whole-batch schema parsing. Per-kind validation is deferred into
`runTask` → `TASK_SPECS[kind].validate?.(input)`.

**Why `z.record(z.string(), z.unknown())` not `z.record(z.unknown())`:**
In Zod v4, `z.record(valueType)` requires TWO arguments: key type + value type.
`z.record(z.string(), z.unknown())` is the correct form. `z.record(z.unknown())` crashes with
`TypeError: Cannot read properties of undefined (reading '_zod')`. [VERIFIED: local Node.js test]

```typescript
// Source: verified against installed zod@4.3.6
const BatchTaskInputSchema = z.object({
  id: z.string().optional().describe("Caller-assigned task ID (defaults to index string)"),
  kind: z.enum([
    "generateCode", "reviewCode", "transformCode", "scaffoldTests",
    "quickTask", "explainCode", "generateDocs", "generateTypes",
    "fixBug", "generateCommitMessage", "generateWorkerBoilerplate",
  ] as const).describe("Which code-assist tool to invoke"),
  input: z.record(z.string(), z.unknown()).describe(
    "Task-specific parameters. Validated per kind inside runTask, not at the batch boundary."
  ),
});
```

**Why NOT a discriminated union on `kind` at the MCP boundary:**
A discriminated union would run ALL per-kind field validations before the batch starts. One task
with a missing required field would cause the whole input schema parse to fail, rejecting every
task in the batch — exactly the outcome BATCH-07 and REQUIREMENTS.md §Out-of-Scope forbid.
[CITED: REQUIREMENTS.md §Out of Scope "Discriminated-union task input at the MCP boundary"]

---

### Pattern 3: Output Schema — Zod Discriminated Union with `as const` Literals

**What:** The output schema uses `z.discriminatedUnion('status', [...])` with `z.literal('ok')` and
`z.literal('error')` status fields. `result: z.unknown()` accepts any AI output without
constraining type. [VERIFIED: local Node.js test against installed zod@4.3.6]

```typescript
// Source: verified against installed zod@4.3.6
const TaskResultOkSchema = z.object({
  id: z.string(),
  index: z.number().int(),
  kind: z.string(),
  status: z.literal("ok"),
  result: z.unknown(),    // AI text output — keep z.unknown() not z.any()
  latency_ms: z.number(),
});

const TaskResultErrorSchema = z.object({
  id: z.string(),
  index: z.number().int(),
  kind: z.string(),
  status: z.literal("error"),
  error: z.string(),
  error_type: z.enum(["timeout", "validation", "ai_error"] as const),
  latency_ms: z.number(),
});

const TaskResultSchema = z.discriminatedUnion("status", [TaskResultOkSchema, TaskResultErrorSchema]);

export const BatchOutputSchema = z.object({
  total: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  failedIds: z.array(z.string()),
  results: z.array(TaskResultSchema),
  summary: z.string(),
});
```

**`z.unknown()` vs `z.any()` for `result`:**
Both pass `.parse()` in Zod v4 for any value. `z.unknown()` is preferred because:
1. It signals to schema consumers that the type is opaque (must be narrowed before use)
2. TypeScript infers `unknown` (safer) rather than `any` (unsafe)
3. The MCP SDK docs use `unknown` for `structuredContent` values [CITED: Context7, client.md comment "SEP-2106: structuredContent is unknown"]

[VERIFIED: local Node.js test — both all-ok and mixed batches parse against `BatchOutputSchema`]

---

### Pattern 4: Result Enrichment Wrapper (`runBatch` function)

**What:** A private `runBatch(env, tasks)` function called inside the tool handler that bridges
`executeBatch`'s plain output to the enriched schema-conformant shape.

**Enrichment gap between executeBatch output and Phase 7 contract:**

| Field | executeBatch produces | Phase 7 requires | Where to add |
|-------|-----------------------|------------------|-------------|
| `id` | Yes (`task.id ?? String(index)`) | Yes | Already present |
| `index` | Yes | Yes | Already present |
| `kind` | Yes | Yes | Already present |
| `status` | Yes (`'ok'` or `'error'`) | Yes | Already present |
| `result` | Yes (the raw return from `runTask`, which is `AIResult`) | Yes (AI text string) | Extract `.text` from `AIResult` |
| `latency_ms` | **No** (not tracked by executeBatch) | **Yes** | Extracted from `AIResult.latency_ms` on ok path; approximated on error path |
| `error` | Yes (on error entries) | Yes | Already present |
| `error_type` | **No** | **Yes** | Derived from error message string |
| `failedIds` | **No** (executeBatch returns `failed` count only) | **Yes** | Collected from error entries |
| `summary` (text) | **No** | **Yes** | Constructed from counts |

**Latency strategy for ok path:** `runTask` returns `AIResult: {text, model, latency_ms}`. Because
`executeBatch` stores the full `runTask` return value as `result: unknown`, the tool wrapper
can cast `(entry.result as AIResult).latency_ms`. The tool then sets `result = (entry.result as AIResult).text` (the AI output) and `latency_ms = (entry.result as AIResult).latency_ms`.

**Latency strategy for error path:** `executeBatch` stores only `err.message`, losing timing.
Approximation: parse the timeout ms from `'Task exceeded Xms timeout'` error messages;
use `0` for `validation` and `ai_error` (timing non-critical for failed tasks).

**`error_type` derivation:** Match against the error message string (case-insensitive):

```typescript
// Source: verified against actual error messages from executeBatch + runTask + withTimeout
function deriveErrorType(errMsg: string): "timeout" | "validation" | "ai_error" {
  const msg = errMsg.toLowerCase();
  if (msg.includes("timeout") || msg.includes("ai_timeout")) return "timeout";
  if (msg.includes("input_too_large") || msg.includes("validationerror")) return "validation";
  return "ai_error";
}
```

Error message sources (confirmed from reading `src/index.ts` and `src/batch.ts`):
- `withTimeout` throws: `"Task exceeded ${ms}ms timeout"` → `timeout`
- `callModel` throws: `"AI_TIMEOUT"` → `timeout` (matched by `ai_timeout` substring)
- `ValidationError` (from `TASK_SPECS[kind].validate`) has message `"INPUT_TOO_LARGE"` → `validation`
- All other AI errors (network, model errors) → `ai_error`

[VERIFIED: read `src/batch.ts:107` and `src/index.ts:136-166` and `src/index.ts:227-232`]

**Complete enrichment skeleton:**

```typescript
// Inside createMcpServer, before registering code_assist_batch:
async function runBatch(env: Env, rawTasks: z.infer<typeof BatchTaskInputSchema>[]) {
  const cfg = readBatchConfig(env as unknown as Record<string, string | undefined>);

  // Adapter: wrap real runTask; return AIResult so tool can extract latency_ms
  const adapter: RunTask = (batchTask, _signal) =>
    runTask(env, batchTask.kind, batchTask.input);

  const tasks: BatchTask[] = rawTasks.map((t, i) => ({
    id: t.id ?? String(i),
    kind: t.kind,
    input: t.input,
  }));

  const raw = await executeBatch(tasks, cfg, adapter);

  // Enrich results
  const results = raw.results.map((entry) => {
    if (entry.status === "ok") {
      const aiResult = entry.result as AIResult;
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
```

---

### Pattern 5: One-Line Wire into createMcpServer

**What:** The tool registration is a single `server.registerTool(...)` call appended inside
`createMcpServer`. It inherits the OAuth gate automatically because all tools registered on the
same `McpServer` instance are behind the same `OAuthProvider` wrapper.

**How existing tools are structured (confirmed by reading `src/index.ts:395-693`):**
- `createMcpServer(env: Env)` creates a `new McpServer(...)` and calls `server.registerTool` 12 times
- Each handler is an async closure that closes over `env`
- The `code_assist_batch` registration follows the identical pattern — one more `server.registerTool` call before `return server`

No changes to `OAuthProvider`, `createMcpHandler`, the default export, or any existing tool.
[VERIFIED: read `src/index.ts:395-692`]

---

### Anti-Patterns to Avoid

- **Missing `structuredContent` when `outputSchema` is declared:** The SDK throws `ProtocolError` before the response is sent. Every non-`isError:true` return MUST include `structuredContent`.
- **Discriminated union on `input` at the MCP boundary:** Would reject the whole batch if any task has a missing field. Use `z.record(z.string(), z.unknown())` and defer per-kind validation into `runTask`.
- **`z.record(z.unknown())` (one-argument form) in Zod v4:** Crashes at runtime with `TypeError: Cannot read properties of undefined (reading '_zod')`. Always use `z.record(z.string(), z.unknown())`. [VERIFIED: local test]
- **Putting enrichment inside `executeBatch`:** Modifying `executeBatch` to add `latency_ms`/`error_type` breaks Phase 6's type contract and its 8 passing tests. Keep enrichment in the tool wrapper only.
- **`z.any()` instead of `z.unknown()` for `result`:** Both parse identically but `z.any()` produces unsafe `any` TypeScript types. The MCP SDK docs recommend `unknown` for structured content values.
- **Forgetting `as const` on status literals:** Without `as const`, TypeScript infers `string` instead of `"ok"` | `"error"` literal types, breaking discriminated union narrowing.
- **Not returning `isError: true` from the over-cap throw path:** The over-cap throw from `executeBatch` propagates out of the tool handler. The try/catch around the `runBatch` call MUST return `makeToolError(...)` (which sets `isError:true`) — otherwise the SDK will try to validate the caught error against the output schema and throw a `ProtocolError`.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Input schema validation (per-task kind + required fields) | Custom validators | `TASK_SPECS[kind].validate?.(input)` inside `runTask` | Already tested in 153-test suite; zero duplication |
| Bounded concurrent pool | New pool implementation | `executeBatch` from `src/batch.ts` | Phase 6 engine, 8 tests, BATCH-03/04/05/06 verified |
| Per-task timeout | `Promise.race` implementation | `withTimeout` inside `executeBatch` | Already handles orphaned-promise late-settle safety |
| MCP output schema validation | Custom `structuredContent` validator | SDK `validateToolOutput` (automatic) | SDK does this for all tools with `outputSchema` declared |
| OAuth gating for the new tool | Middleware / separate auth | Register inside same `createMcpServer` | Inherited automatically |

**Key insight:** The entire Phase 7 is a thin adapter layer — schemas, enrichment, and registration. The hard machinery (pool, timeout, executor) is already built and tested.

---

## Common Pitfalls

### Pitfall 1: SDK Throws on Missing structuredContent
**What goes wrong:** Handler returns `{ content: [...] }` without `structuredContent` when `outputSchema` is declared. The SDK's `validateToolOutput` throws `ProtocolError` (code `InvalidParams`) before the response is sent. The client receives a protocol-level error, not the tool result.
**Why it happens:** Existing tools in the repo return only `{ content: [...] }` — this is correct for tools WITHOUT an `outputSchema`. The batch tool is the first to declare one.
**How to avoid:** Every non-error return path must include `structuredContent` that matches `BatchOutputSchema`. The over-cap path and unexpected throws must return `{ ..., isError: true }` to skip schema validation.
**Warning signs:** If the tool silently returns an error to the client even for a valid batch, check that `structuredContent` is present and parses against the schema.
[VERIFIED: SDK source `validateToolOutput` in mcp.ts via Context7]

### Pitfall 2: Zod v4 `z.record` Single-Argument Form Crashes at Runtime
**What goes wrong:** `z.record(z.unknown())` (one argument) passes TypeScript compilation but throws `TypeError: Cannot read properties of undefined (reading '_zod')` at runtime when parsing.
**Why it happens:** Zod v4 `z.record` requires both a key type and a value type. The single-argument signature was Zod v3 behavior.
**How to avoid:** Always `z.record(z.string(), z.unknown())`. [VERIFIED: local Node.js test against installed zod@4.3.6]
**Warning signs:** Runtime crash on the first call with a non-empty task input, even if TypeScript compiles cleanly.

### Pitfall 3: Losing `latency_ms` on Error Path
**What goes wrong:** `executeBatch` only stores `err.message` in the error entry — the timing data is lost. Attempting to read `(entry.result as AIResult).latency_ms` on an error entry crashes because `entry.result` is undefined for error entries.
**Why it happens:** `executeBatch` uses a `try/catch` that captures `error: err instanceof Error ? err.message : String(err)` only.
**How to avoid:** Check `entry.status` before casting: ok-path uses `(entry.result as AIResult).latency_ms`; error-path approximates from the error message (parse timeout ms from the message string, use `0` for non-timeout errors).
**Warning signs:** `undefined` latency_ms in the output, or TypeScript type errors when casting error entry's `result` field.

### Pitfall 4: `error_type` Not Matching Actual Error Messages
**What goes wrong:** `deriveErrorType` misclassifies `"AI_TIMEOUT"` (the actual string from `callModel`) as `"ai_error"` because the check is case-sensitive and looks for `"timeout"` but not `"AI_TIMEOUT"`.
**Why it happens:** The `callModel` throw uses the string `"AI_TIMEOUT"` (uppercase, underscore), while `withTimeout` uses `"Task exceeded Xms timeout"` (lowercase `timeout`). A case-sensitive `includes("timeout")` catches the latter but not the former.
**How to avoid:** Use `.toLowerCase()` before substring checks: `msg.toLowerCase().includes("timeout")` catches both `"AI_TIMEOUT"` and `"Task exceeded 45000ms timeout"`. [VERIFIED: local Node.js test — `"AI_TIMEOUT".toLowerCase().includes("timeout")` is `true`]

### Pitfall 5: Over-Cap Throw Not Caught → SDK Protocol Error
**What goes wrong:** `executeBatch` throws a `"Batch has N tasks but the per-call limit is M"` error when the pre-dispatch cap is exceeded. If the tool handler doesn't catch this and return `isError:true`, the SDK's executor catches it and calls `createToolError(err.message)` — which does set `isError:true` internally, but the SDK converts thrown errors to tool errors automatically. However, the `ProtocolError` path triggered by missing `structuredContent` on output schema tools is a different code path that the automatic error conversion does NOT handle the same way.
**How to avoid:** Wrap `runBatch(env, tasks)` in an explicit `try/catch` that returns `makeToolError("INTERNAL_ERROR", "code_assist_batch")` — which sets `isError:true`, skipping schema validation.
**Warning signs:** Client receives `ProtocolError` instead of a `CallToolResult` for over-cap batches.
[VERIFIED: SDK source `createToolError` path via Context7]

### Pitfall 6: `_registeredTools` Internal Access in Test
**What goes wrong:** The existing `runtask.test.ts` pattern uses `(server as any)._registeredTools[toolName].handler` to get a tool handler for direct invocation. This is an SDK internal that could change between SDK versions.
**How to avoid:** Document the warning (already present in `runtask.test.ts` line 7-8). The batch tool tests should prefer testing `runBatch()` directly (if exported) rather than going through the internal handler access, since `BatchOutputSchema.parse(result)` is the actual correctness guarantee.
**Warning signs:** Test throws `TypeError: Cannot read property 'handler' of undefined` after an SDK update.

---

## Code Examples

### Full outputSchema Declaration

```typescript
// Source: verified against installed zod@4.3.6 + Context7 /modelcontextprotocol/typescript-sdk
const TaskResultOkSchema = z.object({
  id: z.string(),
  index: z.number().int(),
  kind: z.string(),
  status: z.literal("ok"),
  result: z.unknown(),
  latency_ms: z.number(),
});

const TaskResultErrorSchema = z.object({
  id: z.string(),
  index: z.number().int(),
  kind: z.string(),
  status: z.literal("error"),
  error: z.string(),
  error_type: z.enum(["timeout", "validation", "ai_error"] as const),
  latency_ms: z.number(),
});

const BatchOutputSchema = z.object({
  total: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  failedIds: z.array(z.string()),
  results: z.array(z.discriminatedUnion("status", [TaskResultOkSchema, TaskResultErrorSchema])),
  summary: z.string(),
});
```

### Tool Registration Signature (from installed mcp.d.ts v1.29.0)

```typescript
// Source: node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts
registerTool<
  OutputArgs extends ZodRawShapeCompat | AnySchema,
  InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined
>(
  name: string,
  config: {
    title?: string;
    description?: string;
    inputSchema?: InputArgs;
    outputSchema?: OutputArgs;
    annotations?: ToolAnnotations;
    _meta?: Record<string, unknown>;
  },
  cb: ToolCallback<InputArgs>
): RegisteredTool;
```

The `ToolAnnotations` type (confirmed from installed `types.d.ts`):
```typescript
// Source: node_modules/@modelcontextprotocol/sdk/dist/esm/types.d.ts
type ToolAnnotations = {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};
```

### Test Pattern for Output Schema Validation

```typescript
// Source: established pattern from src/__tests__/batch.test.ts + runtask.test.ts
import { describe, it, expect, vi } from "vitest";
import { executeBatch } from "../batch";
import type { BatchTask, RunTask } from "../batch";
// BatchOutputSchema exported from src/index.ts (or a separate schemas file)

describe("BATCH-07/08: output schema parse", () => {
  it("all-ok batch parses against BatchOutputSchema", async () => {
    const runTask: RunTask = async (task, _signal) => ({
      text: "generated output",
      model: "@cf/qwen/qwen3-30b-a3b-fp8",
      latency_ms: 100,
    });
    const tasks: BatchTask[] = [
      { id: "t0", kind: "quickTask", input: { instruction: "do x" } },
    ];
    const raw = await executeBatch(tasks, { concurrency: 6, maxTasks: 50, taskTimeoutMs: 5000 }, runTask);
    // Enrichment (mirrors what the tool wrapper does)
    const enriched = enrichBatchResult(raw); // the Phase 7 helper
    expect(() => BatchOutputSchema.parse(enriched)).not.toThrow();
  });

  it("mixed batch (ok + error + timeout) parses against BatchOutputSchema", async () => {
    // ... similar pattern with 3 tasks, one ok, one throwing, one timing out
    const enriched = enrichBatchResult(raw);
    expect(() => BatchOutputSchema.parse(enriched)).not.toThrow();
    expect(enriched.failedIds).toHaveLength(2);
    expect(enriched.results[1].status).toBe("error");
    expect((enriched.results[1] as any).error_type).toBe("ai_error");
    expect((enriched.results[2] as any).error_type).toBe("timeout");
  });
});
```

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `server.tool(name, paramsSchema, cb)` | `server.registerTool(name, config, cb)` | SDK v1.x | `tool()` is deprecated; `registerTool` supports `outputSchema`, `annotations`, and `title` |
| Tools return only `{ content: [...] }` | Structured-output tools return `{ content: [...], structuredContent: {...} }` | SDK introduced `outputSchema` support | First tool in this repo to use structured output |
| Zod v3 `z.record(valueType)` (single arg) | Zod v4 `z.record(z.string(), valueType)` (two args) | Zod v4.0 | Breaking change — single-arg form crashes at runtime |

**Deprecated/outdated:**
- `server.tool(...)`: deprecated since SDK v1.x; use `server.registerTool(...)` (already followed by all 12 existing tools in this repo)
- Zod v3 import patterns: `import { z } from "zod"` still works in Zod 4 (it re-exports the v4 API) — no import change needed

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `latency_ms = 0` is acceptable for non-timeout error results | Pattern 4 | If the spec requires precise latency on error path, a side-channel timing approach is needed (more complex) |
| A2 | Deriving `error_type` from error message strings is stable across future changes to `callModel` and `ValidationError` | Pattern 4 / Pitfall 4 | If error messages are refactored, `error_type` classification could regress silently |
| A3 | `BatchOutputSchema` should be exported from `src/index.ts` for test-file import | Pattern 5 / Test Pattern | If kept module-private, the test cannot call `.parse()` against it |

**If this table were empty:** All claims were verified. Three remain assumed and are flagged above.

---

## Open Questions

1. **Should `result` on the ok path be `AIResult.text` (string) or the full `AIResult` object?**
   - What we know: ROADMAP §Phase 7 Success Criterion 1 says `{..., result, ...}` without specifying type; `result: z.unknown()` in the output schema accepts either
   - What's unclear: Whether callers expect a string or a richer object
   - Recommendation: Expose `AIResult.text` (the string output) as `result` — this matches the single-task tools' return behavior and what users expect from a code-assist tool. The `model` field on `AIResult` is an implementation detail.

2. **Should `BatchOutputSchema` be exported from `src/index.ts` for use in tests?**
   - What we know: `src/index.ts` already exports `runTask`, `TASK_SPECS`, `ValidationError`, etc. from the named test-export block
   - What's unclear: Whether the planner prefers schemas in a separate `src/schemas.ts` file
   - Recommendation: Add to the existing named export block in `src/index.ts` (consistent with the single-file architecture in `CLAUDE.md`). If exported, the test file can import and call `BatchOutputSchema.parse(...)` directly.

3. **Should `logToolInvocation` be called for batch tasks?**
   - What we know: STATE.md §Blockers says "Confirm `observability.test.ts` does not assert exactly one invocation log per request before deciding whether batch tasks emit `logToolInvocation`"
   - What's unclear: Whether the observability test constrains per-task logging
   - Recommendation: Log once at the batch level (total latency, succeeded/failed counts), not per task. Per-task logging would generate N log entries per request and is not currently tested. Defer per-task observability to a future phase.

---

## Environment Availability

Step 2.6 SKIPPED — Phase 7 is a pure code addition with no new external dependencies or services. All tools, bindings, and runtimes are already validated by Phases 1-6.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest 4.1.4 (installed, `@cloudflare/vitest-pool-workers` 0.14.3) |
| Config file | `vitest.config.mts` (existing) |
| Quick run command | `npx vitest run src/__tests__/batch-tool.test.ts` |
| Full suite command | `npm test` (153 existing + new batch-tool tests) |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| BATCH-07 | Output schema parses all-ok batch (latency_ms, status:'ok', result=string) | unit | `npx vitest run src/__tests__/batch-tool.test.ts -t "all-ok"` | ❌ Wave 0 |
| BATCH-07 | Output schema parses mixed batch (error_type='timeout', 'validation', 'ai_error') | unit | `npx vitest run src/__tests__/batch-tool.test.ts -t "mixed"` | ❌ Wave 0 |
| BATCH-07 | `error_type` derivation matches expected values for all three error message patterns | unit | `npx vitest run src/__tests__/batch-tool.test.ts -t "error_type"` | ❌ Wave 0 |
| BATCH-08 | `failedIds` array contains IDs of all error results in correct order | unit | `npx vitest run src/__tests__/batch-tool.test.ts -t "failedIds"` | ❌ Wave 0 |
| BATCH-08 | `summary` text block reflects correct succeeded/failed counts | unit | `npx vitest run src/__tests__/batch-tool.test.ts -t "summary"` | ❌ Wave 0 |
| BATCH-09 | Tool registered in `createMcpServer` (inherits OAuth gate) | unit | `npx vitest run src/__tests__/batch-tool.test.ts -t "registration"` | ❌ Wave 0 |
| BATCH-09 | `structuredContent + content` co-return verified via handler invocation | unit | `npx vitest run src/__tests__/batch-tool.test.ts -t "structuredContent"` | ❌ Wave 0 |
| BATCH-09 | Annotations present: readOnlyHint:false, destructiveHint:false, idempotentHint:false, openWorldHint:true | unit | inspect `server._registeredTools['code_assist_batch'].annotations` | ❌ Wave 0 |
| Regression | All 153 existing tests continue to pass | regression | `npm test` | ✅ (153 passing) |

### Sampling Rate

- **Per task commit:** `npx vitest run src/__tests__/batch-tool.test.ts`
- **Per wave merge:** `npm test` (full suite)
- **Phase gate:** Full suite green before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `src/__tests__/batch-tool.test.ts` — covers all BATCH-07/08/09 test cases above
- [ ] `BatchOutputSchema` exported from `src/index.ts` named test-export block (required for direct `.parse()` in tests)
- [ ] `deriveErrorType` exported from `src/index.ts` (or tested indirectly through enrichment function)

*(No framework install needed — vitest and the Workers pool are already configured)*

---

## Security Domain

`security_enforcement` key is absent from `.planning/config.json` — treated as enabled.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | No — inherited from existing OAuth gate | `OAuthProvider` (no change) |
| V3 Session Management | No — stateless MCP handler | `OAuthProvider` (no change) |
| V4 Access Control | No — single-owner server | Existing PIN auth |
| V5 Input Validation | Yes | `inputSchema` Zod validation (SDK-automatic) + per-kind inside `runTask` |
| V6 Cryptography | No | No new crypto surfaces |

### Known Threat Patterns

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Oversized task array (DoS) | Denial of Service | `z.array(...).max(50)` in inputSchema + `executeBatch` pre-dispatch cap check |
| Malformed per-task `input` (injection) | Tampering | Input is `z.record(z.string(), z.unknown())` — passed as-is to `runTask`; `TASK_SPECS[kind].buildPrompt` does string interpolation into prompts. Existing single-task tools face the same risk — no new surface |
| Batch amplifier (N tasks × Qwen cost) | Denial of Service | Max 50 tasks cap (BATCH-04), concurrency cap 6 (BATCH-03), per-task timeout 45s (BATCH-05) |
| `structuredContent` schema bypass | Tampering | SDK validates output schema on every response — cannot be bypassed except via `isError:true` |

---

## Sources

### Primary (HIGH confidence)
- `/modelcontextprotocol/typescript-sdk` (Context7) — `registerTool` outputSchema API, `validateToolOutput` source, annotations type, structuredContent pattern
- `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts` — installed v1.29.0 type signatures for `registerTool`, `ToolAnnotations`, `ToolCallback`
- `node_modules/@modelcontextprotocol/sdk/dist/esm/server/zod-compat.d.ts` — `AnySchema`, `ZodRawShapeCompat`, `SchemaOutput` types
- `src/batch.ts` — exact `executeBatch` return shape (verified by reading the implementation)
- `src/index.ts` — `runTask` signature, `AIResult` type, `createMcpServer` pattern, `ValidationError` message, `callModel` timeout string `"AI_TIMEOUT"`
- Local Node.js tests — verified Zod v4 `z.record(z.string(), z.unknown())` API, `z.discriminatedUnion`, `BatchOutputSchema.parse()` on all-ok and mixed payloads

### Secondary (MEDIUM confidence)
- `.planning/phases/06-batch-core-bounded-pool-timeout/06-CONTEXT.md` — D-03a boundary between Phase 6 and Phase 7 enrichment, `failedIds` and `latency_ms` as Phase 7 additions
- `.planning/phases/05-extract-shared-runtask-executor/05-01-SUMMARY.md` — `runTask` returns `AIResult`, `AIResult.latency_ms` availability

### Tertiary (LOW confidence)
- None — all critical claims verified against code or official docs

---

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — all packages installed and types confirmed from `node_modules`
- Architecture: HIGH — `registerTool` signature, `validateToolOutput` behavior, enrichment gap all verified from source
- Pitfalls: HIGH — each pitfall verified by reading SDK source or running local Node.js tests
- `error_type` derivation: MEDIUM — derived from reading current error message strings; could regress if messages change

**Research date:** 2026-06-26
**Valid until:** 2026-09-26 (SDK v1.29.0 is stable; Zod v4 API is stable; 90-day window)
