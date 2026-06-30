#!/usr/bin/env bash
# measure-session.sh — pull decision metrics from a Claude Code session transcript.
#
# The transcripts at ~/.claude/projects/<proj>/<session>.jsonl record exact per-turn token
# usage, every tool call, and timestamps — a precise, scriptable source of truth (better than
# eyeballing /cost). Run ONE task per fresh session, then run this on that session's file.
#
# Usage:
#   .planning/bench/measure-session.sh                 # newest transcript for THIS repo
#   .planning/bench/measure-session.sh <session.jsonl> # a specific session
#
# Captures: output/input tokens by model (Opus main-loop vs Haiku sidechain), tool-call tally
# (adoption signal), summed subagent_tokens (Haiku arm), and wall-clock.

set -euo pipefail

# Default: newest transcript across ALL projects — so "run one task in a fresh session, then
# measure" works from any project. Pass an explicit path to override.
F="${1:-$(ls -t "$HOME"/.claude/projects/*/*.jsonl 2>/dev/null | head -1)}"
[ -f "$F" ] || { echo "no transcript found: ${F:-<none>}"; exit 1; }
echo "Session: $F"

echo
echo "== tokens by model (assistant turns) =="
jq -rc 'select(.type=="assistant") | (.message // .) as $m
        | "\($m.model // "?")\t\($m.usage.output_tokens // 0)\t\($m.usage.input_tokens // 0)\t\($m.usage.cache_read_input_tokens // 0)\t\($m.usage.cache_creation_input_tokens // 0)"' "$F" \
| awk -F'\t' '{o[$1]+=$2; i[$1]+=$3; r[$1]+=$4; c[$1]+=$5}
  END{printf "%-24s %10s %10s %11s %12s\n","model","output","input","cache_read","cache_create";
      for(m in o) printf "%-24s %10d %10d %11d %12d\n", m, o[m], i[m], r[m], c[m]}'
echo "(output tokens are the $ driver and the cleanest cross-arm comparator)"

echo
echo "== tool calls (adoption signal) =="
jq -rc 'select(.type=="assistant") | (.message.content // [])[] | select(.type=="tool_use") | .name' "$F" \
  | sort | uniq -c | sort -rn

echo
echo "== subagent_tokens total (Haiku-arm cheap-side cost) =="
grep -o '"subagent_tokens":[0-9]*' "$F" 2>/dev/null | awk -F: '{s+=$2} END{print (s?s:0)" tokens"}'

echo
echo "== wall clock =="
ts=$(jq -rc 'select(.timestamp) | .timestamp' "$F")
first=$(printf '%s\n' "$ts" | head -1); last=$(printf '%s\n' "$ts" | tail -1)
echo "first: $first"
echo "last:  $last"
python3 - "$first" "$last" <<'PY' 2>/dev/null || true
import sys,datetime as d
a,b=(d.datetime.fromisoformat(x.replace("Z","+00:00")) for x in sys.argv[1:3])
print(f"elapsed: {(b-a).total_seconds():.0f} s")
PY

echo
echo "NOTE: cheap-tier tokens for the MCP path are NOT in the transcript (they run on Cloudflare)."
echo "      Capture them with:  npx wrangler tail --format pretty   (grep 'tool_invocation')"
