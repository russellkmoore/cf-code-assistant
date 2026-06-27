# Phase 8: Verify End-to-End — Research

**Researched:** 2026-06-26
**Domain:** Vitest / Cloudflare Workers pool — in-process MCP handler invocation and batch e2e testing
**Confidence:** HIGH (all findings read directly from actual repo source files in this session)

---

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**D-01:** No `build` script added. "Clean build" = `npx tsc --noEmit` clean + `npm test` green.
No `wrangler` invocation — purely offline, no network.

**D-01a:** No `wrangler deploy --dry-run` bundle check.

**D-02:** Proof is an automated in-process e2e test driving the real `createMcpServer` registered
`code_assist_batch` handler (same pattern as `batch-tool.test.ts`), with a mock `env`. MCP
Inspector run is optional / skipped.

**D-02a:** ROADMAP §Phase 8 SC#2/SC#3 wording "via MCP Inspector" is satisfied by the committed
automated e2e test. Verifier must NOT block for a missing Inspector session.

**D-02b:** OAuth is out of the e2e path — `createMcpServer(env)` is called directly; `OAuthProvider`
gate is already covered by `auth-flow.test.ts`.

**D-03:** Committed fast e2e runs in default `npm test` (all-mock, sub-second). Drives a 3-task
mixed batch through the real `createMcpServer`:
1. ok — valid `quickTask` input, mock AI returns text → `status:'ok'`
2. validation-fail — `transformCode` with >8KB input → `ValidationError` → `error_type:'validation'`
3. timeout — tiny `BATCH_TASK_TIMEOUT_MS` on env + mock AI that resolves just after it → `error_type:'timeout'`

**D-03a:** Use inverted durations (timeout/slow task earlier than ok task in input order) to prove
completion order ≠ input order. Assert `results[i].index === i` and kinds in input order.

**D-03b:** Assert: order-preserving partial results (all three present, correct statuses),
`structuredContent` co-returned with `content` text, `BatchOutputSchema.parse(structuredContent)`
does not throw, `summary` / `failedIds` reflect two failures.

**D-04:** Separate opt-in real-wait e2e in `describe.skip` — zero new config/scripts/deps. Run by
hand (un-skip). Keeps default suite ~2.3s.

**D-04a:** Opt-in test stays on AI mock. Timeout task hangs >45s → `withTimeout` (45s) and
`callModel`'s own `AbortController` (45s) race exactly as in production. No real Workers AI, no
charges, no network.

**D-04b:** Race is expected — opt-in test must assert LOOSELY (status:'error' present in order, no
hang, no unhandled rejection) and NOT hard-assert `error_type:'timeout'` vs `'ai_error'`.

### Claude's Discretion

- Exact new-test file organization (one `batch-e2e.test.ts` or two files) — provided fast block
  is in default `npm test` and real-wait block is `describe.skip`.
- Exact kinds for the ok task and oversized-input payload for the validation-fail task.
- Small `BATCH_TASK_TIMEOUT_MS` value and mock-AI delay for D-03 deterministic timeout.
- Wording of "how to run opt-in real-wait e2e" note.

### Deferred Ideas (OUT OF SCOPE)

- Actual MCP Inspector run + real-Workers-AI session.
- Per-task model observability in batch logging.
- BATCH-F01 true per-task cancellation.
- PROJECT.md docs-pass fix for `60000ms` vs `45000ms` stale text.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| BATCH-10 | A mixed batch (normal task, deliberately failing task, deliberately slow/timeout task) returns correct order-preserving partial results end-to-end, with single-task tools still passing and a clean build | Fully addressed: all three status paths exercised through the real `createMcpServer` handler via `_registeredTools` invocation pattern; batch ordering via `results[i].index === i`; single-task coverage from existing 161 passing tests; build gate = `npx tsc --noEmit` + `npm test` |
</phase_requirements>

---

## Summary

Phase 8 is a pure test-addition phase: no source changes, only one new test file
(`src/__tests__/batch-e2e.test.ts`). The existing `batch-tool.test.ts` already provides the
exact handler-invocation pattern — access `_registeredTools["code_assist_batch"]` on the
`McpServer` instance returned by `createMcpServer(env)`, call `tool.handler({tasks: [...]})`,
parse `structuredContent` against `BatchOutputSchema`. The e2e escalates that to a 3-task ordered
mixed batch. Every technique needed — the AI mock, the env construction, the `readBatchConfig`
env-var override, the `withTimeout` error message format, the `deriveErrorType` substring rules —
is directly visible in the existing source code and verified below.

The only technically tricky piece is the opt-in 45s-vs-45s race (D-04a/D-04b): `callModel` owns
its own internal `AbortController` that fires at `AI_TIMEOUT_MS = 45_000`, and `withTimeout` in
`executeBatch` also fires at `BATCH_TASK_TIMEOUT_MS` (default 45000ms). Both races resolve at the
same wall-clock instant; which wins is nondeterministic. The test must assert `status:'error'`
only, never `error_type`. This is documented in the locked decisions and must be reflected in the
test comment so future readers don't tighten the assertion into a flake.

**Primary recommendation:** Write `src/__tests__/batch-e2e.test.ts` with two top-level
`describe` blocks: (1) a normal `describe("BATCH-10: committed fast e2e ...")` that runs in
the default `npm test`, and (2) a `describe.skip("BATCH-10 opt-in: real-wait 45s ...")` that
is skip-by-default. The file is committed as-is; the fast block adds a small number of new tests
to the existing 161.

---

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Handler invocation | Test process (in-process) | — | `createMcpServer(env)` is called directly; no HTTP, no Worker runtime needed |
| Mock AI binding | `helpers.ts` `createMockAI` | Per-test `vi.fn()` override | `env.AI.run` is a vi.fn; tests can replace it per-scenario |
| Batch config override | `env` object extra properties | — | `readBatchConfig(env as Record<string,string|undefined>)` reads `BATCH_TASK_TIMEOUT_MS` directly from env object |
| Timeout enforcement | `withTimeout` in `batch.ts` | `callModel` internal `AbortController` | Both deadlines apply; `withTimeout` fires first when `BATCH_TASK_TIMEOUT_MS` < `AI_TIMEOUT_MS` |
| Order preservation | `executeBatch` index-write | — | `results[i]` written by index in `mapWithConcurrency`; always correct regardless of completion order |
| Validation-fail path | `runTask` → `TASK_SPECS[kind].validate()` | `deriveErrorType` | `ValidationError("INPUT_TOO_LARGE")` thrown inside `runTask`, propagated to `executeBatch` catch, message matched by `deriveErrorType` |

---

## Standard Stack

No new packages are added. This phase uses only what is already present.

### Core (already installed, no install needed)

| Library | Version (installed) | Purpose |
|---------|---------------------|---------|
| vitest | 4.1.4 | Test runner; `describe`, `it`, `expect`, `vi`, `describe.skip` all available |
| @cloudflare/vitest-pool-workers | 0.14.3 | Workers pool — provides the Cloudflare globals (`AbortController`, `TextEncoder`, etc.) that `batch.ts` and `index.ts` depend on |

### No New Packages

The `describe.skip` / opt-in skip mechanism requires zero new deps. `vi.fn()` provides
per-test AI mock control. No `p-limit`, no `p-map`, no test utilities beyond what is already
imported in the existing test files.

### Installation

None required.

---

## Package Legitimacy Audit

No new packages are installed in this phase.

| Package | Registry | Disposition |
|---------|----------|-------------|
| (none) | — | N/A |

---

## Architecture Patterns

### System Architecture Diagram

```
Test process (vitest Workers pool)
  │
  ├── createMcpServer(mockEnv)          ← real factory from src/index.ts
  │     └── registers code_assist_batch
  │
  ├── server._registeredTools["code_assist_batch"].handler({tasks})
  │     └── runBatch(tasks)             ← real closure over mockEnv
  │           └── readBatchConfig(env)  ← reads BATCH_TASK_TIMEOUT_MS from mockEnv
  │           └── executeBatch(tasks, cfg, adapter)   ← real batch engine
  │                 └── mapWithConcurrency → withTimeout → adapter(task, signal)
  │                       └── runTask(env, kind, input)
  │                             ├── TASK_SPECS[kind].validate?.(input)  → ValidationError (task 2)
  │                             └── runAIWithMetrics(env, ...)
  │                                   └── callModel(env, model, prompt, maxTokens)
  │                                         └── env.AI.run(...)   ← vi.fn() mock
  │
  └── result: { content, structuredContent }
        └── BatchOutputSchema.parse(structuredContent)  ← assertion
```

### Recommended Project Structure

```
src/__tests__/
├── batch-e2e.test.ts   ← NEW — this phase's only new file
│   ├── describe("BATCH-10: committed fast e2e ...")  ← in default npm test
│   └── describe.skip("BATCH-10 opt-in: real-wait 45s ...")  ← skip-by-default
└── (all other existing files untouched)
```

### Pattern 1: Fetching and Invoking the Registered Handler

This is the exact pattern from `src/__tests__/batch-tool.test.ts` lines 14–21 and 213–235:

```typescript
// Source: src/__tests__/batch-tool.test.ts lines 14-21
// WARNING: Accesses SDK internals (_registeredTools). If this breaks after an SDK update,
// check McpServer's internal structure for the new property name.
function getToolHandler(env: Env, toolName: string) {
  const server = createMcpServer(env);
  const tools = (server as any)._registeredTools;
  const tool = tools[toolName];
  if (!tool) throw new Error(`Tool "${toolName}" not registered`);
  return tool.handler;
}

// Invocation (from lines 216-235):
const handler = getToolHandler(env, "code_assist_batch");
const result = await handler({
  tasks: [
    { kind: "quickTask", input: { instruction: "say hello" } },
  ],
});
// result.content — MCP text array (the summary string)
// result.structuredContent — the BatchOutputSchema-shaped object
expect(() => BatchOutputSchema.parse(result.structuredContent)).not.toThrow();
```

The e2e test uses exactly this same `getToolHandler` helper (can be imported or inlined),
expanded to a 3-task mixed batch with order assertions.

### Pattern 2: Building a Mock Env with BATCH_TASK_TIMEOUT_MS Override

`readBatchConfig` signature: `(env: Record<string, string | undefined>): BatchConfig`

`runBatch` calls it as: `readBatchConfig(env as unknown as Record<string, string | undefined>)`

The `Env` interface (`src/index.ts` line 123-128) only declares `AI`, `OAUTH_KV`, `MCP_SECRET`,
`AUTH_RATE_LIMITER`. `BATCH_TASK_TIMEOUT_MS` is NOT in the `Env` type. However, `runBatch`
casts `env as unknown as Record<string, string | undefined>`, so any extra string property on
the env object will be picked up by `readBatchConfig`.

To pass a small timeout:

```typescript
// Construct env with the BATCH_TASK_TIMEOUT_MS override as an extra property
// TypeScript will complain if you try to add it to Env directly, so cast:
const env = {
  ...createMockEnv({ aiResponse: "ok output" }),
  BATCH_TASK_TIMEOUT_MS: "20",  // 20ms — withTimeout fires fast
} as unknown as Env;
```

`readBatchConfig` reads `env.BATCH_TASK_TIMEOUT_MS` as a string, converts via `Number("20") = 20`,
passes the `Number.isFinite(n) && n > 0` guard, returns `taskTimeoutMs: 20`. Confirmed by
`src/__tests__/batch.test.ts` lines 176-187 which passes string values directly to
`readBatchConfig({BATCH_TASK_TIMEOUT_MS: "30000.7"})`.

### Pattern 3: Per-Task Controllable AI Mock

`createMockAI` (helpers.ts line 23-27) returns:
```typescript
{ run: vi.fn(async () => ({ response })) }
```

The mock always returns the same response. For per-task control, replace `env.AI.run` with a
`vi.fn()` that checks call count or a flag:

```typescript
let aiCallCount = 0;
const delayedAI = {
  run: vi.fn(async () => {
    aiCallCount++;
    if (aiCallCount === 1) {
      // task 1 (ok): resolves immediately
      return { response: "generated output" };
    }
    // task 3 (timeout): hangs longer than BATCH_TASK_TIMEOUT_MS (20ms)
    await new Promise((r) => setTimeout(r, 100)); // 100ms >> 20ms timeout
    return { response: "late" };
  }),
} as unknown as Ai;

const env = {
  ...createMockEnv(),
  AI: delayedAI,
  BATCH_TASK_TIMEOUT_MS: "20",
} as unknown as Env;
```

Alternatively, since the timeout task arrives AFTER the ok task in the pool (inverted durations
proof requires timeout task at index 0, ok task at index 2), use a per-invocation flag or `vi.fn`
`.mockImplementationOnce`:

```typescript
const env = {
  ...createMockEnv(),
  AI: {
    run: vi.fn()
      .mockImplementationOnce(async () => {          // task 0 (timeout): hangs
        await new Promise((r) => setTimeout(r, 100));
        return { response: "late" };
      })
      .mockImplementationOnce(async () => {          // task 2 (ok): instant
        return { response: "generated output" };
      }),
  } as unknown as Ai,
  BATCH_TASK_TIMEOUT_MS: "20",
} as unknown as Env;
```

Note: the validation-fail task (task 1 — `transformCode` with >8KB input) never reaches
`env.AI.run` because `TASK_SPECS.transformCode.validate()` throws `ValidationError` first
(see `src/index.ts` line 274-279). No mock needed for it.

### Pattern 4: Validation-Fail Recipe

```typescript
// Source: src/index.ts lines 273-280 — transformCode validate()
validate: (input) => {
  const { code } = input as { code: string };
  const codeBytes = new TextEncoder().encode(code).byteLength;
  if (codeBytes > TRANSFORM_CODE_MAX_BYTES) {     // TRANSFORM_CODE_MAX_BYTES = 8_000
    throw new ValidationError("INPUT_TOO_LARGE", { codeBytes });
  }
},
```

`ValidationError` extends `Error`; its message is `"INPUT_TOO_LARGE"`.

```typescript
// deriveErrorType (src/index.ts lines 445-450):
function deriveErrorType(errMsg: string): "timeout" | "validation" | "ai_error" {
  const msg = errMsg.toLowerCase();
  if (msg.includes("timeout") || msg.includes("ai_timeout")) return "timeout";
  if (msg.includes("input_too_large") || msg.includes("validationerror")) return "validation";
  return "ai_error";
}
```

`"INPUT_TOO_LARGE".toLowerCase() = "input_too_large"` → matches `msg.includes("input_too_large")`
→ returns `"validation"`. Deterministic.

The oversized input is any string whose UTF-8 encoding exceeds 8000 bytes. A simple recipe:
`"x".repeat(8001)` = 8001 bytes (all ASCII). Or `"a".repeat(9000)`.

```typescript
// validation-fail task — no AI call, no AI mock needed
{ kind: "transformCode", input: { code: "x".repeat(8001), instruction: "add types" } }
```

### Pattern 5: Deterministic Timeout Recipe

```typescript
// withTimeout exact throw (src/batch.ts line 106-107):
const timer = setTimeout(() => {
  ctrl.abort();
  reject(new Error(`Task exceeded ${ms}ms timeout`));
}, ms);
```

With `BATCH_TASK_TIMEOUT_MS = "20"`:
- `withTimeout(20, ...)` fires after 20ms
- Throws `new Error("Task exceeded 20ms timeout")`
- `deriveErrorType("Task exceeded 20ms timeout")` → `"task exceeded 20ms timeout".toLowerCase()`
  → contains `"timeout"` → returns `"timeout"`

To make the timeout fire deterministically, the mock AI for the timeout task must resolve AFTER
20ms. A `setTimeout(r, 100)` inside the mock provides 5x margin. The batch itself returns quickly
because `withTimeout` resolves immediately on the error path.

Timeout task `latency_ms` in enriched output: the `runBatch` enrichment parses
`/exceeded (\d+)ms timeout/` from the error message (src/index.ts line 781):
```typescript
const timeoutMatch = entry.error.match(/exceeded (\d+)ms timeout/);
const latency_ms = timeoutMatch ? parseInt(timeoutMatch[1], 10) : 0;
```
Result: `latency_ms = 20` for the timeout task.

### Pattern 6: Order-Preservation Assertion Setup

To prove order-preservation with inverted completion order (D-03a), the 3-task input must have:
- Index 0: slow/timeout task (completes last or errors first due to `withTimeout`)
- Index 1: validation-fail task (errors synchronously, completes very fast)
- Index 2: ok task (completes fast)

Because validation-fail errors synchronously inside `runTask` before any async step, and
timeout errors after 20ms, the completion order would be: task 1 first, task 2 next, task 0
last (after timeout fires). Yet the output array must maintain index order: 0, 1, 2.

```typescript
const tasks = [
  { kind: "transformCode", input: { code: "x".repeat(8001), instruction: "add types" } }, // index 0: validation-fail
  { kind: "quickTask",     input: { instruction: "say hello" } },                          // index 1: ok
  { kind: "transformCode", input: { code: "x".repeat(8001), instruction: "add types" } }, // index 2: validation-fail
];
```

Wait — to get ALL three statuses (ok, validation, timeout) with inverted durations, consider:

```typescript
const tasks = [
  // index 0: TIMEOUT task — slow (hangs 100ms, BATCH_TASK_TIMEOUT_MS=20ms fires first)
  { kind: "quickTask", input: { instruction: "timeout this" } },
  // index 1: VALIDATION-FAIL task — errors synchronously (fastest to complete)
  { kind: "transformCode", input: { code: "x".repeat(8001), instruction: "add types" } },
  // index 2: OK task — resolves instantly (mock returns immediately)
  { kind: "quickTask", input: { instruction: "say hello" } },
];
// Completion order: task 1 (sync), task 2 (instant async), task 0 (after 20ms timeout)
// Output order: [0, 1, 2] always — results[i].index === i
```

Assertions:
```typescript
expect(sc.results[0].index).toBe(0);
expect(sc.results[1].index).toBe(1);
expect(sc.results[2].index).toBe(2);
expect(sc.results[0].status).toBe("error");
expect((sc.results[0] as any).error_type).toBe("timeout");
expect(sc.results[1].status).toBe("error");
expect((sc.results[1] as any).error_type).toBe("validation");
expect(sc.results[2].status).toBe("ok");
expect(sc.failedIds).toEqual(["0", "1"]);   // default IDs when id is omitted: String(index)
```

Note: `BatchTaskInputSchema` has `id` as optional (`z.string().optional()`). When omitted, `runBatch`
assigns `id: t.id ?? String(i)` (src/index.ts line 761), so task ids are "0", "1", "2".

### Pattern 7: Skip-by-Default Opt-In Test

`describe.skip` is available in vitest 4.1.4 (confirmed: `typeof describe.skip === "function"`).
The existing test suite uses zero `.skip` calls — this is the first use.

```typescript
// In src/__tests__/batch-e2e.test.ts — bottom of file, after the committed fast block:

// NOTE TO FUTURE READER:
// This block exercises the real 45s-wall-clock timeout race. Un-skip to run it manually.
// It uses a hanging AI mock (no network, no charges). The batch withTimeout (45s) and
// callModel's own internal AbortController (AI_TIMEOUT_MS = 45s) race simultaneously;
// which settles first is genuinely nondeterministic (D-04b). Assert status:'error' only.
describe.skip("BATCH-10 opt-in: real-wait 45s timeout race (un-skip to run)", () => {
  it("batch returns status:error for hanging task without hanging the process", async () => {
    // ...
  }, 60_000); // 60s test timeout to accommodate the 45s deadline
});
```

The `describe.skip` causes vitest to report it as "skipped" (0 ms) in verbose output — it will
NOT cause the suite to fail and will NOT run in `npm test`. The comment inside the block
documents the race and why the assertion is loose (D-04b).

### Anti-Patterns to Avoid

- **Using `it.todo` instead of `describe.skip`:** `it.todo` counts as a pending test in verbose
  output and is still listed. `describe.skip` is cleaner for an entire block with its own setup.
- **Hard-asserting `error_type` in the opt-in 45s test:** The two 45s deadlines race; which
  fires first is unpredictable. Assert only `status:'error'` and that the batch settled without
  hanging (no unhandled rejection). See D-04b.
- **Using `vi.spyOn(env, 'AI')` instead of constructing a fresh mock object:** `createMockEnv`
  returns a plain object; `vi.spyOn` works on method properties. Constructing a new `vi.fn()`
  is simpler and avoids interaction with the pre-existing `createMockAI` result.
- **Adding `BATCH_TASK_TIMEOUT_MS` to the `Env` interface:** It is intentionally NOT in `Env`
  (it is a runtime env var read via `env as unknown as Record<string,string|undefined>`). Do not
  modify `src/index.ts` or `worker-configuration.d.ts` — both files are out of scope.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Ordered result assertions | Custom sort/compare | `results[i].index === i` — `executeBatch` already writes to `results[i]` by index | Engine guarantees order; just assert the index fields |
| Timeout in test | `setTimeout` + Promise.race in test | `BATCH_TASK_TIMEOUT_MS` env override + hanging mock AI | Drives the REAL `withTimeout` in `batch.ts`; proves the production code path |
| Validation error in test | Throw manually from a custom RunTask | Oversized `transformCode` input | Exercises the REAL `TASK_SPECS.transformCode.validate()` seam inside `runTask` |
| Schema assertion | Manual field-by-field check | `BatchOutputSchema.parse(sc)` — throws on violation | Exercises the Zod schema itself as part of the contract assertion |

---

## Common Pitfalls

### Pitfall 1: BATCH_TASK_TIMEOUT_MS Type Mismatch

**What goes wrong:** Passing `BATCH_TASK_TIMEOUT_MS: 20` (number) instead of `"20"` (string)
on the env override object. `readBatchConfig` calls `Number(v)` where `v` is `string | undefined`;
if `v` is already a number, `Number(20) = 20` still works. However, the TypeScript signature of
`readBatchConfig` is `Record<string, string | undefined>`, and the cast in `runBatch` is
`env as unknown as Record<string, string | undefined>`. If the test object has a numeric value,
TypeScript may not error (the cast is `as unknown`) but it's cleaner to use the string form
consistent with actual env var behavior.

**How to avoid:** Always pass `BATCH_TASK_TIMEOUT_MS: "20"` (string), matching how Cloudflare
Workers env vars are typed.

### Pitfall 2: AI Mock Call Order Mismatch with Pool Concurrency

**What goes wrong:** Using `.mockImplementationOnce` keyed on the order of calls to `env.AI.run`
assumes tasks run in input order. But `mapWithConcurrency` dispatches workers eagerly — with
concurrency 3 and 3 tasks, all 3 may start nearly simultaneously. The validation-fail task (index
1) never reaches `env.AI.run` (validate throws before the AI call), so the AI mock is only called
for task 0 (timeout) and task 2 (ok). If the test assumes the first `.mockImplementationOnce`
goes to task 0 and the second to task 2, this holds because the validation-fail task skips AI
entirely.

**How to avoid:** Structure AI mock so: first call → hanging Promise (for the timeout task at
index 0); second call → instant response (for the ok task at index 2). Document which task
triggers which call.

### Pitfall 3: Missing `npm run types` Before `npx tsc --noEmit`

**What goes wrong:** `worker-configuration.d.ts` is gitignored (confirmed in `.gitignore` line 5).
Phase 07 SUMMARY.md §Auto-added items documents that `npx tsc --noEmit` returned
`Cannot find type definition file for './worker-configuration.d.ts'` when the file was missing.
The file currently exists in the worktree (verified: 471KB), so tsc passes today. However, in a
fresh clone or after `wrangler types` is not run, tsc fails.

**How to avoid:** The build gate task in the plan must include `npm run types` as a prerequisite
before `npx tsc --noEmit`. This is a pre-existing repo requirement, not new to Phase 8.

### Pitfall 4: Opt-In Test Test-Timeout Too Short

**What goes wrong:** vitest has a default per-test timeout (configurable; vitest 4.x default is
5000ms). The opt-in 45s-wait test will time out before `withTimeout` fires if the test timeout
is not extended.

**How to avoid:** Pass an explicit timeout as the third argument to `it`:
```typescript
it("...", async () => { ... }, 60_000);  // 60s gives 15s margin over the 45s deadline
```

### Pitfall 5: asserting `error_type:'timeout'` in the Opt-In Test

**What goes wrong:** `callModel` owns an internal `AbortController` that fires at
`AI_TIMEOUT_MS = 45_000`. If the AbortController fires first, it rejects with `"AI_TIMEOUT"` →
`deriveErrorType("ai_timeout") = "timeout"`. If `withTimeout` fires first, it rejects with
`"Task exceeded 45000ms timeout"` → `deriveErrorType` → `"timeout"`. BUT if the hanging mock
AI's promise rejects with an unrelated error, or if the test environment resolves the timer in a
different order, the `error_type` might not be `"timeout"`. Actually both paths resolve to
`"timeout"` in this case, but the race still means the error message and source differ.

More precisely: at 45s, `callModel`'s AbortController fires first (or simultaneously with
`withTimeout`). The `AbortController.abort()` triggers the `timeoutPromise` rejection with
`"AI_TIMEOUT"` BEFORE `withTimeout`'s `setTimeout` fires (both are ~45s, timing is
nondeterministic). If `callModel` rejects first (with "AI_TIMEOUT"), `withTimeout`'s `run()`
reject handler fires and `withTimeout` rejects with "AI_TIMEOUT" — `error_type` becomes
"timeout". If `withTimeout`'s timer fires first, it rejects with "Task exceeded 45000ms" —
also `error_type:'timeout'`. In BOTH outcomes `error_type` is "timeout". The phase 6 context
(D-01a) says the race makes the source nondeterministic but the context was about the _message_.

Regardless: D-04b LOCKS that the opt-in test must assert loosely — do not assert `error_type`
at all. The reason is that the two deadlines are too close and the behavior may vary across
environments / test runners. Assert only `status:'error'` and that the batch did not hang.

### Pitfall 6: SDK Internals Breaking on Update

**What goes wrong:** `(server as any)._registeredTools` is an SDK-internal property. If
`@modelcontextprotocol/sdk` is updated past 1.29.0, this property name may change.

**How to avoid:** The existing `batch-tool.test.ts` uses this pattern with a comment warning
(line 16-17): "If this breaks after an SDK update, check McpServer's internal structure for the
new property name." The e2e test should carry the same warning comment. This is a known accepted
risk in the repo — no mitigation beyond the comment.

---

## Code Examples

### Complete Committed Fast E2E Pattern

```typescript
// Source: mirrors src/__tests__/batch-tool.test.ts invocation pattern
import { describe, it, expect, vi } from "vitest";
import { createMcpServer, BatchOutputSchema } from "../index";
import { createMockEnv } from "./helpers";

// Reuse the same helper — or inline it if the e2e file is self-contained:
function getToolHandler(env: Env, toolName: string) {
  const server = createMcpServer(env);
  const tools = (server as any)._registeredTools;
  const tool = tools[toolName];
  if (!tool) throw new Error(`Tool "${toolName}" not registered`);
  return tool.handler;
}

describe("BATCH-10: committed fast e2e — 3-task mixed batch through createMcpServer", () => {
  it(
    "returns order-preserving partial results with all three statuses",
    async () => {
      // Task 0: TIMEOUT (index 0, completes last — proves inverted completion order)
      // Task 1: VALIDATION-FAIL (index 1, completes first — synchronous throw, no AI call)
      // Task 2: OK (index 2, completes second — instant AI mock)
      // This ordering proves result[i].index === i regardless of completion order.

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
        // readBatchConfig reads BATCH_TASK_TIMEOUT_MS as string via the env cast
        BATCH_TASK_TIMEOUT_MS: "20",
      } as unknown as Env;

      const handler = getToolHandler(env, "code_assist_batch");
      const result = await handler({
        tasks: [
          // index 0: TIMEOUT — AI mock hangs, withTimeout(20ms) fires first
          { kind: "quickTask", input: { instruction: "hang" } },
          // index 1: VALIDATION-FAIL — transformCode validate() throws INPUT_TOO_LARGE
          { kind: "transformCode", input: { code: "x".repeat(8001), instruction: "add types" } },
          // index 2: OK — AI mock returns instantly
          { kind: "quickTask", input: { instruction: "say hello" } },
        ],
      });

      // Structural shape
      expect(result.content).toBeDefined();
      expect(result.content[0].type).toBe("text");
      expect(result.structuredContent).toBeDefined();
      const sc = result.structuredContent as any;

      // Schema parse (exercises the Zod contract itself)
      expect(() => BatchOutputSchema.parse(sc)).not.toThrow();

      // Totals
      expect(sc.total).toBe(3);
      expect(sc.succeeded).toBe(1);
      expect(sc.failed).toBe(2);

      // Order-preservation — results[i].index === i regardless of completion order
      expect(sc.results[0].index).toBe(0);
      expect(sc.results[1].index).toBe(1);
      expect(sc.results[2].index).toBe(2);

      // Statuses
      expect(sc.results[0].status).toBe("error");
      expect(sc.results[1].status).toBe("error");
      expect(sc.results[2].status).toBe("ok");

      // error_type classification
      expect(sc.results[0].error_type).toBe("timeout");
      expect(sc.results[1].error_type).toBe("validation");

      // latency_ms on timeout entry: parsed from "Task exceeded 20ms timeout" → 20
      expect(sc.results[0].latency_ms).toBe(20);

      // ok result
      expect(sc.results[2].result).toBe("generated output");

      // failedIds — task ids are String(index) when id is omitted
      expect(sc.failedIds).toEqual(["0", "1"]);

      // summary reflects failures
      expect(sc.summary).toContain("1/3 tasks succeeded");
      expect(sc.summary).toContain("2 failed");
    },
    5000, // 5s wall-clock ceiling — withTimeout fires at 20ms, test is sub-100ms
  );
});
```

### Opt-In 45s Real-Wait Test Pattern

```typescript
// NOTE TO FUTURE READER:
// This block exercises the real 45s wall-clock timeout race. Un-skip to run it by hand.
// It uses a hanging AI mock (offline, no Workers AI charges, no network credentials).
//
// WHY THE ASSERTION IS LOOSE (D-04b):
// callModel's internal AbortController fires at AI_TIMEOUT_MS = 45_000ms.
// withTimeout in executeBatch also fires at BATCH_TASK_TIMEOUT_MS = 45_000ms (default).
// Both deadlines fire at the same instant; which settles first is nondeterministic.
// If callModel's AbortController fires first → error message is "AI_TIMEOUT"
//   → deriveErrorType("ai_timeout") = "timeout".
// If withTimeout fires first → error message is "Task exceeded 45000ms timeout"
//   → deriveErrorType(...) = "timeout".
// In both cases error_type is "timeout", but the race means we cannot rely on the exact
// error message or settlement order. Assert only status:'error' and no hang.
// Do NOT tighten this to assert error_type — it will flake on slow CI runners.
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
        // Use the default 45s timeout (BATCH_TASK_TIMEOUT_MS not overridden)
      } as unknown as Env;

      const handler = getToolHandler(env, "code_assist_batch");
      const result = await handler({
        tasks: [
          { kind: "quickTask", input: { instruction: "hang indefinitely" } },
          { kind: "quickTask", input: { instruction: "ok" } },  // completes after the hang resolves
        ],
      });

      const sc = result.structuredContent as any;
      expect(sc.results).toHaveLength(2);

      // Loose assertion only — see comment above re: the 45s race
      const hangingResult = sc.results[0];
      expect(hangingResult.status).toBe("error");
      // Do NOT assert error_type:'timeout' specifically — the 45s race is nondeterministic.
      // Asserting status:'error' and no unhandled rejection is sufficient proof.
    },
    60_000, // 60s per-test timeout — 45s deadline + 15s margin
  );
});
```

---

## Runtime State Inventory

This is a greenfield test-addition phase (one new file under `src/__tests__/`). No renames, no
refactors, no migrations. Runtime State Inventory is not applicable.

---

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Timeout mechanism in tests | A `Promise.race` inside the test | `BATCH_TASK_TIMEOUT_MS: "20"` env override | Tests the real `withTimeout` production code path |
| Validation failure | Manually throw in a test RunTask | `transformCode` with `>8KB` input | Tests the real `TASK_SPECS.transformCode.validate()` seam |
| Schema validation | Manual field-by-field property check | `BatchOutputSchema.parse(sc)` | Exercises the real Zod schema |
| Skip mechanism | New vitest config / test script | `describe.skip` | Zero new deps/scripts; built into vitest 4.1.4 |
| Order verification | Sort and compare arrays | Assert `results[i].index === i` | `mapWithConcurrency` writes index; this is the direct contract check |

---

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| No tests | 161 tests, Workers pool, `@cloudflare/vitest-pool-workers` | Phases 3-7 | Tests run in Cloudflare Workers globals environment |
| Unit tests only for batch engine | Handler-level invocation via `_registeredTools` | Phase 7 (`batch-tool.test.ts`) | Drives the real MCP tool registration layer |
| No structured output tests | `BatchOutputSchema.parse(structuredContent)` | Phase 7 | Zod schema is itself exercised in tests |

**Deprecated / not applicable:**
- `cloudflare:test` env from vitest-pool-workers: This pool provides Cloudflare globals
  automatically; tests do NOT need to import from `cloudflare:test`. The `env` object is
  hand-constructed (`createMockEnv`) not injected by the pool (confirmed: `helpers.ts` builds
  a plain object, not a `cloudflare:test` env).

---

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `vi.fn().mockImplementationOnce` calls are ordered by invocation (not by task index) | Pattern 3 / Code Example | If pool dispatches differ, the timeout mock may hit the wrong task — test could flip to wrong `error_type`. Mitigation: use large enough delay (100ms vs 20ms) so timing is robust regardless of which task gets which mock call, and verify with `expect(env.AI.run).toHaveBeenCalledTimes(2)` |
| A2 | `worker-configuration.d.ts` will remain present through Phase 8 execution | Pitfall 3 / Build Gate | If file is deleted (e.g., fresh clone, `wrangler types` reverts it), `npx tsc --noEmit` fails. Plan must include `npm run types` as a prerequisite step |

**All other claims are VERIFIED from reading the actual source files in this session.**

---

## Open Questions

1. **Single test file vs two files**
   - What we know: `describe.skip` works in one file alongside normal `describe`
   - What's unclear: User/planner preference for file organization (declared as Claude's Discretion)
   - Recommendation: Use a single `batch-e2e.test.ts` with both blocks — simpler review, one
     new file, the `describe.skip` block is clearly labeled and at the bottom

2. **Task IDs for `failedIds` assertion**
   - What we know: When `id` is omitted, `runBatch` assigns `id: t.id ?? String(i)`
   - What's unclear: The BatchTaskInputSchema allows optional `id`; the e2e tasks could also
     use explicit ids like `"timeout"`, `"validate"`, `"ok"` for clearer failure messages
   - Recommendation: Use explicit IDs (`id: "timeout-task"`, `id: "validate-task"`, `id: "ok-task"`)
     for self-documenting failedIds assertions (`["timeout-task", "validate-task"]`)

---

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|-------------|-----------|---------|----------|
| vitest | npm test | Yes | 4.1.4 | — |
| @cloudflare/vitest-pool-workers | Workers globals in tests | Yes | 0.14.3 | — |
| worker-configuration.d.ts | npx tsc --noEmit | Yes (present) | generated | Run `npm run types` |
| describe.skip | Opt-in test | Yes (function) | built-in vitest 4.1.4 | — |
| vi.fn().mockImplementationOnce | Per-task AI mock | Yes | built-in vitest | vi.fn() with call counter |

**Missing dependencies with no fallback:** None.

**Missing dependencies with fallback:** None.

**Note on worker-configuration.d.ts:** The file is gitignored and auto-generated by
`npm run types` (`wrangler types`). It currently exists in the worktree. The plan must include
`npm run types` before `npx tsc --noEmit` as a prerequisite step to avoid the Phase 07 re-run
of this issue.

---

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest 4.1.4 with @cloudflare/vitest-pool-workers 0.14.3 |
| Config file | `vitest.config.mts` (root) |
| Quick run command | `npm test -- -t "BATCH-10"` |
| Full suite command | `npm test` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| BATCH-10 | Mixed batch (ok + validation + timeout) returns order-preserving partial results through real `createMcpServer` | e2e (handler-level) | `npm test -- -t "BATCH-10"` | No — Wave 0 creates `src/__tests__/batch-e2e.test.ts` |
| BATCH-10 | Single-task tools still pass their existing tests | unit / handler | `npm test` (full suite) | Yes — existing 11 test files |
| BATCH-10 | Build gate: `npx tsc --noEmit` clean | static analysis | `npm run types && npx tsc --noEmit` | Yes — no file changes |

### Sampling Rate

- **Per task commit:** `npm test -- -t "BATCH-10"` (sub-5s)
- **Per wave merge:** `npm test` (full 161+ suite, ~2s)
- **Phase gate:** Full suite green + `npx tsc --noEmit` clean before marking BATCH-10 complete

### Wave 0 Gaps

- [ ] `src/__tests__/batch-e2e.test.ts` — covers BATCH-10 (both committed fast block and skip-by-default real-wait block)

*(All other test infrastructure — vitest config, helpers.ts, 11 existing test files — already exists. No new config, scripts, or dependencies.)*

---

## Security Domain

This phase adds test code only. No new network endpoints, auth paths, tool registrations, or
production code changes. No new ASVS categories apply.

The `code_assist_batch` tool itself was security-reviewed in Phase 07's threat surface scan
(T-7-01 through T-7-04, all mitigated). The e2e test drives the same registered handler under
the same `OAuthProvider` gate (which is already covered by `auth-flow.test.ts`; the e2e bypasses
OAuth by calling `createMcpServer` directly per D-02b — this is the correct test architecture
for unit/integration testing the tool logic independently of auth).

---

## Sources

### Primary (HIGH confidence — all read directly from repo source files)

- `src/index.ts` — `createMcpServer`, `code_assist_batch` registration (lines 807-850),
  `BatchOutputSchema` (lines 436-443), `deriveErrorType` (lines 445-450), `runBatch` (lines
  751-805), `runTask` (lines 388-393), `TASK_SPECS.transformCode.validate()` (lines 273-280),
  `ValidationError` (lines 229-234), `AI_TIMEOUT_MS = 45_000` (line 28),
  `TRANSFORM_CODE_MAX_BYTES = 8_000` (line 33), `callModel` internal AbortController
  (lines 138-145)
- `src/batch.ts` — `withTimeout` exact throw message `"Task exceeded ${ms}ms timeout"` (line 107),
  `readBatchConfig` env var names + defaults (lines 27-41), `executeBatch` index-write logic
  (lines 128-142), `mapWithConcurrency` (lines 78-95)
- `src/__tests__/batch-tool.test.ts` — `getToolHandler` pattern (lines 14-21), handler
  invocation and `structuredContent` assertion (lines 213-235), `BatchOutputSchema.parse` usage
- `src/__tests__/batch.test.ts` — `readBatchConfig` string-value test (lines 176-187), timeout
  test with `taskTimeoutMs: 10` (lines 122-136), order-preservation test (lines 84-116)
- `src/__tests__/helpers.ts` — `createMockEnv` signature and `createMockAI` (lines 23-54)
- `vitest.config.mts` — `cloudflarePool`, `remoteBindings: false`, pool configuration
- `package.json` — `"test": "vitest run --reporter=verbose"`, vitest 4.1.4, no `build` script
- `.gitignore` line 5 — `worker-configuration.d.ts` confirmed gitignored
- vitest 4.1.4 runtime check — `typeof describe.skip === "function"` confirmed

### Secondary (MEDIUM confidence)

- None needed — all claims sourced from direct file reads.

### Tertiary (LOW confidence)

- None.

---

## Metadata

**Confidence breakdown:**
- Handler invocation pattern: HIGH — copied verbatim from `batch-tool.test.ts`
- `BATCH_TASK_TIMEOUT_MS` env override: HIGH — `readBatchConfig` source and test confirmed
- `withTimeout` throw message: HIGH — read from `batch.ts` line 107
- `deriveErrorType` substring rules: HIGH — read from `src/index.ts` lines 447-449
- `describe.skip` availability: HIGH — confirmed via `node -e` runtime check
- `transformCode` 8KB cap: HIGH — `TRANSFORM_CODE_MAX_BYTES = 8_000` in source, `ValidationError("INPUT_TOO_LARGE")` confirmed
- 45s race in opt-in test: HIGH — both deadlines confirmed at 45_000ms in source; D-04b reasoning is mechanically sound

**Research date:** 2026-06-26
**Valid until:** Stable until `@modelcontextprotocol/sdk` is updated (would affect `_registeredTools` accessor) or vitest is updated (would affect `describe.skip` API). Both are stable APIs at current pinned versions.
