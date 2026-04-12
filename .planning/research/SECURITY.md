# Security Research: Cloudflare Workers MCP Server

**Project:** cf-code-assistant
**Researched:** 2026-04-12
**Scope:** Hardening patterns for a PIN-auth + OAuth 2.1 MCP server on Cloudflare Workers

---

## 1. Rate Limiting on Workers (Without External Services)

### The Options Ranked

**Option A — Native Workers Rate Limiting Binding (RECOMMENDED)**
Cloudflare added a first-party Rate Limiting API (requires Wrangler ≥ 4.36.0). It is the correct choice for this project.

- Counters are cached on the same machine the Worker runs on, updated asynchronously to a backing store in the same Cloudflare location — adds no meaningful latency.
- Configured entirely in `wrangler.toml`. No external service, no Durable Objects cost.
- Limitation: per-Cloudflare-location, not globally consistent. For a single-user personal server this is irrelevant.
- Period must be 10 or 60 seconds. Limit is a request count.

```toml
# wrangler.toml additions
[[unsafe.bindings]]
name = "RATE_LIMITER_TOOLS"
type = "ratelimit"
namespace_id = "1001"
simple = { limit = 100, period = 60 }

[[unsafe.bindings]]
name = "RATE_LIMITER_AUTH"
type = "ratelimit"
namespace_id = "1002"
simple = { limit = 5, period = 60 }
```

```typescript
// In Env interface
interface Env {
  AI: Ai;
  OAUTH_KV: KVNamespace;
  MCP_SECRET: string;
  RATE_LIMITER_TOOLS: RateLimit;
  RATE_LIMITER_AUTH: RateLimit;
}

// Usage pattern — apply before any work is done
async function checkRateLimit(limiter: RateLimit, key: string): Promise<Response | null> {
  const { success } = await limiter.limit({ key });
  if (!success) {
    return new Response(JSON.stringify({ error: "Rate limit exceeded" }), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": "60",
      },
    });
  }
  return null;
}

// In authHandler POST /authorize — use clientId or IP as key
const rateLimitResponse = await checkRateLimit(env.RATE_LIMITER_AUTH, "auth");
if (rateLimitResponse) return rateLimitResponse;

// In MCP tool handlers — use "tools" as key (single user, no per-user needed)
const rateLimitResponse = await checkRateLimit(env.RATE_LIMITER_TOOLS, "tools");
if (rateLimitResponse) return rateLimitResponse;
```

**Option B — KV Sliding Window (fallback if native binding unavailable)**
KV has a 1-write-per-second-per-key limit and is eventually consistent across PoPs (up to 60s propagation lag). For a personal server this is acceptable for tool calls but NOT reliable enough for brute-force auth protection.

```typescript
async function kvRateLimit(kv: KVNamespace, key: string, limit: number, windowSec: number): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const windowKey = `ratelimit:${key}:${Math.floor(now / windowSec)}`;
  const current = parseInt(await kv.get(windowKey) ?? "0", 10);
  if (current >= limit) return false;
  await kv.put(windowKey, String(current + 1), { expirationTtl: windowSec * 2 });
  return true;
}
```

**Confidence:** HIGH — native binding documented at developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/

---

## 2. Input Validation Patterns for MCP Tool Parameters

### Current State (from src/index.ts)

The codebase uses Zod schemas but without size constraints. Every tool that accepts `code`, `context`, `diff`, or `prompt` passes unbounded strings directly to Workers AI — a vector for both abuse and cost explosion.

### Recommended Caps

These are defensible limits for a code assistant use case:

| Parameter | Current | Recommended Cap | Rationale |
|-----------|---------|-----------------|-----------|
| `prompt` | unbounded | 8,000 chars | Generous for any realistic prompt |
| `code` | unbounded | 50,000 chars | ~1,200 LOC — covers real files |
| `context` | unbounded | 100,000 chars | Large enough for docs + snippets |
| `diff` | unbounded | 50,000 chars | Large diffs |
| `error` | unbounded | 5,000 chars | Stack traces are bounded |
| `instruction` | unbounded | 2,000 chars | Short directive |
| `language`/`style`/`framework` | unbounded | 50 chars | Should be a keyword, not prose |
| `bindings` | unbounded | 200 chars | Comma-separated short names |

### Zod Schema Pattern

```typescript
// Replace unbounded z.string() with constrained versions in each tool's inputSchema:

const CODE_SCHEMA = z.string().max(50_000, "Code must be under 50,000 characters");
const CONTEXT_SCHEMA = z.string().max(100_000, "Context must be under 100,000 characters").optional();
const PROMPT_SCHEMA = z.string().min(1).max(8_000, "Prompt must be under 8,000 characters");
const SHORT_STRING = z.string().max(50);
const ERROR_SCHEMA = z.string().max(5_000);
const INSTRUCTION_SCHEMA = z.string().min(1).max(2_000);

// generateCode becomes:
inputSchema: {
  prompt: PROMPT_SCHEMA.describe("What code to generate"),
  context: CONTEXT_SCHEMA.describe("Relevant docs, API references, or existing code gathered by Claude"),
  language: SHORT_STRING.optional().describe("Target language (e.g. typescript, python, rust)"),
  style: SHORT_STRING.optional().describe("Style guidance (e.g. functional, class-based, minimal)"),
},
```

### URL/Path Injection (for future tools that accept paths or URLs)

If any tool ever accepts file paths or URLs:

```typescript
function validateUrl(raw: string): string {
  const url = new URL(raw); // throws on malformed
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only http and https URLs are permitted");
  }
  return url.toString();
}

function validatePath(raw: string, sandboxRoot: string): string {
  const resolved = path.resolve(sandboxRoot, raw);
  if (!resolved.startsWith(sandboxRoot)) {
    throw new Error("Path traversal detected");
  }
  return resolved;
}
```

### Sanitizing User-Controlled Content in HTML Responses

The `loginPage()` function does not currently interpolate user input, but future additions (error messages, client names) should escape HTML:

```typescript
function escapeHtml(unsafe: string): string {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
```

**Confidence:** HIGH — Zod constraint APIs are stable; limits are industry-standard heuristics.

---

## 3. CSRF Protection — Beyond the Current KV Token

### Current Implementation (Good)

The codebase already does the right things:
- CSRF token is a `crypto.randomUUID()` (cryptographically secure)
- Token stored in KV with 300-second TTL
- Token deleted on use (single-use)
- Token passed as hidden form field and validated before any auth action

### What Is Missing

**A. No `SameSite` cookie binding.** The CSRF token is stored in KV keyed by the token value, not tied to a session cookie. An attacker who can read the KV key out of the HTML (possible via XSS) can replay it. Adding a cookie-bound check adds defense-in-depth.

```typescript
// When issuing the CSRF token, also set a short-lived cookie:
const csrfCookie = crypto.randomUUID();
await env.OAUTH_KV.put(`csrf:${csrfToken}`, JSON.stringify({ authRequest, cookieNonce: csrfCookie }), {
  expirationTtl: 300,
});

const response = new Response(loginPage(csrfToken), {
  headers: {
    "Content-Type": "text/html",
    // __Host- prefix prevents subdomain override on *.workers.dev
    "Set-Cookie": `__Host-csrf-nonce=${csrfCookie}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=300`,
  },
});
return response;

// On POST, validate both the form token AND the cookie match:
const cookieHeader = request.headers.get("Cookie") ?? "";
const cookieNonce = parseCookieValue(cookieHeader, "__Host-csrf-nonce");
const stored = JSON.parse(await env.OAUTH_KV.get(`csrf:${csrfToken}`) ?? "null");

if (!stored || !cookieNonce || !timingSafeEqual(cookieNonce, stored.cookieNonce)) {
  return new Response("CSRF validation failed.", { status: 403 });
}
```

**B. `__Host-` cookie prefix.** The existing auth response does not set any cookies. If you add the nonce cookie above, use `__Host-` prefix — this requires `Secure`, `Path=/`, and no `Domain` attribute, preventing subdomain hijacking on `*.workers.dev` shared domains.

**C. Content Security Policy on the login page.** Currently the login page has no CSP header, leaving it open to XSS that could exfiltrate the CSRF token.

```typescript
const CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",  // needed for inline styles in loginPage
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

return new Response(loginPage(csrfToken), {
  headers: {
    "Content-Type": "text/html",
    "Content-Security-Policy": CSP,
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
  },
});
```

**Confidence:** HIGH for cookie prefix and CSP patterns — sourced from Cloudflare's own securing-mcp-server guide. MEDIUM for double-submit cookie pattern — standard practice, not Workers-specific.

---

## 4. OAuth Token Security — workers-oauth-provider Risks

### CVE-2025-4144 — PKCE Bypass (PATCHED)

A PKCE bypass (downgrade attack) was discovered and patched in `@cloudflare/workers-oauth-provider` version **0.0.5**. CVSS 5.3 (Moderate). The bug allowed skipping PKCE verification entirely.

**Action:** Verify your `package.json` pins `@cloudflare/workers-oauth-provider` at ≥ 0.0.5. If it is pinned to an older version, update immediately.

```bash
npm list @cloudflare/workers-oauth-provider
# Should show 0.0.5 or higher
```

### Token Storage Design (by the library)

The library stores token metadata in KV. The storage schema is designed so a full KV dump only reveals mundane metadata (what was granted, when), not the tokens themselves. This is correct — but it means:

- **KV namespace access = partial auth system exposure.** The `OAUTH_KV` namespace should not be shared with untrusted processes.
- **Token TTL is set to 86400 seconds (24 hours)** in the current code. For a personal single-user server this is reasonable, but consider whether you want shorter-lived tokens with refresh.

### Access Token TTL Consideration

```typescript
// Current: 24h access tokens
accessTokenTTL: 86400,

// For tighter security (requires more frequent re-auth):
accessTokenTTL: 3600, // 1 hour
```

The MCP spec and Claude Code handle token refresh transparently, so shorter TTL is safe to use.

### `MCP_SECRET` Handling

The current code compares `secret` from form data against `env.MCP_SECRET` using the custom `timingSafeEqual()`. This is correct. The two risks are:

1. **Length leak.** The current `timingSafeEqual` returns `false` immediately when lengths differ. This leaks the length of the secret. Fix:

```typescript
function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  // Compare against a fixed-length reference to avoid leaking secret length
  // Pad/hash both to 32 bytes before comparing
  const hashA = await crypto.subtle.digest("SHA-256", bufA);
  const hashB = await crypto.subtle.digest("SHA-256", bufB);
  return crypto.subtle.timingSafeEqual(hashA, hashB);
}

// Async version required in Worker context:
async function timingSafeEqualAsync(a: string, b: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(hashA, hashB);
}
```

2. **Secret quality.** `MCP_SECRET` should be at least 32 random characters. A short or guessable PIN defeats the timing-safe comparison entirely.

**Confidence:** HIGH for CVE — official GitHub advisory. HIGH for timing-safe hashing — WebCrypto API standard.

---

## 5. Error Message Sanitization

### Current State

The `runAI()` function re-throws errors from Workers AI without filtering. The `authHandler` returns raw strings like `"Session expired. Please try again."` and `"Invalid secret."` — these are acceptable. The risk is in unhandled or partially-handled errors that might surface internal state.

### Patterns to Apply

**A. Structured error response factory.** Never let a raw `Error` propagate to the response body:

```typescript
type ErrorCode = "rate_limited" | "invalid_input" | "auth_required" | "server_error" | "not_found";

function errorResponse(code: ErrorCode, status: number, detail?: string): Response {
  // Log the full detail internally but return a sanitized external message
  if (detail) {
    console.error(JSON.stringify({ event: "error", code, detail, ts: Date.now() }));
  }

  const PUBLIC_MESSAGES: Record<ErrorCode, string> = {
    rate_limited: "Too many requests. Please wait before retrying.",
    invalid_input: "Request validation failed.",
    auth_required: "Authentication required.",
    server_error: "An internal error occurred.",
    not_found: "Not found.",
  };

  return new Response(JSON.stringify({ error: PUBLIC_MESSAGES[code] }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
```

**B. Catch all thrown errors in tool handlers.** Workers AI errors currently propagate as unhandled rejections in the tool handler body. The MCP SDK may serialize these to the client:

```typescript
// Wrap every tool handler's AI call:
async ({ code }) => {
  try {
    const result = await runAI(env, "standard", buildPrompt(code), 4096);
    return { content: [{ type: "text", text: result }] };
  } catch (err) {
    console.error(JSON.stringify({
      event: "tool_error",
      tool: "reviewCode",
      message: err instanceof Error ? err.message : String(err),
      ts: Date.now(),
    }));
    // Return a safe MCP error rather than propagating the raw exception
    return {
      content: [{ type: "text", text: "Code review failed. Please retry." }],
      isError: true,
    };
  }
},
```

**C. Never log `env.MCP_SECRET` or token values.** Cloudflare Workers observability (when enabled) ships logs to Cloudflare's backend. Log event types, not secret values.

```typescript
// BAD
console.log(`Auth attempt with secret: ${secret}`);

// GOOD
console.log(JSON.stringify({ event: "auth_attempt", success: false, ts: Date.now() }));
```

**D. Do not expose stack traces.** Workers in production should strip stack traces from any response. The `passThroughOnException()` pattern (which Cloudflare warns against) would silently swallow errors. The explicit try/catch pattern above is correct.

**Confidence:** HIGH — Cloudflare best practices documentation explicitly addresses this.

---

## 6. Cloudflare Workers Security Headers

### Headers to Add to All Responses

The `/authorize` GET endpoint returns HTML without security headers. All responses should include:

```typescript
function addSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);

  // Prevent clickjacking
  headers.set("X-Frame-Options", "DENY");

  // Prevent MIME-type sniffing
  headers.set("X-Content-Type-Options", "nosniff");

  // Limit referrer information
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");

  // Disable legacy XSS auditor (modern browsers ignore it; setting 0 is correct)
  headers.set("X-XSS-Protection", "0");

  // Prevent cross-origin embedding
  headers.set("Cross-Origin-Resource-Policy", "same-origin");

  // HSTS — uncomment only after you have a stable custom domain
  // headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");

  // Permissions Policy — deny everything not needed
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
```

### Content Security Policy for the Login Page

As noted in section 3, the login page should have a CSP. The inline styles currently used require `'unsafe-inline'` for `style-src`. A stricter alternative is to move styles to a `<style>` element with a nonce, but for a personal tool `'unsafe-inline'` is acceptable.

### TLS Enforcement

Workers AI handles TLS termination, so you cannot enforce a minimum TLS version inside the Worker itself — this is handled at the Cloudflare edge level through your zone settings (minimum TLS 1.2 is the Cloudflare default).

**Confidence:** HIGH — directly from developers.cloudflare.com/workers/examples/security-headers/

---

## 7. Brute Force Protection for PIN Auth

### The Problem

The current `/authorize` POST handler has no lockout logic. An attacker who can reach the Worker can attempt unlimited PIN guesses. The current rate limiter recommendation (section 1) applies 5 attempts per 60 seconds — that is the first line of defense. The second line is progressive lockout in KV.

### V8 Isolate Constraint

Workers have no persistent in-memory state between requests. Each request may land in a different isolate. All lockout state must live in KV.

### KV-Based Progressive Lockout Pattern

```typescript
const AUTH_MAX_ATTEMPTS = 5;
const AUTH_LOCKOUT_SECONDS = 900; // 15 minutes after 5 failures

async function checkAuthLockout(kv: KVNamespace, identifier: string): Promise<Response | null> {
  const lockKey = `auth:lock:${identifier}`;
  const attemptsKey = `auth:attempts:${identifier}`;

  // Check if locked out
  const locked = await kv.get(lockKey);
  if (locked) {
    const lockedAt = parseInt(locked, 10);
    const remaining = AUTH_LOCKOUT_SECONDS - Math.floor((Date.now() / 1000) - lockedAt);
    return new Response("Too many failed attempts. Try again later.", {
      status: 429,
      headers: { "Retry-After": String(Math.max(0, remaining)) },
    });
  }

  return null;
}

async function recordAuthFailure(kv: KVNamespace, identifier: string): Promise<void> {
  const attemptsKey = `auth:attempts:${identifier}`;
  const lockKey = `auth:lock:${identifier}`;

  const raw = await kv.get(attemptsKey);
  const attempts = raw ? parseInt(raw, 10) + 1 : 1;

  if (attempts >= AUTH_MAX_ATTEMPTS) {
    // Lock out the identifier
    await kv.put(lockKey, String(Math.floor(Date.now() / 1000)), {
      expirationTtl: AUTH_LOCKOUT_SECONDS,
    });
    await kv.delete(attemptsKey);
  } else {
    // Increment attempt counter; expires after lockout window to auto-clean
    await kv.put(attemptsKey, String(attempts), {
      expirationTtl: AUTH_LOCKOUT_SECONDS,
    });
  }
}

async function clearAuthFailures(kv: KVNamespace, identifier: string): Promise<void> {
  await kv.delete(`auth:attempts:${identifier}`);
  await kv.delete(`auth:lock:${identifier}`);
}
```

### What to Use as the Identifier

For a single-user personal server, use a static key like `"auth:global"` — since there is only one valid user, you are protecting against external attackers, not differentiating between users. Using IP is unreliable due to Cloudflare's network topology.

### Integration in authHandler

```typescript
if (request.method === "POST") {
  // 1. Check lockout first (before consuming form data)
  const lockoutResponse = await checkAuthLockout(env.OAUTH_KV, "auth:global");
  if (lockoutResponse) return lockoutResponse;

  const formData = await request.formData();
  const secret = formData.get("secret") as string;
  const csrfToken = formData.get("csrf") as string;

  const stored = await env.OAUTH_KV.get(`csrf:${csrfToken}`);
  if (!stored) {
    return new Response("Session expired. Please try again.", { status: 400 });
  }
  await env.OAUTH_KV.delete(`csrf:${csrfToken}`);

  if (!secret || !(await timingSafeEqualAsync(secret, env.MCP_SECRET))) {
    // 2. Record failure — do NOT indicate whether CSRF or PIN was wrong
    await recordAuthFailure(env.OAUTH_KV, "auth:global");
    return new Response("Invalid credentials.", { status: 403 });
  }

  // 3. Clear failure counter on success
  await clearAuthFailures(env.OAUTH_KV, "auth:global");

  const authRequest = JSON.parse(stored) as AuthRequest;
  // ... complete authorization
}
```

**Important:** Always return the same error message whether the failure is a bad CSRF token or a bad PIN. Different messages enumerate which validation failed, helping an attacker.

### KV Consistency Caveat

KV writes have eventual consistency across PoPs (up to 60 seconds). For a single-user server accessed from one location this is fine. The KV 1-write-per-second-per-key limit is not a concern for auth lockout (auth attempts are inherently low-frequency from a single user's location).

**Confidence:** MEDIUM — the KV lockout pattern is a community standard, not officially documented by Cloudflare for this specific use case. The approach is sound given the stateless Worker constraint.

---

## Summary of Current Code Gaps (src/index.ts)

| Gap | Location | Severity | Fix Reference |
|-----|----------|----------|---------------|
| No input size limits on tool parameters | All tool `inputSchema` definitions | Medium | Section 2 |
| No rate limiting on tool calls | MCP handler entry point | Medium | Section 1 |
| No rate limiting on auth attempts | `authHandler` POST | High | Sections 1 + 7 |
| No brute-force lockout | `authHandler` POST | High | Section 7 |
| `timingSafeEqual` leaks secret length | `timingSafeEqual()` function | Low | Section 4 |
| No security headers on auth responses | `authHandler` GET return | Medium | Section 6 |
| No CSP on login page | `loginPage()` HTML template | Medium | Sections 3 + 6 |
| Raw errors may surface in tool responses | All `runAI()` call sites | Medium | Section 5 |
| No structured error logging | All error paths | Low | Section 5 |
| `workers-oauth-provider` version unverified | `package.json` | High | Section 4 |

---

## Sources

- [Cloudflare Workers Rate Limiting API](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/) — native binding docs (HIGH confidence)
- [Cloudflare Workers Security Headers](https://developers.cloudflare.com/workers/examples/security-headers/) — header recommendations (HIGH confidence)
- [Cloudflare Workers Best Practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/) — secrets, timing attacks, error handling (HIGH confidence)
- [Securing MCP Servers — Cloudflare Agents](https://developers.cloudflare.com/agents/guides/securing-mcp-server/) — CSRF, cookies, CSP for MCP (HIGH confidence)
- [CVE-2025-4144 / GHSA-qgp8-v765-qxx9](https://github.com/cloudflare/workers-oauth-provider/security/advisories/GHSA-qgp8-v765-qxx9) — PKCE bypass advisory, patched in 0.0.5 (HIGH confidence)
- [workers-oauth-provider GitHub](https://github.com/cloudflare/workers-oauth-provider) — token storage design (HIGH confidence)
- [MCP Security Best Practices — Microsoft](https://github.com/microsoft/mcp-for-beginners/blob/main/02-Security/mcp-best-practices.md) — input validation, injection prevention (MEDIUM confidence)
- [Cloudflare Workers Security Model](https://developers.cloudflare.com/workers/reference/security-model/) — V8 isolate guarantees and limitations (HIGH confidence)
- [MCP Command Injection Attack Vector — Keysight](https://www.keysight.com/blogs/en/tech/nwvs/2026/01/12/mcp-command-injection-new-attack-vector) — confused deputy attack pattern (MEDIUM confidence)
- [Security Considerations for MCP Servers — Grizzly Peak](https://www.grizzlypeaksoftware.com/library/security-considerations-for-mcp-servers-q30qi665) — Zod schemas, parameterized queries, path traversal (MEDIUM confidence)
