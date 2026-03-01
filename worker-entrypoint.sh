#!/bin/bash
set -euo pipefail

# Activate mise so runtime shims work
eval "$(/root/.local/bin/mise activate bash)" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Feedback fast-path: if the orchestrator wrote a prompt file to the workspace
# (Docker: via putArchive into stopped container; K8s: via init container),
# skip all setup and run claude directly with that prompt.
# ---------------------------------------------------------------------------
if [ -f /workspace/.feedback-prompt ]; then
  PROMPT="$(cat /workspace/.feedback-prompt)"
  rm /workspace/.feedback-prompt

  # Pull latest changes in each repo so feedback sees any commits pushed since the last run
  git config --global --add safe.directory /workspace
  echo "${GITHUB_TOKEN}" | gh auth login --with-token 2>/dev/null || true
  for repo_dir in /workspace/*/; do
    if [ -d "${repo_dir}.git" ]; then
      echo "Pulling latest changes in ${repo_dir}"
      git -C "$repo_dir" pull --rebase --autostash 2>&1 || echo "Warning: git pull failed in ${repo_dir} — continuing"
    fi
  done

  # Always write fresh MCP settings (don't rely on PVC state from a prior run)
  mkdir -p /workspace/.claude
  cat > /workspace/.claude/settings.local.json <<MCPEOF
{
  "mcpServers": {
    "trello": {
      "command": "npx",
      "args": ["-y", "@delorenj/mcp-server-trello"],
      "env": {
        "TRELLO_API_KEY": "${TRELLO_API_KEY}",
        "TRELLO_TOKEN": "${TRELLO_TOKEN}"
      }
    },
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest", "--headless"]
    }
  }
}
MCPEOF
  chown -R worker:worker /workspace

  cd /workspace
  gosu worker claude \
    --output-format stream-json \
    --verbose \
    --model "${CLAUDE_EXECUTE_MODEL:-sonnet}" \
    --dangerously-skip-permissions \
    "$PROMPT" \
    | node /opt/mcp/worker-logger.js
  exit ${PIPESTATUS[0]}
fi

# Write .claude/settings.local.json with MCP server configs
mkdir -p /workspace/.claude
cat > /workspace/.claude/settings.local.json <<MCPEOF
{
  "mcpServers": {
    "trello": {
      "command": "npx",
      "args": ["-y", "@delorenj/mcp-server-trello"],
      "env": {
        "TRELLO_API_KEY": "${TRELLO_API_KEY}",
        "TRELLO_TOKEN": "${TRELLO_TOKEN}"
      }
    },
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest", "--headless"]
    }
  }
}
MCPEOF

# Download card images for visual reference
IMAGE_DIR="/workspace/.card-images"
mkdir -p "$IMAGE_DIR"
node /opt/mcp/download-images.mjs "${CARD_ID}" "$IMAGE_DIR" \
  || echo "Warning: image download failed or no images found — continuing"

# Configure git
git config --global user.name "Claude SWE"
git config --global user.email "claude-swe@noreply.example.com"
git config --global --add safe.directory /workspace

# Auth gh CLI
echo "${GITHUB_TOKEN}" | gh auth login --with-token 2>/dev/null || true

# Ensure worker user owns the workspace (PVC may be root-owned on first mount)
chown -R worker:worker /workspace

cd /workspace

if [ -n "${CLAUDE_PLAN_PROMPT:-}" ]; then
  # Two-phase: Opus plans, Sonnet executes (new tasks)
  echo "=== Phase 1: Planning with ${CLAUDE_PLAN_MODEL:-opus} ==="
  gosu worker claude \
    --output-format stream-json \
    --verbose \
    --model "${CLAUDE_PLAN_MODEL:-opus}" \
    --dangerously-skip-permissions \
    "${CLAUDE_PLAN_PROMPT}" \
    | node /opt/mcp/worker-logger.js
  # Capture claude's exit code (left side of pipe), not the logger's
  PLAN_EXIT=${PIPESTATUS[0]}
  if [ "$PLAN_EXIT" -ne 0 ]; then exit "$PLAN_EXIT"; fi

  if [ ! -f /workspace/.plan.md ]; then
    echo "ERROR: Planning phase did not produce /workspace/.plan.md — aborting" >&2
    exit 1
  fi

  echo "=== Phase 2: Executing with ${CLAUDE_EXECUTE_MODEL:-sonnet} ==="
  gosu worker claude \
    --output-format stream-json \
    --verbose \
    --model "${CLAUDE_EXECUTE_MODEL:-sonnet}" \
    --dangerously-skip-permissions \
    "${CLAUDE_EXECUTE_PROMPT}" \
    | node /opt/mcp/worker-logger.js
  exit ${PIPESTATUS[0]}
else
  # Single-phase: execute model only (feedback jobs or planMode=false)
  gosu worker claude \
    --output-format stream-json \
    --verbose \
    --model "${CLAUDE_EXECUTE_MODEL:-sonnet}" \
    --dangerously-skip-permissions \
    "${CLAUDE_PROMPT}" \
    | node /opt/mcp/worker-logger.js
  exit ${PIPESTATUS[0]}
fi
