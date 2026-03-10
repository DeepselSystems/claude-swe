# CLAUDE.md

<!-- Check for `CLAUDE.local.md` in the repo root — if it exists, read it.  -->

## Architecture

This is a **Trello/Slack-to-PR automation system**. When you assign a bot account to a Trello card (or mention the bot in Slack), the system spins up an isolated Docker container (or Kubernetes Job) running Claude Code, which codes the solution, opens a PR, and moves the card to Done.

### Orchestrator (Node.js / Express)

The main process (`src/index.ts`) is a thin webhook server + BullMQ job processor. It does **not** run Claude Code directly — it only manages containers and queues.

**Request flow:**
1. Trello webhook (`POST /webhooks/trello`) → `src/webhook/handler.ts` verifies HMAC-SHA1 signature and routes by action type:
   - `addMemberToCard` (bot assigned) → enqueues `new-task` job
   - `removeMemberFromCard` (bot removed) → enqueues `cancel` job
   - `commentCard` (human comment) → Haiku guard (`src/agent/guard.ts`) classifies comment → operational commands executed inline, feedback enqueues `feedback` job, chatter ignored
   - `updateCard` (card archived, i.e. `closed=true`) → enqueues `cleanup` job with `reason: 'archived'`
2. GitHub webhook (`POST /webhooks/github`) → verifies HMAC-SHA256; on `pull_request closed` for `claude/*` branches → enqueues `cleanup` job
3. Slack Socket Mode (`src/slack/handler.ts`) — `app_mention` events:
   - Top-level mention → resolves repos (message GitHub URLs > linked Trello card > per-channel config > ask user), enqueues `new-task` job
   - Threaded reply → guard classifies → feedback/operation/ignore (same as Trello comments)
4. BullMQ worker (`src/queue/worker.ts`) dequeues jobs and calls `containers/manager.ts`

### Container Backend

`src/containers/manager.ts` selects the backend (Docker or Kubernetes) from config and delegates to:
- `src/containers/docker.ts` — Docker via dockerode. Containers are named `claude-swe-<cardShortLink>` with volumes `claude-swe-vol-<cardShortLink>`. For feedback jobs, the existing stopped container is reused (prompt injected via tar archive + `putArchive`).
- `src/containers/kubernetes.ts` — Kubernetes Jobs + PVCs.

`cardShortLink` is a generic task identifier: Trello tasks use the Trello card short link (e.g. `abc123`); Slack tasks use an `s-`-prefixed ID (e.g. `s-k7m2x9p1`). No container or Kubernetes changes are needed to support both.

Worker containers run `worker-entrypoint.sh`, which:
1. Detects feedback fast-path (if `/workspace/.feedback-prompt` exists, skips setup)
2. Writes MCP config to `~/.claude.json` — includes `@delorenj/mcp-server-trello` only if `TRELLO_API_KEY`/`TRELLO_TOKEN` are set (Slack-only tasks may not need it); always includes Playwright
3. Downloads card images to `/workspace/.card-images/` via `scripts/download-images.mjs`
4. Runs Claude Code in two-phase mode (Opus plans → writes `/workspace/.plan.md` → Sonnet executes) for Trello tasks, or single-phase for Slack tasks

### Configuration

`src/config.ts` reads `config.json`, recursively resolves `"env.KEY"` string values from environment variables, and validates with Zod. At startup, `resolveNames()` converts human-readable board/list names to Trello IDs via the API.

Config file: `config.json` (copy from `config.example.json`). Secrets: `.env`.

Key config fields: `agent.planMode` (two-phase vs single-phase), `agent.models.{plan,execute,guard}`, `agent.prompts.*` (extra instructions appended to built-in prompts), `containers.backend` (`docker`|`kubernetes`), `containers.concurrency`.

Slack config: `slack.botToken` (`xoxb-...`), `slack.appToken` (`xapp-...`), `slack.signingSecret`, `slack.channels` (map of channel ID → `{ repos: string[] }` for per-channel default repos).

### Agent Prompts

`src/agent/prompt.ts` builds the prompts passed to Claude Code in worker containers:
- `buildPlanPrompt` — instructs Claude to write `/workspace/.plan.md` without implementing code
- `buildExecutePrompt` — instructs Claude to implement from the plan
- `buildNewTaskPrompt` — single-phase (plan + execute in one pass) for Trello tasks
- `buildFeedbackPrompt` — handle reviewer comment on existing PR branch (Trello)
- `buildSlackNewTaskPrompt` — like `buildNewTaskPrompt` but embeds task description directly (no "read Trello card" step); optionally references a linked Trello card
- `buildSlackFeedbackPrompt` — Slack-oriented feedback prompt; omits Trello-specific instructions

`src/agent/guard.ts` — Haiku-based classifier for feedback jobs. Before spinning up a container, calls the Anthropic API with the comment text and classifies it into three categories: `ignore` (human-to-human chatter, silently skipped), `feedback` (directed at the agent → spin up container), or `operation` (administrative command → execute inline). Fails open (processes as feedback) on API error.

`src/agent/operations.ts` — Executes operational commands detected by the guard without spinning up a container. Supported operations: `stop` (kill worker + clean up), `move` (move card to named list — Trello only; no-op for Slack tasks), `restart` (stop + re-enqueue as fresh new-task), `archive` (archive card — Trello only; falls through to `stop` for Slack tasks). Uses `postStatus` for confirmations so replies go to the correct platform.

`src/notify.ts` — Status dispatcher. `postStatus(source, message)` routes status updates to the correct platform: `postTrelloComment` for Trello sources, `postSlackReply` for Slack sources. If a Slack task has `trelloCardId` set, posts to both platforms.

`src/slack/client.ts` — Bolt app initialization and helpers. `startSlack()` conditionally starts if credentials are configured. `postSlackReply(channelId, threadTs, text)` wraps `chat.postMessage`.

`src/slack/handler.ts` — Core Slack event handling. Registers `app_mention` listener. Handles top-level mentions (new tasks) and threaded replies (feedback/operations). Resolves repos via priority chain: message GitHub URLs > linked Trello card board repos > per-channel config > ask user.

`src/slack/id.ts` — Slack task ID generation (`s-<8 base36 chars>`) and Redis-backed thread mapping (7-day TTL). Maps `channelId:threadTs → taskId` and vice versa.

`src/slack/files.ts` — Downloads Slack file attachments to a local directory using bot token auth.

Custom instructions from `config.json` are appended to each prompt type via `agent.prompts.*`.

### Live Logs

When a task starts, a UUID-token log session is created (`src/logs/store.ts`) and a link is posted to the Trello card. The `/logs/:token` endpoint serves an HTML viewer; `/logs/:token/stream` is SSE streaming the container's stdout/stderr in real time.

### Job Types

All job types carry an optional `source: TaskSource` discriminated union (`{ type: 'trello'; cardId }` or `{ type: 'slack'; channelId; threadTs; trelloCardId? }`). Jobs without a `source` field default to Trello (backward compat). `getTaskSource(job)` resolves the effective source.

- `new-task` — new task from Trello (card assigned) or Slack (bot mentioned); 3 attempts with exponential backoff. Slack tasks include pre-resolved `repos[]` and `taskDescription`; Trello tasks resolve repos from `boardId` at runtime.
- `feedback` — human comment on card/thread; passes Haiku guard first (non-agent comments skipped); if a feedback container is already running for that task, it is killed immediately and the new comment takes over — always works on the latest feedback
- `cleanup` — PR closed/merged or card archived; destroy container + volume (for `reason: 'archived'`, also drains pending jobs immediately without checking open PRs)
- `cancel` — bot removed from card mid-flight; drain pending jobs, kill container, post comment

Branch naming: all Claude branches are `claude/<cardShortLink>`.

## Local Overrides

It contains private, machine-specific instructions (tools available, deployment targets, etc.) that are not checked in.

## Key Conventions

- TypeScript strict mode, NodeNext module resolution — use `.js` extensions in imports
- Pino structured logging via `src/logger.ts`; always use child loggers with `phase` field
- Config values that may be null (credentials not configured) are `string | null` — check before use
- Tests in `test/` (Vitest); tsconfig excludes `test/` from the main build
- Trello IDs are 24-character hex strings; `isId()` in `config.ts` distinguishes them from names