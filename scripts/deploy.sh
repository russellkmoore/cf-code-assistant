#!/usr/bin/env bash
set -euo pipefail

WRANGLER="npx wrangler"
KV_BINDING="OAUTH_KV"
TOML="wrangler.toml"
PLACEHOLDER="REPLACE_WITH_YOUR_KV_NAMESPACE_ID"

# Check if wrangler.toml has a real KV ID or still has the placeholder
CURRENT_ID=$(grep -A2 "binding = \"$KV_BINDING\"" "$TOML" | grep '^id' | sed 's/.*= *"//' | sed 's/".*//')

if [ "$CURRENT_ID" = "$PLACEHOLDER" ] || [ -z "$CURRENT_ID" ]; then
  echo "KV namespace ID not configured. Checking for existing namespace..."

  # Look for an existing namespace matching our binding name
  EXISTING=$($WRANGLER kv namespace list 2>/dev/null | node -e "
    let data = '';
    process.stdin.on('data', c => data += c);
    process.stdin.on('end', () => {
      try {
        const ns = JSON.parse(data).find(n => n.title.includes('$KV_BINDING'));
        if (ns) console.log(ns.id);
      } catch {}
    });
  ")

  if [ -n "$EXISTING" ]; then
    echo "Found existing KV namespace: $EXISTING"
    KV_ID="$EXISTING"
  else
    echo "Creating KV namespace '$KV_BINDING'..."
    CREATE_OUTPUT=$($WRANGLER kv namespace create "$KV_BINDING" 2>&1)
    echo "$CREATE_OUTPUT"

    # Extract the ID from create output
    KV_ID=$(echo "$CREATE_OUTPUT" | grep -o '"[a-f0-9]\{32\}"' | tr -d '"' | head -1)

    if [ -z "$KV_ID" ]; then
      echo "Error: Failed to extract KV namespace ID from create output."
      exit 1
    fi
    echo "Created KV namespace: $KV_ID"
  fi

  # Update wrangler.toml with the real ID
  sed -i.bak "s/$PLACEHOLDER/$KV_ID/" "$TOML"
  rm -f "$TOML.bak"
  echo "Updated $TOML with KV namespace ID: $KV_ID"
else
  echo "KV namespace already configured: $CURRENT_ID"
fi

# Check MCP_SECRET is set
if ! $WRANGLER secret list 2>/dev/null | grep -q "MCP_SECRET"; then
  echo ""
  echo "Warning: MCP_SECRET not set. Run:"
  echo "  npx wrangler secret put MCP_SECRET"
fi

# Deploy
echo ""
echo "Deploying..."
$WRANGLER deploy
