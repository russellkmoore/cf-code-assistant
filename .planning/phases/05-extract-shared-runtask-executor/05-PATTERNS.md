# Phase 5: Extract Shared `runTask` Executor - Pattern Map

**Mapped:** 2026-06-26
**Files analyzed:** 2 surfaces (1 modified file `src/index.ts`, 1 new file `src/__tests__/runtask.test.ts`)
**Analogs found:** 2 / 2 (both analogs are in-repo, in the same module / test suite being extended)

> This phase is a **behavior-preserving extraction**, not new construction. Every "new" surface
> has a precise in-repo analog because the code already exists inline — the work is *relocation*
> into a `TASK_SPECS` dispatch map + `runTask` wrapper. The analogs below are the **exact lines
> being lifted**; the planner must replicate them byte-for-byte, not "improve" them.

## File Classification

| New/Modified Surface | Role | Data Flow | Closest Analog | Match Quality |
|----------------------|------|-----------|----------------|---------------|
| `runTask(env, kind, input)` executor (in `src/index.ts`) | service / dispatcher | request-response (validate → build → AI call) | `runAIWithMetrics` (`src/index.ts:174-180`) — the function `runTask` wraps; and `resolveModel` (`:36-50`) — existing tier→model typed dispatch precedent | exact (wraps an existing fn) |
| `TASK_SPECS: Record<TaskKind, TaskSpec>` map (in `src/index.ts`) | config / dispatch table | transform (pure input→prompt + tier policy) | The 11 handler **heads** (`src/index.ts:222-560`); `DEFAULT_MODELS` (`:21-24`) as the existing `Record<tier, …>` const-map shape | exact (table values copied verbatim from heads) |
| 11 modified handler bodies (in `src/index.ts`) | controller (MCP tool handler) | request-response | The handlers themselves today (`:222-560`); the **tail** stays, the head delegates | exact (in-place shrink) |
| `src/__tests__/runtask.test.ts` (NEW) | test (unit + integration) | request-response (assert pure fns + mock-AI smoke) | `input-validation.test.ts` (schema-access + boundary assertions) and `tool-handlers.test.ts` (`createMockEnv` + handler invocation) | role-match (same vitest + Workers-pool layout) |

---

## Pattern Assignments

### `runTask` + `TASK_SPECS` (service + config, in `src/index.ts`)

**Analog A — the function `runTask` wraps (`src/index.ts:168-185`):**
```typescript
interface AIResult {
  text: string;
  model: string;
  latency_ms: number;
}

async function runAIWithMetrics(env: Env, tier: ModelTier, userPrompt: string, maxTokens = 4096): Promise<AIResult> {
  const model = await resolveModel(env, tier);
  const start = Date.now();
  const text = await callModel(env, model, userPrompt, maxTokens);
  const latency_ms = Date.now() - start;
  return { text, model: model as string, latency_ms };
}
```
`runTask` returns this exact `AIResult` (D-01). Do **not** change `AIResult`'s shape — it is an
exported test type (`src/index.ts:758`). If the tail needs the resolved `tier` for logging
(explainCode), re-derive it in the tail from `depth` (see "explainCode tier-for-log" note below),
**not** by widening `AIResult`.

**Analog B — existing typed dispatch-map precedent (`src/index.ts:21-24` and `:36-50`):**
```typescript
const DEFAULT_MODELS: Record<ModelTier, keyof AiModels> = {
  fast: "@cf/qwen/qwen3-30b-a3b-fp8",
  standard: "@cf/qwen/qwen3-30b-a3b-fp8",
};
```
This is the in-repo precedent for `TASK_SPECS: Record<TaskKind, TaskSpec>` — a `Record` keyed by a
string-union type, looked up by key. `resolveModel` (`:36-50`) is the precedent for a typed lookup
function that returns the resolved policy. `runTask` mirrors `resolveModel`'s shape: look up by key,
return resolved values.

**Core pattern — a representative handler HEAD to lift (generateCode, `src/index.ts:224-230`):**
```typescript
const parts: string[] = [];
if (language) parts.push(`Language: ${language}`);
if (style) parts.push(`Style: ${style}`);
if (context) parts.push(`Context:\n${context}`);
parts.push(`Task:\n${prompt}`);
// → runAIWithMetrics(env, "standard", parts.join("\n\n"), 8192)
```
This entire `parts`-assembly becomes `TASK_SPECS.generateCode.buildPrompt(input)` returning
`parts.join("\n\n")`; `resolve` returns `{ tier: "standard", maxTokens: 8192 }`. **The mutable
`parts`-array-with-conditional-pushes idiom must be preserved** — it differs from the fixed-array
`.join` idiom used by reviewCode/scaffoldTests/etc. (only generateCode and
generateWorkerBoilerplate use it). See the verbatim Per-Kind Extraction Table in
`05-RESEARCH.md` lines 140-152 for all 11 — that table is the source of truth; do not re-derive.

**explainCode depth branch — special `resolve(input)` (verbatim, `src/index.ts:382-394`):**
```typescript
const level = depth ?? "brief";
const depthInstructions: Record<string, string> = {
  brief: "Explain in 1-2 concise sentences what this code does.",
  detailed: "Provide a detailed walkthrough of this code: purpose, control flow, key decisions, and any notable patterns.",
  eli5: "Explain this code like I'm 5 years old, using a simple real-world analogy. No jargon.",
};
const prompt = [
  depthInstructions[level],
  `\`\`\`\n${code}\n\`\`\``,
].join("\n\n");

const tier: ModelTier = level === "detailed" ? "standard" : "fast";
const result = await runAIWithMetrics(env, tier, prompt, level === "detailed" ? 4096 : 2048);
logToolInvocation({ tool: "explainCode", tier, model: result.model, latency_ms: result.latency_ms });
```
`resolve` branches: `detailed → {tier:"standard", maxTokens:4096}`, `brief|eli5|default →
{tier:"fast", maxTokens:2048}`. This is the ONLY kind whose tier/maxTokens are input-dependent —
do not flatten to a constant (Pitfall 2 in `05-RESEARCH.md`).
**explainCode tier-for-log note:** today the tail logs the local `tier` var (`:395`). After
extraction, the tail no longer computes it — re-derive in the tail as
`depth === "detailed" ? "standard" : "fast"` (zero new surface, keeps `AIResult` unchanged).

**transformCode 8KB cap — special `validate(input)` (verbatim, `src/index.ts:287-297`):**
```typescript
const codeBytes = new TextEncoder().encode(code).byteLength;
if (codeBytes > TRANSFORM_CODE_MAX_BYTES) {            // TRANSFORM_CODE_MAX_BYTES = 8_000 (src/index.ts:31)
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
**Highest-risk seam (D-04/D-05).** Move only the **byte-check** into `runTask` (via
`TASK_SPECS.transformCode.validate`), throwing a typed `ValidationError` that **carries
`codeBytes`**. The handler tail catches that specific error type and **rebuilds today's exact
envelope** — including the `logToolError({ ..., error_type: "AI_ERROR", ... })` call (keep the
`error_type:"AI_ERROR"` quirk; it is intentional, NOT a bug to fix) and the byte-for-byte
interpolated message above (`codeBytes`, `TRANSFORM_CODE_MAX_BYTES`, `AI_TIMEOUT_MS / 1000` must all
be reachable where the message is built). Strict `>`: 8000 passes, 8001 trips. Fires BEFORE any AI call.

**Handler catch/tail — UNCHANGED, stays per-tool (canonical instance, `src/index.ts:233-238`):**
```typescript
} catch (err) {
  const msg = err instanceof Error ? err.message : "";
  const errorType = msg === "AI_TIMEOUT" ? "AI_TIMEOUT" : "AI_ERROR";
  const inputSize = new TextEncoder().encode(prompt + (context ?? "")).byteLength;
  logToolError({ tool: "generateCode", error_type: errorType, input_size_bytes: inputSize });
  return makeToolError(errorType as ErrorCode, "generateCode");
}
```
**Do NOT move this into `runTask` (anti-pattern: over-extraction).** AI rejections must
**propagate untouched** from `runAIWithMetrics` so the `msg === "AI_TIMEOUT"` string-equality check
still classifies correctly (Pitfall 4). The per-tool `input_size_bytes` field computations vary by
tool and stay in the tail — see `05-RESEARCH.md` lines 212-228 for the verbatim per-kind list.
Only the **validation** path is a new typed throw; AI errors are never re-wrapped.

**Resulting shrunk handler (target shape, derived from `src/index.ts:222-240`):**
```typescript
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

**Export note (`src/index.ts:757-758`):** add `runTask`, `TASK_SPECS`, and `TaskKind` to the
existing named test-export block (additive only) so `runtask.test.ts` can import them — mirroring how
`createMcpServer`, `runAIWithMetrics`, `makeToolError`, `AIResult`, `ModelTier` are already exported.

---

### `src/__tests__/runtask.test.ts` (test, unit + integration)

**Analog A — schema/internal access + boundary assertions (`input-validation.test.ts:1-17`):**
```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { createMcpServer } from "../index";
import { createMockEnv } from "./helpers";

function getToolSchema(env: Env, toolName: string) {
  const server = createMcpServer(env);
  const tools = (server as any)._registeredTools;
  const tool = tools[toolName];
  if (!tool) throw new Error(`Tool "${toolName}" not registered`);
  return tool.inputSchema;
}

function strOfLen(n: number): string {
  return "x".repeat(n);
}
```
The new test does NOT need `getToolSchema` (it imports `TASK_SPECS` directly), but reuse the
`strOfLen(n)` helper idiom for the transformCode 8000/8001-byte boundary, and the
`expect(() => …).toThrow()` / `.not.toThrow()` assertion style for the cap.

**Analog B — mock-AI env setup + handler invocation (`tool-handlers.test.ts:1-29`):**
```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMcpServer } from "../index";
import { createMockEnv } from "./helpers";

describe("TEST-03: Fast-tier tool handlers", () => {
  let env: Env;
  beforeEach(() => {
    env = createMockEnv({ aiResponse: "mock AI output" });
  });

  describe("quickTask", () => {
    it("returns AI response for valid instruction", async () => {
      const handler = getToolHandler(env, "quickTask");
      const result = await handler({ instruction: "regex for email" }, undefined);
      expect(result.content[0].text).toBe("mock AI output");
      expect(env.AI.run).toHaveBeenCalled();
    });
```
Use `createMockEnv({ aiResponse: "mock AI output" })` for the `runTask` end-to-end smoke tests
(D-01 wiring) so `result.text === "mock AI output"`, `result.model === "@cf/qwen/qwen3-30b-a3b-fp8"`,
`typeof result.latency_ms === "number"`.

**`createMockEnv` / `createMockAI` contract the new test relies on (`helpers.ts:23-54`):**
```typescript
export function createMockAI(response: string = "mock-response"): Ai {
  return { run: vi.fn(async () => ({ response })) } as unknown as Ai;
}
export function createMockEnv(overrides: { aiResponse?: string; /* … */ } = {}): Env {
  return {
    OAUTH_KV: createMockKV(overrides.kvData ?? {}),
    AI: createMockAI(overrides.aiResponse ?? "mock-response"),
    MCP_SECRET: overrides.mcpSecret ?? "test-secret-pin",
    AUTH_RATE_LIMITER: createMockRateLimiter(overrides.rateLimitSuccess ?? true),
  } as Env;
}
```
**Critical — why the new test is load-bearing (BATCH-02):** `createMockAI` returns
`{ response }` **regardless of the prompt string**. So every existing suite is structurally blind
to prompt drift. `runtask.test.ts` must assert **byte-identical `buildPrompt` output per kind** with
literal expected strings (`expect(prompt).toBe("Language: typescript\n\nTask:\nwrite hello world")`),
because no mock-AI test can ever catch a whitespace/ordering/wording change in the prompt the model
actually receives.

**Layout to match (no new config):** new file goes in `src/__tests__/`; it runs in the existing
Workers pool from `vitest.config.mts` (globals on, `OAUTH_KV` KV namespace, `AUTH_RATE_LIMITER`
rate limit, `MCP_SECRET` binding). Import via relative `../index` and `./helpers`. No new dev
dependency, no `.snap` file (prefer inline `toBe` per RESEARCH alternatives).

---

## Shared Patterns

### Typed dispatch map (`Record<UnionType, …>` lookup)
**Source:** `DEFAULT_MODELS` (`src/index.ts:21-24`), `resolveModel` (`:36-50`)
**Apply to:** `TASK_SPECS` + `runTask`
The repo already keys a `Record` by a string-union (`ModelTier`) and resolves via a lookup
function. `TaskKind` → `TASK_SPECS[kind]` → `runTask` is the same idiom one level up.

### AI invocation + metrics (DO NOT re-implement)
**Source:** `runAIWithMetrics(env, tier, prompt, maxTokens)` (`src/index.ts:174-180`)
**Apply to:** `runTask` (calls it once; returns its `AIResult` unchanged)
Owns `resolveModel`, the 45s AbortController (via `callModel`), and latency timing. D-01 mandates
reuse — no second AI path inside `runTask`.

### Error envelope + classification (stays in handler tail)
**Source:** `makeToolError(code, toolName)` (`src/index.ts:191-201`); the `catch` block at `:233-238`
**Apply to:** all 11 handler tails (unchanged), plus transformCode's hand-built `INPUT_TOO_LARGE`
envelope (`:288-297`)
Classification is pure `msg === "AI_TIMEOUT"`. Tests assert exact message strings. Keep per-tool so
the `tool` log tag is correct (D-02).

### Structured logging (stays in handler tail)
**Source:** `logToolInvocation` / `logToolError` from `./logger` (`src/index.ts:5`)
**Apply to:** all 11 handler tails (unchanged). `runTask` does **zero** logging — `observability.test.ts`
asserts no `prompt`/`response`/`content`/`input`/`stack` ever appears in logs, and asserts exact
`tier`/`model`/`input_size_bytes` fields.

### Per-kind input caps (reuse, don't duplicate-with-drift)
**Source:** each tool's `inputSchema` ZodRawShape (e.g. generateCode `:215-220`)
**Apply to:** `TASK_SPECS[kind].validate` per D-03 — reuse the **exact** `.max()` caps already on
the `inputSchema`. Keep the `ZodRawShape` form (`inputSchema: { prompt: z.string()… }`); do NOT
refactor to `z.object()` (`input-validation.test.ts:12` reads `tool.inputSchema` and `.parse()`s it).

### Test setup (vitest + Workers pool)
**Source:** `input-validation.test.ts:1-17`, `tool-handlers.test.ts:1-29`, `helpers.ts:23-54`
**Apply to:** `runtask.test.ts` — `import { describe, it, expect } from "vitest"`,
`createMockEnv({ aiResponse })` for end-to-end, `strOfLen(n)` + `.toThrow()`/`.not.toThrow()` for
the byte cap, direct `TASK_SPECS.<kind>.buildPrompt(...)` / `.resolve(...)` for prompt + tier
snapshots.

## No Analog Found

| Surface | Role | Data Flow | Reason |
|---------|------|-----------|--------|
| `ValidationError` class | error type | — | No custom Error subclass exists in the repo today (errors are plain `new Error("AI_TIMEOUT")` strings). This is genuinely new, but trivial: a one-line `class ValidationError extends Error` carrying `codeBytes` in `meta`. Its only consumer is the transformCode handler tail, which maps it to today's exact `INPUT_TOO_LARGE` envelope. No prior pattern to copy; follow the RESEARCH `TASK_SPECS` type proposal (`05-RESEARCH.md:234-264`). |

> Everything else has a verbatim in-repo analog — this phase creates almost no new logic, it relocates
> existing logic into a dispatch map. The genuinely-new code is: the `TASK_SPECS` table (values copied
> verbatim from the 11 heads), the thin `runTask` wrapper (mirrors `resolveModel`'s lookup shape +
> calls `runAIWithMetrics`), one `ValidationError` class, and `runtask.test.ts`.

## Metadata

**Analog search scope:** `src/index.ts` (full read), `src/__tests__/` (helpers.ts, tool-handlers.test.ts,
input-validation.test.ts, observability.test.ts), `vitest.config.mts`
**Files scanned:** 6 (1 implementation file, 4 test files, 1 vitest config)
**Pattern extraction date:** 2026-06-26
**Hard constraint:** behavior-preserving. The verbatim Per-Kind Extraction Table
(`05-RESEARCH.md:140-152`), the explainCode resolver (`05-RESEARCH.md:159-173`), the transformCode
cap (`05-RESEARCH.md:175-197`), and the per-kind `input_size_bytes` list (`05-RESEARCH.md:212-228`)
are the byte-level source of truth — this PATTERNS.md points the planner at the live analog lines;
the RESEARCH tables hold the exact strings.
