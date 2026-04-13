// --- Structured logging for Cloudflare Workers tail logs ---
// Each function outputs a single JSON.stringify call so Cloudflare parses it as structured.
// No prompt content, secrets, or stack traces are ever logged (T-04-01, T-04-02, T-04-03).

export interface ToolInvocationLog {
  category: "tool_invocation";
  timestamp: string;
  tool: string;
  tier: string;
  model: string;
  latency_ms: number;
}

export interface ToolErrorLog {
  category: "tool_error";
  timestamp: string;
  tool: string;
  error_type: string;
  input_size_bytes: number;
}

export interface AuthEventLog {
  category: "auth_event";
  timestamp: string;
  event: "attempt" | "success" | "failure" | "rate_limit";
  ip: string;
  detail?: string;
}

export function logToolInvocation(data: Omit<ToolInvocationLog, "category" | "timestamp">): void {
  const entry: ToolInvocationLog = { category: "tool_invocation", timestamp: new Date().toISOString(), ...data };
  console.log(JSON.stringify(entry));
}

export function logToolError(data: Omit<ToolErrorLog, "category" | "timestamp">): void {
  const entry: ToolErrorLog = { category: "tool_error", timestamp: new Date().toISOString(), ...data };
  console.error(JSON.stringify(entry));
}

export function logAuthEvent(data: Omit<AuthEventLog, "category" | "timestamp">): void {
  const entry: AuthEventLog = { category: "auth_event", timestamp: new Date().toISOString(), ...data };
  if (data.event === "failure" || data.event === "rate_limit") {
    console.error(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}
