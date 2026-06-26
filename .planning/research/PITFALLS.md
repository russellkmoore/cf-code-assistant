# Pitfalls Research

**Domain:** Adding bounded-concurrency batch fan-out + a shared `runTask` executor to a stateless Cloudflare Workers MCP server (v2.0 `code_assist_batch`)
**Researched:** 2026-06-25
**Confidence:** HIGH — grounded in the actual `src/index.ts`, the existing 108-test suite (`src/__tests__/*.test.ts`), the `batch.ts` reference, and the milestone brief. Workers subrequest/CPU limits and MCP `structuredContent` semantics verified against the milestone constraints and SDK version (`@modelcontextprotocol/sdk ^1.26.0`).

This milestone adds fan-out to an existing, hardened system. Every pitfall below is specific to THIS codebase: `callModel()` owns its own 45s timeout and accepts **no external signal**; the 11 AI-backed tools inline their prompt+tier+maxTokens and call `runAIWithMetrics`; the tests reach into `_registeredTools[name].handler` and assert exact text/error/log behavior. Generic "use a pool" advice is not the risk here — the risk is the seams where new fan-out code meets frozen v1.0 behavior.

---

## Critical Pitfalls

### Pitfall 1: Subrequest exhaustion from fan-out (50/request free, 1000 paid)

**What goes wrong:**
Each `env.AI.run()` is exactly one subrequest. A single `code_assist_batch` invocation runs N tasks inside **one** Worker request, so all N AI calls count against the same per-request subrequest budget. On the free plan that ceiling is 50; a batch of 50 leaves zero headroom for any other subrequest in the same invocation, and 51+ throws `Too many subrequests` mid-batch — turning a "partial results" contract into a hard crash that loses every result.

**Why it happens:**
Developers think of concurrency limit (6) as the safety bound and forget the *total* count is what the platform caps. Pool concurrency bounds how many run *simultaneously*; it does nothing about the *cumulative* subrequest count. The `BATCH_MAX_TASKS=50` default is the real guardrail, and it must be enforced *before* any task dispatches.

**How to avoid:**
- Enforce the cap as a fail-fast precondition at the top of `executeBatch()` (the `batch.ts` reference already does this at line 137) — reject `tasks.length > cfg.maxTasks` with the actionable message *before* spawning workers. Do not let an over-cap batch start and discover the limit at subrequest 51.
- Keep the default at 50, not 50-plus-slack. The cap must account for the fact that the batch tool's own bookkeeping (KV `resolveModel` reads) may *also* be subrequests. Note: `resolveModel` calls `env.OAUTH_KV.get()` once per task via `runAIWithMetrics` → that is a KV read, which on Workers is **not** counted as a subrequest, but verify this assumption holds if `runTask` ever adds an outbound `fetch`.
- Document in the cap error message that raising `BATCH_MAX_TASKS` requires a paid plan (the reference message already says this).

**Warning signs:**
- `Too many subrequests` in tail logs during a large batch.
- Batches near the cap intermittently fail while small batches always succeed.
- Cap enforced *inside* the worker loop instead of before dispatch.

**Phase to address:** Phase 2 (Batch core + pool). Verification: unit test asserting `tasks.length > maxTasks` rejects with the actionable message and **never calls `runTask`**.

---

### Pitfall 2: CPU-time and wall-time limits under fan-out

**What goes wrong:**
Workers cap CPU time per request (default 30s CPU, separate from wall-clock; can be raised on paid). Fan-out concentrates many model round-trips into one request. The AI round-trips are I/O-bound (wall-clock, not CPU), so they generally don't blow the CPU budget — but the *response assembly* can. If the batch collects 50 large code generations (each up to 8192 tokens) into one `structuredContent` object, JSON serialization, Zod output-schema validation of a 50-element discriminated union, and the MCP envelope encoding all run as CPU work at the end, in one burst. A batch that individually succeeds on every task can still die at the finish line with `Exceeded CPU limit`.

**Why it happens:**
Per-task work feels cheap, so nobody budgets the aggregate post-processing. The CPU cost is invisible until it's the sum of 50 tasks' worth of output validation + serialization in a single synchronous tail.

**How to avoid:**
- Keep per-task `result` payloads as opaque strings (the executor already returns trimmed text), not re-parsed/re-validated structures. Avoid running heavy Zod transforms over every result.
- The output schema (`BatchOutputShape`) should validate *shape*, not deeply re-parse each `result` — keep `result: z.unknown()` as the reference does (line 68), so output validation stays O(N) shallow, not O(N × payload).
- Consider that wall-clock for a 50-task batch at 6-wide concurrency is ~9 sequential "waves." At ~45s worst-case per task (the `AI_TIMEOUT_MS` ceiling) that is theoretically minutes of wall-clock. The per-task timeout (60s default) plus pool depth means a pathological batch can run very long — ensure the Worker's overall request timeout tolerates it, or lower `BATCH_MAX_TASKS`/`BATCH_TASK_TIMEOUT_MS` together.

**Warning signs:**
- `Exceeded CPU limit` only on large/full batches, never small ones.
- Latency that scales super-linearly with task count (serialization tail).
- The batch handler does any per-result re-parsing or string manipulation beyond concatenating the summary.

**Phase to address:** Phase 2 (core) for keeping `result` opaque + shallow output validation; Phase 4 (verify) for an Inspector run with a near-full batch of large outputs to confirm CPU headroom.

---

### Pitfall 3: Unbounded concurrency / naive `Promise.all`

**What goes wrong:**
The "obvious" implementation — `Promise.all(tasks.map(runTask))` — fires all N AI calls at once. With N=50 that's 50 simultaneous subrequests against Workers AI, which triggers `429` rate limits from the model endpoint, spikes CPU on the burst of promise scheduling, and risks the per-request in-flight subrequest concurrency ceiling. Worse, a single rejection in `Promise.all` rejects the whole aggregate (see Pitfall 5), so naive `Promise.all` breaks two contracts at once: bounded concurrency AND partial results.

**Why it happens:**
`Promise.all` is the reflexive way to "do these in parallel." It's correct for a handful of independent promises and catastrophic for 50 rate-limited subrequests.

**How to avoid:**
- Use the fixed-size worker pool from `batch.ts` (`mapWithConcurrency`, lines 98–115): a shared cursor, `workerCount = min(limit, items.length)` workers, each pulling the next index. Default `BATCH_CONCURRENCY=6`.
- Never introduce a `Promise.all(tasks.map(...))` anywhere over the *task* array. (`Promise.all` over the *fixed worker array* — line 113 — is correct and bounded; the distinction matters.)
- Make concurrency env-configurable but floor it at 1 and never let it default unbounded.

**Warning signs:**
- `429` / "capacity" / "rate limit" errors from Workers AI clustering at batch start.
- Concurrency observed > `BATCH_CONCURRENCY` in a test that counts simultaneous `runTask` entries.
- Any `.map()` over `tasks` feeding directly into `Promise.all`.

**Phase to address:** Phase 2 (core + pool). Verification: a unit test that wraps `runTask` with an in-flight counter and asserts the peak never exceeds `cfg.concurrency` (use a deferred/never-resolving mock to hold tasks in flight).

---

### Pitfall 4: Order-preservation bug (completion order vs. index order)

**What goes wrong:**
With a pool, tasks finish in *completion* order, not *submission* order. If results are `push()`ed as they complete, `results[0]` is whichever task finished first — not task 0. The caller correlates by array position, so a fast task 7 landing in slot 0 silently mis-attributes every result. This is the nastiest class of bug because it produces *plausible* output (right count, right shape) that is *wrong* — no error, no crash, just scrambled correlation.

**Why it happens:**
Append-on-completion (`results.push(...)`) feels natural in an async loop. The ordering corruption only manifests when task durations differ — which is exactly the heterogeneous-batch case the tool exists for.

**How to avoid:**
- Write into a pre-sized array by index, never push: `results[i] = await fn(items[i], i)` (the reference does this at line 110 with `const results = new Array(items.length)`). The worker captures its index `i = cursor++` before awaiting.
- Stamp `index` (and the resolved `id`) into every result object so correlation survives even if a consumer re-sorts (reference lines 149–157).
- The `id` default must be `String(index)` (reference line 146), so an omitted-id task still correlates.

**Warning signs:**
- `results.push(` anywhere in the pool.
- A test with mixed-duration tasks where `results[i].index !== i`.
- Results array length correct but values shuffled when some tasks are slow.

**Phase to address:** Phase 2 (core + pool). Verification: a unit test with deliberately inverted durations (task 0 slow, task N fast) asserting `results[i].index === i` and `results[i].id` matches the input task's id for every i.

---

### Pitfall 5: Error isolation — one task rejecting aborts the whole batch

**What goes wrong:**
If the per-task body lets a rejection propagate to the pool's `Promise.all(workers)`, the first failing task rejects the aggregate and the entire batch throws — destroying every sibling's completed result and violating the partial-results contract. The whole point of the tool (one bad task ≠ dead batch) is lost.

**Why it happens:**
The executor (`runTask` → `runAIWithMetrics` → `callModel`) *throws* on `AI_TIMEOUT` and AI errors (that's how the existing single-task handlers' try/catch works). If the pool doesn't catch per task, those throws bubble up.

**How to avoid:**
- Wrap each task body in try/catch *inside* the mapped function so it always *resolves* to a result object — `{status:'ok', result}` or `{status:'error', error}` — and never rejects (reference lines 147–158). The worker pool then only ever sees resolved values; `Promise.all(workers)` can't reject from a task failure.
- Convert the thrown error to a string at the boundary (`err instanceof Error ? err.message : String(err)`), matching the reference — do not leak Error objects or stack traces into `structuredContent` (consistent with the v1.0 "never log stack traces / prompt content" discipline in `logger.ts`).
- The only thing allowed to reject the batch is the pre-dispatch cap check (Pitfall 1) — a *caller* error, not a *task* error.

**Warning signs:**
- A mixed batch (one bad task) returns an MCP `isError` envelope instead of a results array with one `status:'error'` entry.
- `try/catch` placed around the pool instead of around each task.
- Test "one task throws → siblings still `ok`" not present.

**Phase to address:** Phase 2 (core). Verification: the brief's explicit target — "one task throwing yields a single `status:'error'` entry while siblings still return `ok`."

---

### Pitfall 6: Timeout semantics when the executor ignores the AbortSignal — leaked work, double-settle, unhandled rejections

**What goes wrong:**
This is the sharpest THIS-codebase pitfall. `callModel()` (src/index.ts:130) creates its **own** `AbortController` for `AI_TIMEOUT_MS` (45s) and **does not accept an external signal**. The batch per-task timeout (`withTimeout`, reference lines 119–131) races the task against a 60s timer and `abort()`s its own controller — but that controller is *not wired into* `env.AI.run()`. So when the race timer fires:
1. The `withTimeout` promise **rejects** with "Task exceeded Nms timeout" and the task is recorded as `status:'error'`.
2. The underlying `env.AI.run()` **keeps running in the background** (best-effort abort only — the signal is ignored). It still consumes its subrequest and may still resolve or reject *after* the batch has returned.
3. When that orphaned promise later settles, its `.then`/`.catch` in `withTimeout` runs against an already-settled outer promise. The reference guards this: `clearTimeout` + the outer Promise's resolve/reject are no-ops after first settle, so there's **no double-settle crash** — but the late rejection branch (`(e) => { clearTimeout(timer); reject(e); }`) calls `reject` on an already-rejected promise. That's a silent no-op in JS *only because* the executor body already settled it; if anyone refactors `withTimeout` to attach a bare `.catch`-less handler, the orphaned rejection becomes an **unhandled promise rejection** that Workers logs as an error and may surface as a tail-log noise storm or, in strict modes, a crash.

**Why it happens:**
The mental model "I aborted it, so it stopped" is false here. The signal is decorative because `callModel` never reads an injected one. Timeout becomes a *return-time guarantee* (the batch won't hang) but **not** a *cancellation* guarantee (the work and its subrequest cost continue).

**How to avoid:**
- Treat the timeout as **best-effort abort + guaranteed rejection**, exactly as the reference frames it (comment lines 117–118). Document this explicitly so no one assumes cancellation.
- Keep `withTimeout`'s settle-once structure: the native Promise resolve/reject are idempotent, so the late settle of the orphaned `runTask` is harmless. **Do not** "improve" it by adding a separate `.catch` on the inner promise that re-throws — that creates the unhandled rejection.
- Make the orphaned background promise's eventual rejection a *no-op*, not an *unhandled* one. The current `run(...).then(onResolve, onReject)` form (reference line 126) attaches both handlers, so the orphan's late rejection is always *handled* (it hits `onReject`, which calls a now-inert `reject`). Preserve this shape. A bare `run().then(onResolve)` with no second arg would leak.
- Per-task timeout (60s) is **longer** than `callModel`'s internal timeout (45s) by design: the inner 45s timeout normally fires first and converts to a clean `AI_TIMEOUT` throw → `status:'error'`. The 60s race is the *backstop* for the pathological case where the inner timeout itself is bypassed. Keep `BATCH_TASK_TIMEOUT_MS > AI_TIMEOUT_MS` or the backstop fires first and you lose the structured `AI_TIMEOUT` classification.
- **Subrequest accounting under leak:** a timed-out-but-still-running AI call *still counts as a subrequest* until it settles. Under a near-cap batch with several timeouts, leaked in-flight calls can push you toward the in-flight subrequest concurrency ceiling. This is another reason the pool concurrency (6) and the task cap (50) both matter — and a reason not to raise concurrency aggressively.

**Warning signs:**
- Tail logs showing AI calls completing *after* a batch already returned.
- Unhandled-rejection warnings in `wrangler tail` after a batch with timeouts.
- A refactor that changes `withTimeout`'s `.then(onResolve, onReject)` into anything with only one handler.
- `BATCH_TASK_TIMEOUT_MS` set ≤ 45000, masking `AI_TIMEOUT` as a generic timeout.

**Phase to address:** Phase 2 (core — `withTimeout` and its settle-once guarantee). Verification: the brief's target — "a task exceeding the timeout returns `status:'error'` without hanging the batch"; plus a test where the mocked `runTask` resolves *after* the timeout and asserts no second settle / no unhandled rejection (spy on `process`/`globalThis` unhandledrejection, or assert the result object is the timeout error and the late resolve is ignored).

---

### Pitfall 7: Refactor regression extracting `runTask` from the 11 inline handlers

**What goes wrong:**
Phase 1 extracts one reusable `runTask(kind, input, signal)` from 11 handlers that currently inline (a) prompt assembly, (b) tier selection, (c) `maxTokens`, (d) input guards, and (e) logging. Any drift in *any* of these silently changes output or breaks the 108 tests. Concrete drift vectors found in `src/index.ts`:
- **Prompt drift:** each tool builds a bespoke prompt string (e.g. `generateCode` prepends `Language:`/`Style:`/`Context:`; `reviewCode` lists exact categories "Bugs, Style, Performance, Security, Suggestions"; `generateCommitMessage` specifies "under 72 characters"). Centralizing these risks changing whitespace, ordering, or wording. Tests don't assert prompt text directly (they mock `env.AI.run` and check the *response*), so prompt drift is **invisible to the test suite** but degrades real output quality.
- **Tier mismatch:** `explainCode` is tier-conditional — `detailed` → `standard`, `brief`/`eli5` → `fast` (src/index.ts:393). `quickTask`/`generateCommitMessage` are `fast`; the rest are `standard`. A `runTask` switch that hardcodes one tier per kind breaks `explainCode`'s depth-conditional routing. `observability.test.ts` asserts the logged `tier` and `model`, so this *will* turn red.
- **maxTokens mismatch:** values vary per tool (8192 for generateCode/transformCode/scaffoldTests/docs/types/fixBug/boilerplate; 4096 for reviewCode and detailed-explain; 2048 for brief/eli5-explain; 1024 for commitMessage). A uniform `maxTokens` silently truncates or over-allocates.
- **Logging change:** every handler calls `logToolInvocation({tool, tier, model, latency_ms})` on success and `logToolError({tool, error_type, input_size_bytes})` on failure. `observability.test.ts` parses these exact structured logs. If `runTask` moves logging to a different layer or changes the `tool` name, `input_size_bytes` computation, or `error_type` mapping (`AI_TIMEOUT` vs `AI_ERROR`, decided by `msg === "AI_TIMEOUT"`), observability tests fail.
- **Input-guard drift:** `transformCode` has a pre-AI 8KB byte cap that returns a *non-isError-path-but-isError-envelope* `INPUT_TOO_LARGE` message (src/index.ts:288). If that guard moves into `runTask` or is dropped, `input-validation.test.ts` breaks and oversized transforms hit the 45s timeout.
- **Test seam fragility:** the suite reaches `(server as any)._registeredTools[name].handler` and calls it directly with `(args, undefined)`. The extraction must keep each single-task tool's registered handler returning the *identical* `{content:[{type:'text',text}]}` (success) and `makeToolError(...)` (failure) shapes. If `runTask` returns a result object instead of the MCP envelope, the single-task handlers must still wrap it back into the exact v1.0 envelope.

**Why it happens:**
"Extract a function" feels mechanical, but here the 11 handlers are *not* uniform — they differ in prompt, tier, tokens, guards, and logging. A naive extraction collapses real per-kind variation. And because the tests mock the AI and assert the *envelope/logs*, prompt-text regressions pass CI while silently degrading output.

**How to avoid:**
- Make Phase 1 **strictly behavior-preserving**: extract `runTask` such that each existing single-task handler still produces byte-identical prompts, the same tier, the same `maxTokens`, the same guards, and the same `logToolInvocation`/`logToolError` calls. The existing 108 tests are the *guard* — run `npm test` after extraction and require green before Phase 2.
- Encode per-kind config (tier, maxTokens, prompt builder) in a single table/registry keyed by `kind`, so the single-task tools and the batch tool both read the *same* source of truth. `explainCode`'s depth-conditional tier/tokens means the registry value may itself be a function of `input`, not a constant — model it that way.
- Keep logging at the call boundary that the tests observe. Decide deliberately: does a *batch* task also emit `logToolInvocation`? If yes, 50-task batches produce 50 log lines (acceptable, but confirm `observability.test.ts` isn't asserting *exactly one* invocation log per request). If batch tasks log under a different `tool` name, document it.
- Add a **prompt-snapshot guard** for the highest-value tools (a test that asserts the assembled prompt string matches a frozen snapshot) before refactoring — this is the only way to catch prompt drift, which the current suite cannot. This is new test surface justified specifically by the refactor risk.

**Warning signs:**
- `observability.test.ts` failing on `tier`/`model`/`tool` after extraction.
- `input-validation.test.ts` failing (transformCode cap moved/dropped).
- `tool-handlers.test.ts` failing on `content[0].text !== "mock AI output"` (envelope shape changed) or on the `AI_TIMEOUT`/`AI_ERROR` text (error mapping changed).
- Real (non-mocked) output quality dropping while CI stays green — the signature of prompt drift.

**Phase to address:** Phase 1 (Extract/confirm `runTask`). Verification: full `npm test` green (108 tests) after extraction; add prompt snapshots for `generateCode`, `reviewCode`, `transformCode`, `explainCode` as a regression guard.

---

### Pitfall 8: MCP output-schema / `structuredContent` validation mismatch

**What goes wrong:**
The batch tool is the first tool in this server to declare an **output schema** and return `structuredContent` (all v1.0 tools return only `content:[{type:'text'}]`). MCP/SDK 1.x validates `structuredContent` against the declared `outputSchema` *and* requires that a `content` text block also be present (clients that don't understand structured output fall back to text). Mismatches cause the SDK to reject the tool's *own* response — the call fails not because a task failed, but because the envelope is malformed. Specific traps here:
- **Shape drift between `BatchOutputShape` and the runtime object:** `executeBatch` returns `{total, succeeded, failed, results}` (reference line 162) and `BatchOutputShape` (lines 87–92) must match exactly. If a field is added to the runtime object but not the schema (or vice versa), SDK output validation throws.
- **Discriminated-union result mismatch:** `TaskResultSchema` is a `z.discriminatedUnion("status", [...])` (reference lines 62–77). Every result object must have `status` as a literal `"ok"`/`"error"` and the *exact* fields for that branch (`ok` → `result`; `error` → `error`). A result missing `index` or carrying both `result` and `error` fails union validation. The `as const` on `status: "ok" as const` / `"error" as const` (reference lines 149, 154) is load-bearing — drop it and TS widens to `string`, breaking the discriminator.
- **Missing text summary:** returning `structuredContent` *without* a `content` text block (reference lines 200–211 provide it) breaks clients that only read text and may fail SDK validation that expects at least one content block.
- **`result: z.unknown()` is intentional:** the per-task `result` is opaque model text. Tightening it to `z.string()` would reject any task whose executor returns a non-string (and couples the batch schema to every kind's return type). Keep it `unknown`.
- **Annotations:** the tool must set `readOnlyHint:false, destructiveHint:false, idempotentHint:false, openWorldHint:true` (reference lines 189–194). Wrong annotations don't fail validation but mislead clients about safety/idempotency (a batch is *not* idempotent — re-running re-spends tokens).

**Why it happens:**
It's the first structured-output tool in the repo, so there's no existing pattern to copy and no test precedent. Zod v4 (`^4.0.0`) discriminated-union and the SDK's output-validation interaction is easy to get subtly wrong, and the failure mode (SDK rejects a *successful* batch) is confusing.

**How to avoid:**
- Keep `executeBatch`'s return object and `BatchOutputShape` defined adjacently and assert their equivalence in a unit test (parse a real `executeBatch` output through `z.object(BatchOutputShape)` and expect success).
- Test both branches of the discriminated union: an all-`ok` batch and a mixed batch must both pass `z.object(BatchOutputShape).parse(...)`.
- Always return `structuredContent` **and** a `content` text summary together.
- Pin Zod (the `^4.0.0` caret is flagged in CONCERNS.md) — a Zod minor bump that changes discriminated-union behavior could break output validation silently. Lock it for this milestone.

**Warning signs:**
- MCP Inspector showing a tool-response validation error on a batch that "should" have succeeded.
- A successful `executeBatch` whose object fails `z.object(BatchOutputShape).parse`.
- TS inferring `status: string` instead of the literal (missing `as const`).
- Clients showing no batch output (structured present, text absent).

**Phase to address:** Phase 3 (Register the tool) for schema/annotations/envelope; Phase 4 (verify) for the Inspector mixed-result run. Verification: parse real `executeBatch` outputs (all-ok and mixed) through the output schema in a unit test; Inspector confirms structured + text render.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Inline `runTask` switch duplicating each tool's prompt instead of a shared per-kind registry | Faster Phase 1 | Prompt logic now lives in 2 places; future tool edits drift between single-task and batch | Never — violates "one source of truth" hard decision; the whole point is reuse |
| Skip prompt-snapshot tests, rely on existing 108 | No new test surface | Prompt drift in `runTask` extraction passes CI but degrades real output | Only if Phase 1 keeps prompt builders byte-identical AND that's manually diffed |
| Raise `BATCH_MAX_TASKS` above 50 without paid plan | Bigger batches | `Too many subrequests` crash loses all partial results | Only on a verified paid plan (1000 subrequest budget) |
| Set `BATCH_TASK_TIMEOUT_MS` ≤ 45000 | "Tighter" timeout | Masks the inner `AI_TIMEOUT` classification; backstop fires before clean timeout | Never — keep batch timeout > `AI_TIMEOUT_MS` |
| Tighten `result: z.unknown()` to `z.string()` | "Stronger" schema | Couples batch schema to every kind's return; rejects valid non-string results | Never |
| Wire timeout as if it cancels the AI call | Cleaner mental model | False — work leaks; assuming cancellation hides leaked subrequest cost | Never — document best-effort |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Workers AI (`env.AI.run`) | Assuming `AbortSignal` cancels the call | `callModel` ignores external signals; timeout is best-effort abort + guaranteed rejection; work + subrequest cost continue |
| Workers subrequests | Counting only concurrent (6), not cumulative (N) | Cap total tasks (50) before dispatch; 1 subrequest per task; pool bounds simultaneity not total |
| MCP SDK 1.26 output schema | Returning `structuredContent` only | Return `structuredContent` + a `content` text summary; validate object against `outputSchema` |
| Zod v4 discriminated union | Dropping `as const` on `status` | TS widens to `string`, breaks discriminator; keep literals |
| `_registeredTools` test seam | Refactor changes registered handler's return shape | Single-task handlers must still return the identical v1.0 `{content:[{type:'text',text}]}` / `makeToolError` envelope |
| Structured logging (`logger.ts`) | Moving/renaming `logToolInvocation` in extraction | `observability.test.ts` parses exact `tool`/`tier`/`model`/`error_type` fields — preserve them |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Naive `Promise.all(tasks.map(...))` | 429s from Workers AI at batch start | Bounded pool, concurrency 6 | Any batch > ~6 tasks |
| O(N×payload) output validation | CPU limit only on large batches | Keep `result: z.unknown()`, shallow output schema | Near-cap batches of large (8192-token) outputs |
| Leaked timed-out AI calls holding subrequests | In-flight subrequest pressure under timeouts | Keep concurrency modest; timeout > inner 45s | Many concurrent timeouts in a near-cap batch |
| Serial summary tail | Super-linear latency vs. task count | Avoid per-result re-parsing; concat summary only | 50-task batches |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| Leaking Error objects/stack traces into `structuredContent` | Exposes internals; breaks v1.0 "never log stack traces" discipline | Stringify to `err.message` at the task boundary (reference does this) |
| No per-task input size guard in batch | 50 oversized inputs bypass single-tool caps, blow tokens/timeouts | Apply the same input caps (e.g. transformCode 8KB) inside `runTask` so batch tasks inherit them |
| Batch tool not behind the same OAuth gate | Unauthed fan-out = token/cost abuse | Register inside the same `createMcpServer` so it inherits the OAuthProvider `/mcp` gate (no separate route) |
| Annotating batch as `idempotentHint:true` | Clients may auto-retry, double-spending tokens | Set `idempotentHint:false` — a batch re-run re-spends |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Over-cap batch returns a vague error | Agent can't self-correct | Actionable message: count, limit, "split into smaller batches," subrequest rationale (reference lines 138–142) |
| Failed tasks not identifiable in the summary | Agent can't re-issue just the failures | Text summary lists failed task ids (reference lines 206–209); each error entry keeps `id`/`index`/`kind` |
| Batch used for a single trivial task | Wasted round-trip | Description steers to single-task tools for one-offs (reference description) |

## "Looks Done But Isn't" Checklist

- [ ] **Bounded pool:** Verify peak concurrency never exceeds `BATCH_CONCURRENCY` with an in-flight counter test (not just "it ran").
- [ ] **Partial results:** Verify a mixed batch returns a results array with one `status:'error'` entry, NOT an `isError` envelope.
- [ ] **Order preservation:** Verify `results[i].index === i` with *inverted task durations*, not equal-duration tasks.
- [ ] **Timeout backstop:** Verify a task that resolves *after* the timeout produces the timeout error AND raises no unhandled rejection / no double-settle.
- [ ] **Cap fail-fast:** Verify `tasks.length > maxTasks` rejects *before* any `runTask` call (spy asserts zero calls).
- [ ] **Output schema:** Verify a real `executeBatch` object (all-ok AND mixed) passes `z.object(BatchOutputShape).parse`.
- [ ] **Envelope:** Verify the tool returns `structuredContent` AND a `content` text summary.
- [ ] **Refactor parity:** Verify all 108 existing tests green after `runTask` extraction; verify `explainCode` depth→tier routing and per-tool `maxTokens` preserved.
- [ ] **Prompt parity:** Verify (snapshot or manual diff) that extracted prompts are byte-identical for `generateCode`/`reviewCode`/`transformCode`/`explainCode`.
- [ ] **Input guards inherited:** Verify the transformCode 8KB cap (and any other guard) still fires for the equivalent batch `kind`.

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Subrequest exhaustion (no fail-fast cap) | LOW | Add pre-dispatch cap check; lower `BATCH_MAX_TASKS` |
| Naive `Promise.all` shipped | MEDIUM | Replace with `mapWithConcurrency`; add in-flight-cap test |
| Order scramble (push-on-complete) | MEDIUM | Switch to index-write into pre-sized array; add inverted-duration test |
| Batch aborts on one failure | LOW | Move try/catch inside the mapped task body |
| Unhandled rejection from leaked timeout | MEDIUM | Restore `.then(onResolve, onReject)` two-handler form in `withTimeout` |
| Refactor broke the 108 tests | MEDIUM | Diff prompt/tier/tokens/logging per kind against pre-refactor `src/index.ts`; restore per-kind config table |
| Output-schema mismatch rejects valid batch | LOW | Align `BatchOutputShape` with `executeBatch` return; restore `as const`; keep `result: z.unknown()` |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| 1. Subrequest exhaustion | Phase 2 | Unit: over-cap rejects before any `runTask` call |
| 2. CPU/wall-time under fan-out | Phase 2 + Phase 4 | Shallow output validation in core; Inspector near-full large-output batch |
| 3. Unbounded concurrency | Phase 2 | Unit: peak in-flight ≤ `concurrency` (deferred-mock counter) |
| 4. Order preservation | Phase 2 | Unit: inverted-duration batch → `results[i].index === i` |
| 5. Error isolation | Phase 2 | Unit: one task throws → one `error` entry, siblings `ok` |
| 6. Timeout / leaked work / unhandled rejection | Phase 2 | Unit: timeout returns `status:'error'`, no hang; late resolve raises no unhandled rejection |
| 7. Refactor regression (`runTask` extraction) | Phase 1 | Full 108-test suite green + prompt snapshots; `explainCode` tier/tokens preserved |
| 8. Output-schema / structuredContent | Phase 3 + Phase 4 | Unit: real `executeBatch` (all-ok + mixed) parses against `BatchOutputShape`; Inspector renders structured + text |

## Sources

- `src/index.ts` — `callModel` (own 45s timeout, no external signal, lines 130–166), `runAIWithMetrics`, the 11 inline tool handlers (per-kind prompt/tier/maxTokens/guards/logging), `transformCode` 8KB cap (line 288) — HIGH
- `src/__tests__/tool-handlers.test.ts`, `observability.test.ts` — `_registeredTools[name].handler` test seam; exact `text`/`AI_TIMEOUT`/`AI_ERROR`/`tier`/`model` assertions that constrain the refactor — HIGH
- `src/logger.ts` — `logToolInvocation`/`logToolError` structured fields the refactor must preserve — HIGH
- `.planning/batch.ts` — reference pool (`mapWithConcurrency`), `withTimeout` settle-once, `executeBatch` cap check, discriminated-union output schema, annotations — HIGH
- `.planning/code-assist-batch-milestone.md` + `.planning/PROJECT.md` — subrequest cap rationale (50 free / 1000 paid), bounded-pool decision, partial-results contract, behavior-preserving constraint — HIGH
- `.planning/codebase/CONCERNS.md` — Zod `^4.0.0` caret pin risk, "schema vs implementation" drift, per-tool maxTokens fragility, no load tests — MEDIUM
- `package.json` — `@modelcontextprotocol/sdk ^1.26.0`, `zod ^4.0.0`, vitest + `@cloudflare/vitest-pool-workers` (test runner for verification probes) — HIGH

---
*Pitfalls research for: bounded-concurrency batch fan-out on a Cloudflare Workers MCP server*
*Researched: 2026-06-25*
