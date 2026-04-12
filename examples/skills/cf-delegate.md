---
name: cf-delegate
description: >
  Delegate a code generation task to the cf-code-assistant MCP server.
  Use when the user asks to generate, scaffold, transform, or document
  code and the task is self-contained enough to be described precisely.
  Always fetch relevant context before delegating.
disable-model-invocation: false
allowed-tools: mcp__cf-code-assistant__*
---

# cf-delegate workflow

Follow these steps exactly when delegating to cf-code-assistant:

## Step 1: Classify the task
Determine which tool applies:
- New code from description → generateCode
- Tests for existing code → scaffoldTests
- JSDoc/TSDoc → generateDocs
- Type inference → generateTypes
- Mechanical transform → transformCode
- Bug with error message → fixBug
- Commit message from diff → generateCommitMessage
- Worker boilerplate → generateWorkerBoilerplate
- Anything else self-contained → quickTask

## Step 2: Gather context
Before calling any tool, collect what qwen3 will need.
qwen3 has no MCP access — you are its only source of truth.

- If the task involves a Cloudflare API → fetch current docs via
  Cloudflare MCP first
- If the task involves a library → resolve via Context7 first
- If the task involves existing code → read the relevant files
- If the task is purely mechanical (transform, types, docs) →
  the code itself is sufficient context, proceed directly

## Step 3: Build the prompt
Be precise. qwen3 does not ask clarifying questions.
Include:
- What to build / what to do
- Any fetched docs or API references (paste inline as context param)
- Language, framework, style constraints
- What NOT to do if there are gotchas

## Step 4: Call the tool
Pass the assembled context. Do not summarize docs — pass them.
Summarizing loses the API accuracy that makes this pattern work.

## Step 5: Review and integrate
You review the output. Check for:
- Correct API usage against the context you provided
- Consistency with project conventions in CLAUDE.md
- Any integration points that need wiring into existing code

Do not pass qwen3 output directly to the user without review.
You are the quality gate.
