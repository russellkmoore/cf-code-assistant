# Phase 5: Extract Shared `runTask` Executor - Research

**Researched:** 2026-06-26
**Domain:** Behavior-preserving refactor of a single-file Cloudflare Workers MCP server — extract the prompt-build + AI-invocation head of 11 tool handlers into one `runTask(env, kind, input)` executor backed by a `TASK_SPECS` dispatch map
**Confidence:** HIGH (every claim below is grounded in a direct read of `src/index.ts`, the 8 test files, `vitest.config.mts`, and a confirmed-green 108-test run; no external/training claims load-bearing)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** `runTask` is a **full executor**, not just a prompt-builder. Signature `runTask(env, kind, input)` looks up `TASK_SPECS[kind]`, builds the prompt, calls `runAIWithMetrics(env, tier, prompt, maxTokens)`, and returns the `AIResult` `{text, model, latency_ms}`. Single source of truth for prompt + tier + maxTokens **and** the AI call, so the batch tool (Phase 7) reuses it without re-wrapping the model call.
- **D-02:** Each single-task handler **delegates** to `runTask` for the work; the handler's per-tool `logToolInvocation` / `logToolError` calls and its `makeToolError` mapping stay in the handler tail (logging keeps the correct per-tool name tag). Handlers shrink to: validate (Zod boundary) → `runTask` → log + return `{content:[{type:'text', text}]}` / catch → log + `makeToolError`.
- **D-03:** Per-kind input validation is **built into `runTask` now in Phase 5** (not deferred). Each `TASK_SPECS` entry reuses the **exact** Zod caps/shape already on that tool's `inputSchema` in `src/index.ts` (e.g. `generateCode` prompt `.max(20_000)`, context `.max(50_000)`; do not weaken or duplicate-with-drift). For the single-task path this inner validation is redundant with the MCP boundary Zod (boundary catches first → inner validation always passes → no behavior change). It exists so the batch path (Phase 7) can downgrade a bad task to a `status:'error'` entry instead of rejecting the whole batch.
- **D-04:** Kind-specific logic travels **with the kind in `TASK_SPECS`**:
  - `explainCode` — its spec resolves tier + maxTokens as a **function of input** (`depth`): `detailed → standard/4096`, `brief|eli5 → fast/2048` (preserve the current mapping exactly).
  - `transformCode` — its **8KB pre-AI byte cap** is enforced inside `runTask` before the model call.
- **D-05:** `runTask` throws **distinguishable typed errors** (at minimum: validation failure vs AI timeout vs AI error). In Phase 5 each single-task handler tail maps these to the **exact same** response it returns today — `transformCode`'s over-8KB path must return its current error response byte-for-byte, and AI failures must still map to `makeToolError('AI_TIMEOUT' | 'AI_ERROR', toolName)`. The typed-error taxonomy is what Phase 7 later surfaces as `error_type` (`timeout | validation | ai_error`), but Phase 5 only needs the single-task responses unchanged. **This is the highest-risk seam** — the regression guard is the full 108-test suite plus the new snapshot test.
- **D-06:** The new `runtask.test.ts` asserts **byte-identical `buildPrompt` output for all 11 AI-backed kinds** (not just the 4 with special logic), plus asserts the resolved tier/maxTokens per kind — including `explainCode` across all three depths and `transformCode` at/over the 8KB boundary.

### Claude's Discretion

- The concrete shape of `TASK_SPECS` entries (static `{tier, maxTokens, buildPrompt}` vs a `resolve(input) → {tier, maxTokens}` field for `explainCode`) — planner/executor choice, as long as D-01..D-06 hold.
- Internal naming (`TaskKind` type, error classes/sentinels) and file organization (keep in `src/index.ts` vs a new module) — provided no new runtime dependency is added.
- How typed errors are represented (custom Error subclasses vs a tagged result) — any form the handler tails can map to today's exact responses.

### Deferred Ideas (OUT OF SCOPE)

- Concurrency pool, per-task timeout (default 45000ms), per-call cap (default 50) — Phase 6.
- `code_assist_batch` registration, output schema, `structuredContent`, annotations, `error_type` surfacing, batch summary — Phase 7.
- True per-task cancellation (thread an AbortSignal into `env.AI.run`) — BATCH-F01, future milestone.
- The static `routingInfo` tool is **excluded** (no AI call, no input).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| BATCH-01 | A single reusable `runTask(kind, input)` dispatch (kind → tier, maxTokens, buildPrompt) is extracted from the 11 AI-backed handlers and used by both the single-task tools and the batch tool — observable behavior unchanged, all 108 existing tests stay green | The **Per-Kind Extraction Table** below documents the exact prompt-build, tier, and maxTokens for all 11 kinds verbatim from `src/index.ts`, so the extraction is byte-identical. The **`TASK_SPECS` Type Proposal** gives a single uniform dispatch shape supporting both the `explainCode` per-input resolver and the `transformCode` pre-AI guard. Phase 5 wires only the single-task tools; the batch tool consumes `runTask` in Phase 7. |
| BATCH-02 | A prompt-snapshot test asserts byte-identical `buildPrompt` output per kind (including `explainCode`'s depth-driven tier/maxTokens and `transformCode`'s 8KB cap), guarding the refactor against prompt drift the existing AI-mocked tests cannot detect | The **Validation Architecture** section specifies `runtask.test.ts`: it imports `TASK_SPECS`/`runTask` and asserts the joined prompt string per kind + resolved tier/maxTokens, including all 3 `explainCode` depths and `transformCode` at 8000 / 8001 bytes. The **"Why the existing suite can't see prompt drift"** finding (createMockAI ignores prompt content) proves why this new surface is load-bearing. |
</phase_requirements>

## Summary

This is a pure, behavior-preserving refactor of one file. Today, 11 tool handlers in `src/index.ts` (lines 211–560) each inline the same shape: a **head** that builds a bespoke prompt string from validated inputs and selects a `tier` + `maxTokens`, followed by a **tail** that wraps `runAIWithMetrics` in `try { … logToolInvocation; return {content} } catch { classify AI_TIMEOUT vs AI_ERROR; logToolError; makeToolError }`. The locked plan (D-01..D-06) lifts only the head into a `TASK_SPECS[kind]` dispatch map, wraps it plus the AI call in `runTask(env, kind, input)`, and leaves each handler's tail in place so observable behavior — and therefore the existing 108 tests — is unchanged.

The single load-bearing risk is **prompt drift**: the AI mock (`createMockAI`, `helpers.ts:23`) returns `{ response: "mock-response" }` regardless of prompt content, so the existing suite asserts only on the response envelope and structured logs — it is **structurally blind** to whitespace/ordering/wording changes in the prompt the model actually receives. The new `runtask.test.ts` (D-06) is the only guard against this; it must assert byte-identical `buildPrompt` output for all 11 kinds plus the resolved tier/maxTokens per kind. I verified the 108-test baseline is green before any change (`Tests 108 passed (108)`, 2.17s, 8 files).

Two kinds carry special logic that must travel into `TASK_SPECS` exactly: **`explainCode`** resolves tier + maxTokens from `depth` (`detailed → standard/4096`, `brief|eli5 → fast/2048` — verified at index.ts:393–394), and **`transformCode`** enforces an 8000-byte (`TextEncoder`) pre-AI cap returning a specific `INPUT_TOO_LARGE` envelope (index.ts:287–297). `observability.test.ts` asserts the logged `tier`/`model`, and `input-validation.test.ts` / `tool-handlers.test.ts` exercise the transform path — so any drift in these two turns the suite red, which is the desired safety net.

**Primary recommendation:** Model `TASK_SPECS[kind]` as `{ resolve(input) → {tier, maxTokens}, buildPrompt(input) → string, validate?(input) }` — a single uniform entry shape where the constant-tier kinds return a fixed `{tier, maxTokens}` from `resolve` and `explainCode` branches on `depth`. Enforce `transformCode`'s 8KB cap as a typed `ValidationError` thrown by `runTask` *before* the AI call; the handler tail catches it and returns today's exact `INPUT_TOO_LARGE` envelope byte-for-byte. Keep everything in `src/index.ts` (the repo is intentionally near-monolithic; only `logger.ts` is split out) unless a circular-import problem forces a split — none is expected since `runTask` and `TASK_SPECS` sit above `runAIWithMetrics` in the same module.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Prompt assembly per kind | MCP Tool Layer (`TASK_SPECS.buildPrompt`) | — | Pure string transform of validated input; no I/O, no env. Belongs in the dispatch map so both single-task and batch callers share one source. |
| Tier + maxTokens selection | MCP Tool Layer (`TASK_SPECS.resolve`) | — | A pure policy decision keyed on kind (+`depth` for explainCode). Must live with the kind so batch inherits it. |
| Per-kind input validation | MCP Tool Layer (`runTask` inner Zod) | MCP boundary Zod (`registerTool` inputSchema) | Boundary Zod catches first for single-task path; inner validation exists for the batch path (Phase 7) to isolate a bad task. |
| AI invocation + metrics | Executor (`runAIWithMetrics` → `callModel`) | — | **Unchanged.** `runTask` calls it; it owns model resolution, the 45s AbortController, and latency timing. |
| Error classification (AI_TIMEOUT/AI_ERROR) | MCP Tool Layer (handler tail) | `runTask` typed-error throw (D-05) | `runTask` throws distinguishable typed errors; the handler tail maps them to today's exact MCP envelope + logs. Tail stays per-tool so the `tool` log tag is correct. |
| Structured logging | MCP Tool Layer (handler tail) | — | `logToolInvocation`/`logToolError` stay in the tail (D-02) so `observability.test.ts` keeps seeing the same per-tool fields. |

## Standard Stack

### Core
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `@modelcontextprotocol/sdk` | `^1.26.0` (1.29.0 installed) `[VERIFIED: package.json + node_modules]` | `server.registerTool(name, {description, inputSchema}, handler)` — the existing tool registration surface; **unchanged** this phase | Already a dependency; the 12 existing tools use it. No new tool is registered in Phase 5. |
| `zod` | `^4.0.0` (4.3.6 installed) `[VERIFIED: package.json]` | Per-kind input caps reused inside `runTask` (D-03) and the existing `inputSchema` ZodRawShapes | Already a dependency; D-03 mandates reusing the *exact* existing caps, not new schemas. |
| Workers runtime globals | V8 isolate | `TextEncoder` (transformCode byte cap, input_size_bytes logging) | Already used throughout `src/index.ts`; no import needed. |

### Supporting
| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `vitest` + `@cloudflare/vitest-pool-workers` | `^4.1.4` / `^0.14.3` `[VERIFIED: package.json]` | Run `runtask.test.ts` in the Workers pool (same as existing 8 suites) | The new prompt-snapshot test; no new dev dep. |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Keep `runTask`/`TASK_SPECS` in `src/index.ts` | New `src/runTask.ts` module | A separate module is cleaner for isolated unit testing but the repo is intentionally near-monolithic (only `logger.ts` is split). Splitting risks a circular import with `runAIWithMetrics`. **Recommend in-file** unless a circular import forces a split; if it does, lift `runAIWithMetrics`/`callModel`/`resolveModel` into `src/exec.ts` and import from both. Discretion per CONTEXT.md. |
| Snapshot via inline string assertions in `runtask.test.ts` | Vitest `toMatchSnapshot()` (`.snap` files) | Inline `toBe(expected)` is more explicit and self-documenting for a byte-equality contract and avoids an out-of-band `.snap` file a reviewer might regenerate blindly. **Recommend inline `toBe`** with the expected prompt written literally in the test. |

**Installation:** None. Zero new dependencies (confirmed: `p-limit` absent; SDK/Zod already satisfy every requirement). This matches the STACK.md headline and the v2.0 "prefer zero new deps" decision.

## Package Legitimacy Audit

> Not applicable — Phase 5 installs **no** external packages. It is a pure in-repo refactor reusing `@modelcontextprotocol/sdk`, `zod`, `vitest`, and `@cloudflare/vitest-pool-workers`, all already present in `package.json` and verified installed. No registry lookup, no slopcheck run required.

## Architecture Patterns

### System Architecture Diagram

```
client → MCP request (e.g. generateCode({...}))
   │
   ▼
┌──────────────────────────────────────────────────────────────┐
│  MCP boundary Zod (registerTool inputSchema)  [UNCHANGED]    │
│  validates + .trim()s input → typed args                     │
└───────────────────────────────┬──────────────────────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────┐
│  handler head  [REPLACED → delegates]                        │
│    try {                                                     │
│      result = runTask(env, "generateCode", args)  ───────┐  │
│    } catch (err) { … }                                    │  │
└───────────────────────────────────────────────────────────┼──┘
                                                            ▼
                          ┌──────────────────────────────────────────────┐
                          │  runTask(env, kind, input)   [NEW]           │
                          │   spec = TASK_SPECS[kind]                    │
                          │   spec.validate?(input)  ── throws ────┐     │  (validation)
                          │   {tier,maxTokens} = spec.resolve(input)│     │
                          │   prompt = spec.buildPrompt(input)      │     │
                          │   runAIWithMetrics(env,tier,prompt,max) │     │  (ai_error/timeout)
                          └─────────────────┬───────────────────────┼────┘
                                            ▼                       │
              ┌──────────────────────────────────────────┐         │
              │ runAIWithMetrics → resolveModel →         │         │
              │ callModel → env.AI.run   [ALL UNCHANGED]  │  throws │
              │ returns {text, model, latency_ms}         │ ────────┘
              └─────────────────┬────────────────────────┘
                                ▼
┌──────────────────────────────────────────────────────────────┐
│  handler tail  [UNCHANGED behavior]                          │
│    success: logToolInvocation(...); return {content:[text]}  │
│    catch:   classify AI_TIMEOUT/AI_ERROR (+ INPUT_TOO_LARGE  │
│             for transformCode); logToolError; makeToolError  │
└──────────────────────────────────────────────────────────────┘
```

**Data flow to trace (generateCode happy path):** request → boundary Zod → handler `try` → `runTask("generateCode", args)` → `TASK_SPECS.generateCode.buildPrompt(args)` builds `parts.join("\n\n")` → `runAIWithMetrics(env, "standard", prompt, 8192)` → `callModel` → `env.AI.run` → `{text}` → handler logs `logToolInvocation` → returns `{content:[{type:'text', text}]}`. Every node except the `runTask`/`TASK_SPECS` box is byte-for-byte what runs today.

### Per-Kind Extraction Table (THE load-bearing spec)

> Every value below is copied verbatim from `src/index.ts`. The planner must specify byte-identical extraction; the executor must not "improve" any string. Line numbers are current `src/index.ts`.

| Kind | Tier | maxTokens | Prompt-build logic (verbatim) | Lines |
|------|------|-----------|-------------------------------|-------|
| **generateCode** | `standard` | `8192` | `parts: string[]=[]`; if `language` push `` `Language: ${language}` ``; if `style` push `` `Style: ${style}` ``; if `context` push `` `Context:\n${context}` ``; always push `` `Task:\n${prompt}` ``; → `parts.join("\n\n")` | 224–230 |
| **reviewCode** | `standard` | `4096` | array `["Review the following code and return structured findings as a markdown list.", "Categories: Bugs, Style, Performance, Security, Suggestions.", "Only include categories where you find issues.", criteria ? \`Focus on: ${criteria}\` : "", \`\`\`\\n${code}\\n\`\`\`]` → `.filter(Boolean).join("\n\n")` | 254–264 |
| **transformCode** | `standard` | `8192` | **PRE-AI CAP** (see below); then array `["Apply the following transformation to this code. Return only the transformed code.", \`Transformation: ${instruction}\`, \`\`\`\\n${code}\\n\`\`\`]` → `.join("\n\n")` | 287–305 |
| **scaffoldTests** | `standard` | `8192` | `fw = framework ?? "vitest"`; array `[\`Generate comprehensive test scaffolding using ${fw} for the following code.\`, "Include happy path, edge cases, and error cases. Return only test code.", \`\`\`\\n${code}\\n\`\`\`]` → `.join("\n\n")` | 328–333 |
| **quickTask** | `fast` | `4096` | prompt **is** `instruction` raw (no wrapping) — `runAIWithMetrics(env,"fast",instruction,4096)` | 358 |
| **explainCode** | **depth-driven** (see below) | **depth-driven** | `level = depth ?? "brief"`; `depthInstructions[level]` (3 fixed strings, 383–387); array `[depthInstructions[level], \`\`\`\\n${code}\\n\`\`\`]` → `.join("\n\n")` | 382–391 |
| **generateDocs** | `standard` | `8192` | `docStyle = style ?? "tsdoc"`; `styleInstructions[docStyle]` (3 fixed strings, 419–423); array `[\`${styleInstructions[docStyle]} Return the full code with documentation added.\`, \`\`\`\\n${code}\\n\`\`\`]` → `.join("\n\n")` | 418–427 |
| **generateTypes** | `standard` | `8192` | array `["Generate TypeScript type definitions for this code. Infer interfaces, type aliases, and generics from usage patterns. Return only the typed version of the code.", \`\`\`\\n${code}\\n\`\`\`]` → `.join("\n\n")` | 452–455 |
| **fixBug** | `standard` | `8192` | array `["Fix the bug in this code. Return only the corrected code.", \`Error:\\n${error}\`, \`\`\`\\n${code}\\n\`\`\`]` → `.join("\n\n")` | 481–485 |
| **generateCommitMessage** | `fast` | `1024` | array `["Generate a concise git commit message for this diff using conventional commits format (feat/fix/refactor/docs/test/chore).", "Format: type(scope): description", "Keep the first line under 72 characters. Add a blank line and body only if the change is non-trivial.", "Return only the commit message, nothing else.", \`\`\`diff\\n${diff}\\n\`\`\`]` → `.join("\n\n")` | 510–516 |
| **generateWorkerBoilerplate** | `standard` | `8192` | `parts = ["Generate a complete Cloudflare Worker in TypeScript with proper Env interface, fetch handler, and error handling.", \`Purpose: ${description}\`]`; if `bindings` push `` `Bindings to include in the Env interface: ${bindings}` ``; push `"Include the wrangler.toml snippet as a comment at the top. Return only the code."` → `parts.join("\n\n")` | 542–549 |

**Critical extraction notes:**
- `quickTask` is the ONLY kind whose prompt is the raw input with no wrapping. `buildPrompt` for it returns `input.instruction` unchanged.
- `generateCode` and `generateWorkerBoilerplate` build via a mutable `parts` array with conditional pushes; the rest build a fixed array. `reviewCode` is the only one using `.filter(Boolean)` (to drop the empty `criteria` slot). These differences are exactly the kind of detail a "uniform extraction" can silently flatten — preserve each verbatim.
- The fenced code blocks use a bare ` ``` ` (three backticks, newline, code, newline, three backticks) **except** `generateCommitMessage` which uses ` ```diff `. Preserve the language tag difference.

### `explainCode` depth resolver (verbatim, index.ts:382–394)

```
level = depth ?? "brief"
depthInstructions = {
  brief:    "Explain in 1-2 concise sentences what this code does.",
  detailed: "Provide a detailed walkthrough of this code: purpose, control flow, key decisions, and any notable patterns.",
  eli5:     "Explain this code like I'm 5 years old, using a simple real-world analogy. No jargon.",
}
prompt = [ depthInstructions[level], `\`\`\`\n${code}\n\`\`\`` ].join("\n\n")
tier      = level === "detailed" ? "standard" : "fast"     // brief & eli5 → fast
maxTokens = level === "detailed" ? 4096 : 2048             // brief & eli5 → 2048
```

So the resolver is: `detailed → {tier:"standard", maxTokens:4096}`, `brief|eli5 (and default) → {tier:"fast", maxTokens:2048}`. `observability.test.ts` does **not** assert explainCode's tier directly, but `tool-handlers.test.ts` exercises all three depths through the AI mock; the new `runtask.test.ts` MUST assert all three depth → `{tier,maxTokens}` mappings explicitly (D-06).

### `transformCode` 8KB pre-AI cap (verbatim, index.ts:287–297)

```
const codeBytes = new TextEncoder().encode(code).byteLength;     // BYTE length, not char length
if (codeBytes > TRANSFORM_CODE_MAX_BYTES) {                       // TRANSFORM_CODE_MAX_BYTES = 8_000  (index.ts:31)
  logToolError({ tool: "transformCode", error_type: "AI_ERROR", input_size_bytes: codeBytes });
  return {
    content: [{
      type: "text" as const,
      text: `[ERROR: INPUT_TOO_LARGE] transformCode received ${codeBytes} bytes; cap is ${TRANSFORM_CODE_MAX_BYTES}. Full-file rewrites at this size routinely exceed the ${AI_TIMEOUT_MS / 1000}s model timeout. Scope the transformation to a single function or block and splice the result back yourself.`,
    }],
    isError: true as const,
  };
}
```

**Exact behavior to preserve (D-04, D-05):**
- The cap is `8_000` **bytes** (`TextEncoder().encode(code).byteLength`), checked with strict `>` (so exactly 8000 passes, 8001 trips).
- The over-cap path logs `logToolError({ tool: "transformCode", error_type: "AI_ERROR", input_size_bytes: codeBytes })` — note `error_type: "AI_ERROR"` even though the message says `INPUT_TOO_LARGE`. This is a quirk to preserve byte-for-byte, not fix.
- It returns a hand-built envelope (NOT `makeToolError`) with the exact interpolated message above and `isError: true`.
- It fires **before** the `try` block, so no AI call is made.

**D-04/D-05 placement:** Move the byte-check into `runTask` as a typed `ValidationError` (carrying `codeBytes`). The `transformCode` handler tail catches that specific error type and reconstructs today's exact envelope (including the `logToolError` call with `error_type:"AI_ERROR"` and the interpolated message). This is the **single highest-risk seam** — the message string interpolates `codeBytes`, `TRANSFORM_CODE_MAX_BYTES`, and `AI_TIMEOUT_MS / 1000`; all three must be reachable wherever the message is built. Simplest safe option: keep the message-building in the handler tail and have the thrown `ValidationError` carry `codeBytes` so the tail interpolates exactly as today.

### Handler-tail error mapping (verbatim, every AI-backed handler)

Each handler's `catch` is identical in shape (index.ts:233–238 is the canonical instance):
```
const msg = err instanceof Error ? err.message : "";
const errorType = msg === "AI_TIMEOUT" ? "AI_TIMEOUT" : "AI_ERROR";   // string-equality on message
const inputSize = new TextEncoder().encode(<tool-specific fields>).byteLength;
logToolError({ tool: <name>, error_type: errorType, input_size_bytes: inputSize });
return makeToolError(errorType as ErrorCode, <name>);
```

**The error classification is purely `msg === "AI_TIMEOUT"`.** `callModel` rejects with `new Error("AI_TIMEOUT")` on its own 45s AbortController (index.ts:141); any other rejection (e.g. `"model not found"`, `"unexpected"`) falls through to `AI_ERROR`. For D-05 to map 1:1 with no behavior change, `runTask` must **re-throw the original error unchanged** (or a typed error that still carries `message === "AI_TIMEOUT"` for the timeout case) so the existing `msg === "AI_TIMEOUT"` check in each tail still classifies correctly. The safest extraction: `runTask` does NOT catch AI errors at all — it lets `runAIWithMetrics`'s rejection propagate, and the handler tail catches it exactly as today. Only the `transformCode` validation cap is a *new* typed throw from `runTask`.

**Per-tool `input_size_bytes` fields (verbatim — these vary and must be preserved for `observability.test.ts`):**

| Kind | `input_size_bytes` computed from |
|------|----------------------------------|
| generateCode | `prompt + (context ?? "")` (233) |
| reviewCode | `code` (270) |
| transformCode | `codeBytes` (already computed) (311) |
| scaffoldTests | `code` (341) |
| quickTask | `instruction` (364) |
| explainCode | `code` (400) |
| generateDocs | `code` (435) |
| generateTypes | `code` (463) |
| fixBug | `code + error` (493) |
| generateCommitMessage | `diff` (524) |
| generateWorkerBoilerplate | `description` (555) |

Because this computation lives in the handler **tail** (which stays per D-02), it is unaffected by the head extraction — but the executor must not move it, or `observability.test.ts:116` (`input_size_bytes` is a positive number) and the exact byte values would change.

### `TASK_SPECS` Type Proposal (Claude's Discretion — recommended concrete shape)

A single uniform entry that supports both the per-input resolver (explainCode) and a pre-AI guard (transformCode):

```typescript
type TaskKind =
  | "generateCode" | "reviewCode" | "transformCode" | "scaffoldTests"
  | "quickTask" | "explainCode" | "generateDocs" | "generateTypes"
  | "fixBug" | "generateCommitMessage" | "generateWorkerBoilerplate";

interface TaskSpec {
  /** Pure: resolve tier + maxTokens from input. Constant kinds ignore input. */
  resolve(input: Record<string, unknown>): { tier: ModelTier; maxTokens: number };
  /** Pure: build the exact prompt string. Byte-identical to the current inline build. */
  buildPrompt(input: Record<string, unknown>): string;
  /** Optional pre-AI guard. Throws a typed ValidationError (e.g. transformCode 8KB cap). */
  validate?(input: Record<string, unknown>): void;
}

const TASK_SPECS: Record<TaskKind, TaskSpec> = { /* 11 entries, verbatim from the table above */ };

// Typed errors for D-05 (tagged so handler tails / future batch can distinguish)
class ValidationError extends Error { constructor(msg: string, readonly meta?: Record<string, unknown>) { super(msg); } }
// AI timeout/error are NOT re-wrapped — runTask lets runAIWithMetrics' rejection propagate
// so the existing `msg === "AI_TIMEOUT"` tail check is unchanged.

async function runTask(env: Env, kind: TaskKind, input: Record<string, unknown>): Promise<AIResult> {
  const spec = TASK_SPECS[kind];
  spec.validate?.(input);                               // throws ValidationError (transformCode cap)
  const { tier, maxTokens } = spec.resolve(input);
  return runAIWithMetrics(env, tier, spec.buildPrompt(input), maxTokens);  // may reject AI_TIMEOUT/other
}
```

**Why this shape:** `resolve` unifies constant-tier kinds and explainCode under one field (constant kinds just `return { tier: "standard", maxTokens: 8192 }`). `validate?` is optional so only `transformCode` carries the cap. Errors are split: validation is a *new typed throw from `runTask`*; AI failures are *unchanged propagation* so the existing tail classification (`msg === "AI_TIMEOUT"`) is untouched — minimizing the D-05 risk surface. This satisfies D-01 (full executor returning `AIResult`), D-03 (validate built in), D-04 (special logic in the spec), and D-05 (distinguishable validation vs ai_error/timeout).

### Pattern 1: Behavior-preserving "head extraction" into a dispatch map

**What:** Lift only the prompt-build + tier/maxTokens *head* of each handler into `TASK_SPECS[kind]`; `runTask` runs the head + the AI call; the handler keeps its try/catch/log/return *tail*.
**When to use:** Two callers (single-task tool now, batch tool in Phase 7) must share prompt logic but report errors/log differently.
**Example:** The handler shrinks to:
```typescript
// Source: extraction of src/index.ts:222-240 (generateCode)
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
}
```
Note: `logToolInvocation`'s `tier: "standard"` is a **literal** in the tail today. For explainCode the tier is dynamic — the tail must log `result.tier`-equivalent. Today explainCode logs `tier` (the local var, index.ts:395). Recommend `runTask` returns the resolved `tier` alongside `AIResult` (or the handler reads it from the same `resolve` call) so the log stays accurate. Simplest: extend `AIResult` is risky (it's a public test export, index.ts:758); instead have explainCode's tail recompute `tier` from `depth` exactly as today, OR have `runTask` return `{...AIResult, tier}` as an internal superset the tail destructures. **Flag for planner:** decide how the tail obtains the resolved `tier` for the log without changing `AIResult`'s exported shape.

### Anti-Patterns to Avoid

- **Over-extraction (folding the tail into `runTask`):** Moving `makeToolError`/`logToolInvocation`/`logToolError` into `runTask` couples it to the single-task MCP envelope and breaks the Phase 7 batch path (which reports `{status:'error'}` records, not `isError` envelopes) — and risks `tool-handlers.test.ts`/`observability.test.ts`. Extract only the head. (D-02)
- **Uniform prompt flattening:** Replacing the 11 bespoke builders with one "generic" template. Each prompt differs in wording, ordering, fence language tag, and array-vs-parts construction. Flatten and you silently degrade real output quality while CI stays green (the AI mock can't see it).
- **Re-wrapping AI errors in `runTask`:** Catching and re-throwing AI failures as a new error type changes `err.message`, breaking the tail's `msg === "AI_TIMEOUT"` check. Let AI rejections propagate untouched; only *validation* is a new typed throw.
- **Rewriting `inputSchema` to `z.object()`:** The repo uses the `ZodRawShape` form (`inputSchema: { prompt: z.string()... }`). Keep it. `input-validation.test.ts:12` reads `tool.inputSchema` and calls `.parse()` on it — changing the form could break that seam.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| AI call + model resolution + timeout + latency | A second AI-invocation path inside `runTask` | Call the existing `runAIWithMetrics(env, tier, prompt, maxTokens)` (index.ts:174) | It already owns `resolveModel`, the 45s AbortController via `callModel`, and latency timing. D-01 mandates reuse. |
| Error envelope | A new error-formatting function | Existing `makeToolError(code, toolName)` (index.ts:191) in the handler tail | Tests assert its exact message strings; reuse unchanged. |
| Structured logs | New log calls in `runTask` | Existing `logToolInvocation`/`logToolError` in the tail (`./logger`) | `observability.test.ts` parses their exact fields. Keep them where they are. |
| Per-kind input caps | New Zod schemas in `TASK_SPECS` | Reuse the *exact* caps already on each tool's `inputSchema` (D-03) | Duplicating with drift is the failure mode D-03 explicitly forbids. Reference the same `.max()` values. |

**Key insight:** In this phase, "don't hand-roll" means "don't re-implement anything that already exists in `src/index.ts`." The whole phase is *relocation*, not *creation* — the only genuinely new code is the `TASK_SPECS` table (copied verbatim), the thin `runTask` wrapper, one `ValidationError` class, and `runtask.test.ts`.

## Runtime State Inventory

> This is a code-only refactor of a single file. No data stores, no live-service config, no OS-registered state, no secrets, no build artifacts are renamed or migrated.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None — verified by reading `src/index.ts` (only KV use is `config:model:fast`/`config:model:standard` in `resolveModel`, untouched this phase) | None |
| Live service config | None — `wrangler.toml` bindings (AI, OAUTH_KV, MCP_SECRET, AUTH_RATE_LIMITER) are unchanged; no new `[vars]` added (the `BATCH_*` vars are Phase 6) | None |
| OS-registered state | None — no scheduled tasks, no pm2/systemd; deploy is `wrangler deploy` via `scripts/deploy.sh` | None |
| Secrets/env vars | None — `MCP_SECRET` and the KV model keys are untouched; no env var renamed | None |
| Build artifacts | None — no codegen output renamed. `wrangler types` regenerates `worker-configuration.d.ts` only if `Env` gains typed fields; Phase 5 adds no `Env` fields (D-01 signature is `runTask(env, kind, input)`, no new bindings) | None |

**Nothing found in any category** — Phase 5 touches only `src/index.ts` logic and adds `src/__tests__/runtask.test.ts`. The public test exports at index.ts:757–758 (`createMcpServer`, `runAIWithMetrics`, `AIResult`, `ModelTier`, etc.) must remain exported for the existing tests; if `runTask`/`TASK_SPECS`/`TaskKind` are added to that export line for the new test to import, that is additive only.

## Common Pitfalls

### Pitfall 1: Prompt drift invisible to the AI-mocked suite

**What goes wrong:** `createMockAI` (helpers.ts:23) returns `{ response: "mock-response" }` (or the test-set `aiResponse`) regardless of the prompt. So `tool-handlers.test.ts` asserts only `result.content[0].text === "mock AI output"` — it never inspects the prompt the model would see. A whitespace, ordering, or wording change in any `buildPrompt` passes all 108 tests while silently degrading real output.
**Why it happens:** "Extract a function" feels mechanical, but the 11 builders are not uniform (parts-array vs fixed-array vs raw-passthrough; `.filter(Boolean)`; ` ```diff ` vs ` ``` `).
**How to avoid:** The new `runtask.test.ts` (D-06) asserts byte-identical `buildPrompt` output per kind with literal expected strings. This is the ONLY guard; it is load-bearing, not optional.
**Warning signs:** All existing tests green but a manual diff of `buildPrompt` output vs the pre-refactor inline string differs.

### Pitfall 2: explainCode tier/maxTokens collapsed to a constant

**What goes wrong:** A `TASK_SPECS` entry that hardcodes one tier/maxTokens for explainCode breaks the `depth`-conditional routing (`detailed → standard/4096`, else `fast/2048`).
**Why it happens:** 10 of 11 kinds have constant tier/tokens; explainCode is the exception and is easy to flatten.
**How to avoid:** `resolve(input)` branches on `depth`. `runtask.test.ts` asserts all three depths → `{tier,maxTokens}`. Also verify the explainCode handler tail still logs the *resolved* tier (today it logs the local `tier` var, index.ts:395) — see the "Flag for planner" note in Pattern 1.
**Warning signs:** `observability.test.ts` or a new `runtask.test.ts` tier assertion fails for explainCode.

### Pitfall 3: transformCode cap moved/dropped or message drift

**What goes wrong:** The 8000-byte cap returns a *specific* `INPUT_TOO_LARGE` envelope (not `makeToolError`), logs `error_type:"AI_ERROR"`, and fires before the AI call. If the cap moves wholesale into `runTask` and `runTask` builds the envelope, the single-task response shape changes; if the message interpolation drifts, the byte-for-byte requirement (D-05) breaks.
**Why it happens:** It's the one kind with a hand-built error envelope and a pre-flight guard, plus a deliberate `error_type:"AI_ERROR"`/message-`INPUT_TOO_LARGE` mismatch that looks like a bug to "fix."
**How to avoid:** Throw a typed `ValidationError(codeBytes)` from `runTask`; the transformCode handler tail catches it and rebuilds today's exact envelope + `logToolError`. Keep the `error_type:"AI_ERROR"` quirk. `runtask.test.ts` tests 8000 bytes (passes) and 8001 bytes (throws). Behavior tested via tool-handlers path stays green.
**Warning signs:** `tool-handlers.test.ts` transformCode case or a new over-cap test fails; the message string differs.

### Pitfall 4: AI error re-wrapping breaks `msg === "AI_TIMEOUT"` classification

**What goes wrong:** If `runTask` catches and re-throws AI failures (e.g. `throw new AiError(...)`), `err.message` changes and the tail's `msg === "AI_TIMEOUT"` check (index.ts:235) misclassifies timeouts as `AI_ERROR`.
**Why it happens:** D-05 says "throw distinguishable typed errors," which can be misread as "wrap every error."
**How to avoid:** Only *validation* is a new typed throw. AI rejections propagate untouched from `runAIWithMetrics` → the tail catches `Error("AI_TIMEOUT")` exactly as today. The typed taxonomy for Phase 7 (`timeout | validation | ai_error`) can be derived in Phase 7 from the same message check; Phase 5 doesn't need to wrap them.
**Warning signs:** `tool-handlers.test.ts` "returns AI_TIMEOUT error" cases fail (return AI_ERROR instead).

### Pitfall 5: Forgetting to export `runTask`/`TASK_SPECS` for the test

**What goes wrong:** `runtask.test.ts` can't import `TASK_SPECS`/`runTask` because they're module-private; or the test reaches into internals fragilely.
**How to avoid:** Add `runTask`, `TASK_SPECS`, and the `TaskKind` type to the named test-exports block (index.ts:757–758), mirroring how `createMcpServer`, `runAIWithMetrics`, `makeToolError` are already exported for tests. Additive only.
**Warning signs:** TS import error in `runtask.test.ts`.

## Code Examples

### Asserting byte-identical prompt + resolved tier/maxTokens (the new test surface)
```typescript
// Source: pattern derived from existing src/__tests__/input-validation.test.ts (schema access)
//         and tool-handlers.test.ts (createMockEnv usage)
import { describe, it, expect } from "vitest";
import { TASK_SPECS } from "../index";

describe("BATCH-02: runTask prompt snapshots", () => {
  it("generateCode prompt is byte-identical", () => {
    const prompt = TASK_SPECS.generateCode.buildPrompt({
      prompt: "write hello world", context: undefined, language: "typescript", style: undefined,
    });
    expect(prompt).toBe("Language: typescript\n\nTask:\nwrite hello world");
  });

  it("explainCode resolves tier/maxTokens per depth", () => {
    expect(TASK_SPECS.explainCode.resolve({ code: "x", depth: "detailed" })).toEqual({ tier: "standard", maxTokens: 4096 });
    expect(TASK_SPECS.explainCode.resolve({ code: "x", depth: "brief" })).toEqual({ tier: "fast", maxTokens: 2048 });
    expect(TASK_SPECS.explainCode.resolve({ code: "x", depth: "eli5" })).toEqual({ tier: "fast", maxTokens: 2048 });
    expect(TASK_SPECS.explainCode.resolve({ code: "x" })).toEqual({ tier: "fast", maxTokens: 2048 }); // default brief
  });

  it("transformCode validate throws at 8001 bytes, passes at 8000", () => {
    const at = "x".repeat(8000);
    const over = "x".repeat(8001);
    expect(() => TASK_SPECS.transformCode.validate!({ code: at, instruction: "rename" })).not.toThrow();
    expect(() => TASK_SPECS.transformCode.validate!({ code: over, instruction: "rename" })).toThrow();
  });
});
```

### Running runTask end-to-end against the mock AI (behavior parity)
```typescript
// Source: createMockEnv from src/__tests__/helpers.ts
import { runTask } from "../index";
import { createMockEnv } from "./helpers";

it("runTask returns AIResult for a valid kind", async () => {
  const env = createMockEnv({ aiResponse: "mock AI output" });
  const result = await runTask(env, "generateCode", { prompt: "hi" });
  expect(result.text).toBe("mock AI output");
  expect(result.model).toBe("@cf/qwen/qwen3-30b-a3b-fp8");
  expect(typeof result.latency_ms).toBe("number");
});
```

## State of the Art

> Not applicable — this is an internal refactor of existing, current code. No library/version migration, no deprecated API. The MCP SDK (1.29.0) and Zod (4.3.6) are current and unchanged.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The explainCode handler tail should obtain the resolved `tier` for `logToolInvocation` either by recomputing from `depth` or by `runTask` returning a `{...AIResult, tier}` superset — without changing the exported `AIResult` shape. `[ASSUMED]` — exact mechanism is planner's discretion; both preserve the logged value. | Pattern 1 / Pitfall 2 | If the log loses the dynamic tier, `observability.test.ts` (if it asserts explainCode tier) or future batch logging drifts. Mitigated: today's tail already has `depth` in scope, so recompute is trivial and zero-risk. |
| A2 | Keeping `runTask`/`TASK_SPECS` in `src/index.ts` (vs a new module) introduces no circular import. `[ASSUMED]` — based on `runTask` sitting above `runAIWithMetrics` in the same file; not separately verified by attempting a split. | Standard Stack / Alternatives | If a split is later chosen and a cycle appears, mitigation is documented (lift exec helpers into `src/exec.ts`). In-file placement avoids the risk entirely. |

**All other claims are `[VERIFIED: src/index.ts]` or `[VERIFIED: test run]`.** The per-kind table, depth resolver, byte cap, error mapping, and 108-test green baseline were read/run directly this session.

## Open Questions

1. **Does the explainCode handler tail's `logToolInvocation` tier value need to come from `runTask`?**
   - What we know: today it logs the local `tier` var (index.ts:395), which is dynamic by depth. After extraction the tail no longer computes `tier` unless it re-derives from `depth` or receives it back.
   - What's unclear: whether the planner prefers re-deriving in the tail vs returning `tier` from `runTask`.
   - Recommendation: re-derive in the tail (`depth === "detailed" ? "standard" : "fast"`) — zero new surface, keeps `AIResult` export unchanged. Trivial and safe.

2. **Should `runtask.test.ts` also call `runTask` end-to-end (mock AI), or only test the pure `TASK_SPECS` functions?**
   - What we know: D-06 requires asserting `buildPrompt` + resolved tier/maxTokens per kind (pure functions). Tail behavior is already covered by `tool-handlers.test.ts`.
   - Recommendation: do both — pure `TASK_SPECS` assertions for the byte-equality contract (the load-bearing part) plus a couple of `runTask` end-to-end smoke tests for the wiring. Cheap, with the existing `createMockEnv`.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| `vitest` | Running the suite + new `runtask.test.ts` | ✓ | 4.1.4 (installed) | — |
| `@cloudflare/vitest-pool-workers` | Workers-pool test env | ✓ | 0.14.3 (installed) | — |
| `typescript` (`tsc --noEmit`) | Type-check gate | ✓ | 5.8.x (installed) | — |
| `@modelcontextprotocol/sdk` | Tool registration (unchanged) | ✓ | 1.29.0 (installed) | — |
| `zod` | Per-kind caps (D-03) | ✓ | 4.3.6 (installed) | — |

**Missing dependencies with no fallback:** None.
**Missing dependencies with fallback:** None. The full toolchain is installed; the 108-test suite ran green this session (`npx vitest run`, 2.17s).

## Validation Architecture

> `workflow.nyquist_validation` is absent from `.planning/config.json` → treated as enabled. The phase is a behavior-preserving refactor, so the validation strategy is built around proving "observable behavior identical to today."

### Test Framework
| Property | Value |
|----------|-------|
| Framework | `vitest` 4.1.4 + `@cloudflare/vitest-pool-workers` 0.14.3 |
| Config file | `vitest.config.mts` (Workers pool, mocks `OAUTH_KV`, `MCP_SECRET`, `AUTH_RATE_LIMITER`) |
| Quick run command | `npx vitest run src/__tests__/runtask.test.ts --reporter=dot` |
| Full suite command | `npm test` (`vitest run --reporter=verbose`) |
| Type gate | `npx tsc --noEmit` |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| BATCH-01 | All 108 existing tests stay green after extraction (envelope, error mapping, logs, input caps unchanged) | regression | `npm test` | ✅ (8 files, 108 tests, currently green) |
| BATCH-01 | `runTask(env, kind, input)` returns `{text, model, latency_ms}` for each kind via mock AI | integration | `npx vitest run src/__tests__/runtask.test.ts` | ❌ Wave 0 (`runtask.test.ts`) |
| BATCH-02 | Byte-identical `buildPrompt` per kind (all 11) | unit (snapshot) | `npx vitest run src/__tests__/runtask.test.ts` | ❌ Wave 0 |
| BATCH-02 | explainCode `resolve(depth)` → `{tier,maxTokens}` for detailed/brief/eli5/default | unit | `npx vitest run src/__tests__/runtask.test.ts` | ❌ Wave 0 |
| BATCH-02 | transformCode `validate` passes at 8000 bytes, throws at 8001 | unit | `npx vitest run src/__tests__/runtask.test.ts` | ❌ Wave 0 |
| BATCH-01 | transformCode single-task over-cap returns today's exact `INPUT_TOO_LARGE` envelope | regression | covered by `tool-handlers.test.ts` + a new explicit over-cap assertion in `runtask.test.ts` | ✅ partial / ❌ explicit assertion Wave 0 |
| — | Type safety (no `any` regressions in the new dispatch) | static | `npx tsc --noEmit` | ✅ (gate) |

**What observable behaviors prove the refactor is correct:**
1. `npm test` → 108 passed (every envelope/error/log/cap assertion unchanged).
2. `npx tsc --noEmit` clean.
3. `runtask.test.ts` → byte-identical prompt per kind (the only guard for prompt drift, since the AI mock is prompt-blind).
4. explainCode depth routing preserved (3 depths + default → correct `{tier,maxTokens}`).
5. transformCode 8KB cap preserved (8000 ok / 8001 throws; single-task envelope byte-identical).

### Sampling Rate
- **Per task commit:** `npx vitest run src/__tests__/runtask.test.ts --reporter=dot` + `npx tsc --noEmit`
- **Per wave merge:** `npm test` (full 108 + new)
- **Phase gate:** Full suite green + `tsc --noEmit` clean before `/gsd:verify-work`

### Wave 0 Gaps
- [ ] `src/__tests__/runtask.test.ts` — covers BATCH-01 (runTask wiring) + BATCH-02 (prompt snapshots, explainCode resolve, transformCode cap). New file; uses existing `createMockEnv` from `helpers.ts`; imports `TASK_SPECS`/`runTask`/`TaskKind` added to the index.ts test-export block.
- [ ] Add `runTask`, `TASK_SPECS`, `TaskKind` to the named export line `src/index.ts:757-758` so the new test can import them (additive, no behavior change).
- Framework install: none — vitest + pool already present.

*No conftest/fixture gaps: `helpers.ts` `createMockEnv`/`createMockAI` already provide everything the new test needs.*

## Security Domain

> `security_enforcement` is not configured in `.planning/config.json`. This phase is a pure internal refactor with **no new input surface, no new endpoint, no new dependency, and no auth change** — the OAuth gate, CSRF flow, `timingSafeEqual`, rate limiter, and input caps are all untouched. The relevant security control is *preservation*:

| Concern | Applies | Standard Control (preserved, not added) |
|---------|---------|------------------------------------------|
| V5 Input Validation | yes (preserve) | The existing per-tool Zod caps (`.max()`/`.trim()`) at the MCP boundary stay exactly; D-03 reuses the same caps inside `runTask` without weakening them. transformCode's 8KB byte cap is preserved byte-for-byte. |
| Error/log hygiene | yes (preserve) | `logToolError` must keep omitting stack traces and prompt content (`observability.test.ts:139` asserts no `stack`; `:75-90` asserts no prompt/response/content/input in logs). The refactor must not log prompt text from `runTask`. |
| V6 Cryptography | no | No crypto touched (`timingSafeEqual`/CSRF untouched). |
| AuthN/AuthZ (V2/V3/V4) | no | OAuthProvider wiring and the `/mcp` gate are unchanged; no new route registered. |

**Threat note:** The only new security-relevant risk is *log leakage* — if `runTask` (the new code) were to log prompt content or stack traces, it would violate the v1.0 "never log prompt/stack" discipline. Mitigation: `runTask` does **no logging**; all logging stays in the handler tail exactly as today (D-02). Verified guard: `observability.test.ts` would turn red if prompt/response/stack appeared in any log.

## Sources

### Primary (HIGH confidence)
- `src/index.ts` (read in full) — the 11 handlers (211–560), `callModel` (130–166), `runAIWithMetrics`/`runAI` (174–185), `resolveModel` (36–50), `makeToolError` (191–201), `createMcpServer` (205–579), `TRANSFORM_CODE_MAX_BYTES`/`AI_TIMEOUT_MS` (26/31), test-export block (757–758). The per-kind table, depth resolver, byte cap, and error mapping are transcribed verbatim from this read.
- `src/__tests__/helpers.ts`, `tool-handlers.test.ts`, `observability.test.ts`, `input-validation.test.ts`, `vitest.config.mts` — grounds the "tests stay green" analysis and the new test's shape (`createMockEnv`, `_registeredTools[name].handler`, `tool.inputSchema.parse`).
- **Test run this session:** `npx vitest run` → `Test Files 8 passed (8) / Tests 108 passed (108)` (2.17s) — confirms the 108 baseline and that all 8 suites are green pre-refactor.
- `package.json` — SDK `^1.26.0` (1.29.0 installed), zod `^4.0.0` (4.3.6), vitest 4.1.4, pool 0.14.3; no `p-limit`.
- `.planning/phases/05-extract-shared-runtask-executor/05-CONTEXT.md` — locked decisions D-01..D-06 (copied verbatim into User Constraints).
- `.planning/REQUIREMENTS.md` — BATCH-01, BATCH-02.

### Secondary (MEDIUM confidence)
- `.planning/research/ARCHITECTURE.md`, `PITFALLS.md`, `STACK.md` — milestone-level research (head/tail split, prompt-drift guard, zero-new-deps). Cross-checked against the live code; line numbers there match the current `src/index.ts`.
- `.planning/batch.ts` — reference for the future batch tool's `runTask` injection point (Phase 7 context only; not implemented in Phase 5).

### Tertiary (LOW confidence)
- `.planning/codebase/TESTING.md` — **stale (dated 2026-04-12, predates the test suite; says "no tests configured")**. Superseded by the direct read of the 8 test files and the green 108-test run. Do not rely on TESTING.md for the current state.

## Metadata

**Confidence breakdown:**
- Per-kind extraction table (stack/prompts/tiers/maxTokens): HIGH — transcribed verbatim from `src/index.ts`.
- Architecture (head/tail split, TASK_SPECS shape): HIGH — grounded in the actual handler structure and the green 108-test baseline.
- Pitfalls: HIGH — each maps to a specific line and a specific test that would catch the regression.
- Validation architecture: HIGH — framework and baseline confirmed by running the suite this session.

**Research date:** 2026-06-26
**Valid until:** 2026-07-26 (stable — internal refactor; only invalidated if `src/index.ts` handlers or the test suite change before planning)
