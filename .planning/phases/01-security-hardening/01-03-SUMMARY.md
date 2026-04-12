---
phase: 01-security-hardening
plan: 03
subsystem: src/index.ts
tags: [security, input-validation, auth, timing-attack]
dependency_graph:
  requires: [01-02]
  provides: [SEC-02, HARD-03, timingSafeEqual-fix]
  affects: [all-tool-handlers, auth-handler]
tech_stack:
  added: []
  patterns: [zod-max-trim, constant-time-comparison, form-field-validation]
key_files:
  modified:
    - src/index.ts
decisions:
  - "max() before trim() in Zod chains — validates raw untrimmed size for security, then trims for cleanliness"
  - "Pad both buffers to equal length in timingSafeEqual so crypto.subtle.timingSafeEqual always runs at constant time"
  - "Length check placed after constant-time compare to prevent timing oracle on PIN length"
  - "256-char cap on form fields placed before KV lookup to avoid unnecessary KV calls on abuse"
metrics:
  duration: "~10 minutes"
  completed: "2026-04-12T23:54:22Z"
  tasks_completed: 2
  files_modified: 1
---

# Phase 01 Plan 03: Input Size Caps, Auth Validation, and Timing Fix Summary

Zod `.max(N).trim()` size caps added to all 11 tool string parameters (19 total constraints), auth form POST hardened with type/emptiness/size guards eliminating unsafe `as string` casts, and `timingSafeEqual` rewritten with buffer-padding to eliminate PIN length timing side-channel.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Add .max(N).trim() size caps to all tool input schemas | 708dbb0 | src/index.ts |
| 2 | Validate auth form fields and fix timingSafeEqual length leak | 5163fa3 | src/index.ts |

## What Was Built

### Task 1: Zod Size Caps (SEC-02)

Applied `.max(N).trim()` to every `z.string()` in tool `inputSchema` blocks — 19 constraints across 11 tools:

| Parameter | Tool(s) | Cap |
|-----------|---------|-----|
| `code` | reviewCode, transformCode, scaffoldTests, explainCode, generateDocs, generateTypes, fixBug | 100,000 |
| `context` | generateCode | 50,000 |
| `diff` | generateCommitMessage | 50,000 |
| `prompt` | generateCode | 20,000 |
| `instruction` | quickTask, transformCode | 10,000 |
| `error` | fixBug | 10,000 |
| `description` | generateWorkerBoilerplate | 10,000 |
| `criteria` | reviewCode | 2,000 |
| `bindings` | generateWorkerBoilerplate | 500 |
| `language` | generateCode | 100 |
| `style` | generateCode | 100 |
| `framework` | scaffoldTests | 100 |

Zod validates and rejects oversized payloads before any `runAI()` call — Workers AI never sees inputs exceeding these limits.

### Task 2: Auth Form Validation (HARD-03) + timingSafeEqual Fix

**Auth form validation:** Replaced unsafe `formData.get("secret") as string` and `formData.get("csrf") as string` casts with explicit guards:
- `typeof secret !== "string"` — rejects null (missing field) and File objects
- `!secret.trim()` — rejects empty/whitespace-only strings
- `secret.length > 256` / `csrfToken.length > 256` — size cap before KV lookup
- Returns `400 Invalid form data.` on any failure

**timingSafeEqual fix:** Eliminated PIN length timing side-channel. Old code returned `false` immediately on buffer length mismatch — response time varied with input length, leaking exact PIN byte-length. New implementation:
1. Pads both buffers to `Math.max(lenA, lenB)` with zero bytes
2. Always runs `crypto.subtle.timingSafeEqual` on equal-length buffers
3. Length equality check performed *after* the constant-time compare (no early return)

## Deviations from Plan

None — plan executed exactly as written.

## Verification Results

- `npx tsc --noEmit` — no errors in `src/index.ts` (test file errors are vitest dependency, installed by plan 01-04)
- `.max(` count: 20 occurrences (requirement: 17+)
- `.max(100_000).trim()` count: 7 (reviewCode, transformCode, scaffoldTests, explainCode, generateDocs, generateTypes, fixBug)
- No `formData.get("secret") as string` in source
- No `bufA.byteLength !== bufB.byteLength` early return in source
- `Math.max(bufA.byteLength, bufB.byteLength)` present
- `paddedA.set(bufA)` and `paddedB.set(bufB)` present
- `bufA.byteLength === bufB.byteLength` check after `timingSafeEqual` call

## Self-Check: PASSED

Files exist:
- src/index.ts — FOUND

Commits exist:
- 708dbb0 — feat(01-03): add .max(N).trim() size caps to all tool input schemas
- 5163fa3 — fix(01-03): validate auth form fields and fix timingSafeEqual length leak
