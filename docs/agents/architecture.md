# Architecture reference: directories, schema, layers, configuration

> Moved verbatim from the root `AGENTS.md` on 2026-10-17 to keep the files every agent session
> loads under 40,000 characters. The rules in each section stay in `AGENTS.md` under the same
> heading, which points here. This describes the fork's code at upstream v0.9.0; after an
> upstream sync, prefer upstream's `AGENTS.md` and delete this file if it is stale.

## Directory Structure

**Monorepo Layout (Bun Workspaces):**

```
packages/
├── paths/        # @archon/paths      - path resolution + Pino logger factory
├── git/          # @archon/git        - worktrees, branches, repos, exec wrappers
├── providers/    # @archon/providers  - AI agent providers (owns the SDK deps)
├── isolation/    # @archon/isolation  - worktree + container isolation
├── workflows/    # @archon/workflows  - workflow engine (loader, router, DAG executor)
├── core/         # @archon/core       - business logic, database, orchestration
├── adapters/     # @archon/adapters   - Slack, Telegram, GitHub, Discord
├── server/       # @archon/server     - OpenAPIHono HTTP server + Web adapter (SSE)
├── cli/          # @archon/cli        - command-line interface
├── web/          # @archon/web        - React frontend
└── docs-web/     # the docs site (astro)
```

Listed in dependency order — each package may depend only on those above it. *Package Split*
under **Architecture Layers** below states each one's exact allowed dependencies; that list is
the rule, and it is what a change must respect. Inside a package, `ls` and the file docblocks
are more current than any tree drawn here.

## Database Schema

**19 Tables (all prefixed with `remote_agent_`):**
1. **`codebases`** - Repository/project metadata and commands (JSONB); `kind` (`'repo'`/`'folder'`, default `'repo'`) discriminates git repos from **folder projects** (non-git workspaces — multi-repo roots or plain ops folders — that run in place with named `_folder/<slug>/` storage; `repository_url`/`default_branch` are null)
2. **`conversations`** - Track platform conversations with titles and soft-delete support; nullable `user_id` records first creator (provenance + execution-identity **fallback** only — chat turns execute as the message sender, #1982)
3. **`sessions`** - Track AI SDK sessions with resume capability
4. **`isolation_environments`** - Isolation tracking (git worktrees AND folder-project containers — `provider` is `'worktree'`/`'container'`; container rows use a `''` `branch_name` sentinel and store `{containerId, volume, image, overlayMode, …}` in `metadata`); nullable `created_by_user_id` preserves first creator
5. **`workflow_runs`** - Workflow execution tracking and state; nullable `user_id` for per-run attribution; nullable `parent_run_id` (self-referential FK, `ON DELETE SET NULL`) links a `workflow:` sub-run to the parent run that spawned it (#2121 Phase 2); nullable `output_root` records the resolved `~/.archon/workspaces/<project>/` this run's artifacts, logs, and state live under, written ONCE at run start (never on resume) so historical artifacts stay addressable across a codebase rename (#2200/#1192) — readers prefer it and re-derive identity only when it is NULL
6. **`workflow_events`** - Step-level workflow event log (step transitions, artifacts, errors)
7. **`messages`** - Conversation message history with tool call metadata (JSONB); nullable `user_id` (NULL for assistant rows). Split write-path: the **web** adapter persists its own turns via `MessagePersistence`; the **orchestrator** persists non-web turns (Slack/Telegram/GitHub/Discord/CLI) fire-and-forget, guarded by `isWebAdapter` to avoid double-writing web turns — only AI-bound turns get a user row (deterministic-command and approval-only turns return earlier), so a `user` row always pairs with an `assistant` row
8. **`codebase_env_vars`** - Per-project env vars injected into project-scoped execution surfaces (Claude, Codex, bash/script nodes, and direct chat when codebase-scoped), managed via Web UI or `env:` in config
9. **`users`** - Archon-internal identity (one row per human/bot); created lazily on first sight by any adapter; `role` (`'admin'`(default)`/'member'`) is the identity seam for future per-resource scoping (visibility stays open today)
10. **`user_identities`** - Per-platform mapping (Slack U-id, Telegram chat id, Discord snowflake, GitHub login, Better Auth web user id) → `users.id`; `UNIQUE(platform, platform_user_id)`
11. **`workflow_node_sessions`** - Per-node provider session IDs persisted across workflow re-runs (opt-in via `persist_session`); keyed by `(workflow_name, node_id, scope_key, provider)`; `scope_key` is typically the conversation UUID
12. **`user_github_tokens`** - Per-user GitHub device-flow tokens encrypted at rest (AES-256-GCM); one row per Archon user (`UNIQUE(user_id)`), cascades on user deletion; numeric `github_user_id` anchors the commit no-reply email
13. **`user_provider_keys`** - Per-user AI-provider credentials encrypted at rest (AES-256-GCM); one row per `(user_id, provider)` (`UNIQUE(user_id, provider)`), cascades on user deletion; `kind` is `api_key` or `oauth`; resolved + injected into the **acting user's** (run starter / message sender) runs/chat env at execution time. Always available — the encryption key is auto-provisioned at `~/.archon/credential-key` when `TOKEN_ENCRYPTION_KEY` is not set. Since #1955 the `provider` column holds **vendor-canonical credential ids** (`anthropic`, `openai`, `github-copilot`, plus the Pi backend vendors) — NOT agent ids; legacy `claude`/`codex`/`copilot` rows are renamed by an idempotent startup data fix (vendor row wins on conflict), and the connectable catalog is derived from provider registrations (`acceptedCredentials` via `credentials:` on `ProviderRegistration`), never hand-listed
14. **`user_ai_prefs`** - Per-user AI preferences (Phase 3): personal model `tiers`/`aliases` (JSON-as-TEXT) + `default_provider` + `default_model` (#1998 — per-user default CHAT model, written atomically with `default_provider`; replaces the `large`-tier lookup for direct chat only when the effective provider matches — workflows still resolve `large`). NON-encrypted (model names aren't secrets — mirrors `codebase_env_vars`, not the provider-key store); one row per user (`UNIQUE(user_id)`), cascades on user deletion. Folded into `buildAiProfile` as the highest-precedence layer at the userId-aware seams (workflow executor: run starter; chat orchestrator: message **sender**-first, conversation creator only as fallback — #1982); needs a web/CLI identity but NO `TOKEN_ENCRYPTION_KEY`
15–18. **`remote_agent_auth_user` / `remote_agent_auth_session` / `remote_agent_auth_account` / `remote_agent_auth_verification`** - Better Auth tables for opt-in web login (**PostgreSQL only**; always created on Postgres via the idempotent schema apply, but populated only when web auth is enabled — `DATABASE_URL` + `BETTER_AUTH_SECRET`). Owned and shaped by Better Auth (text ids, camelCase columns); Archon never queries them directly — a session maps to the canonical `users` row via `user_identities('web', <betterAuthUserId>)`
19. **`remote_agent_schema_version`** - Diagnostic schema vintage (#2316): single row (`id = 1`) recording `created_app_version` (the Archon build that created this database — NULL, never guessed, for databases predating the table) and `app_version`/`applied_at` (the build that last applied schema). Written from `APP_VERSION` by both adapters' existing idempotent apply-on-connect path, and only when the value changes. Surfaced by `archon doctor` and `GET /api/health`; **nothing gates on it**

**Key Patterns:**
- Conversation ID format: Platform-specific (`thread_ts`, `chat_id`, `user/repo#123`)
- One active session per conversation
- Codebase commands stored in filesystem, paths in `codebases.commands` JSONB

**Session Transitions:**
- Sessions are immutable - transitions create new linked sessions
- Each transition has explicit `TransitionTrigger` reason (first-message, plan-to-execute, reset-requested, etc.)
- Audit trail: `parent_session_id` links to previous session, `transition_reason` records why
- Only plan→execute creates new session immediately; other triggers deactivate current session

## Architecture Layers

**Package Split:**
- **@archon/paths**: Path resolution utilities, Pino logger factory, web dist cache path (`getWebDistDir`), CWD env stripper (`stripCwdEnv`, `strip-cwd-env-boot`) (no @archon/* deps; `pino` and `dotenv` are allowed external deps)
- **@archon/git**: Git operations - worktrees, branches, repos, exec wrappers (depends only on @archon/paths)
- **@archon/providers**: AI agent providers (Claude, Codex, Pi community) — owns SDK deps, `IAgentProvider` interface, `sendQuery()` contract, and provider-specific option translation. `@archon/providers/types` is the contract subpath (zero SDK deps, zero runtime side effects) that `@archon/workflows` imports from. Providers receive raw `nodeConfig` + `assistantConfig` and translate to SDK-specific options internally. Core providers live under `claude/` and `codex/`; community providers live under `community/` (currently `community/pi/`, registered with `builtIn: false`). `@archon/providers/oauth` is the SDK-boundary subpath wrapping Pi's `@earendil-works/pi-ai/oauth` (subscription login: Claude Pro/Max, Copilot) — `@archon/core` drives Pi-based subscription OAuth through it so the Pi SDK dep stays in `@archon/providers`. The ChatGPT/Codex subscription login is NOT Pi-driven: it's Archon-owned PKCE in `@archon/core` `credentials/openai-oauth.ts` (Pi drops the `id_token` the Codex CLI requires, #1924).
- **@archon/isolation**: Worktree isolation types, providers, resolver, error classifiers, and the folder-project backend seam — `IIsolationBackend`/`resolveFolderBackend` + the `ExecutionContext` it produces (depends only on @archon/git + @archon/paths + @archon/providers/types — the types-only import that carries the shared `ExecutionContext` + write-back result contracts). The container backend's full lifecycle: `prepare` (per-run upper volume + labeled container) → in-container exec → `suspend` (`docker stop` on pause) / `resumeEnv` (rediscover by `diy.archon.env-id` label + restart, or recreate over the surviving volume; fails loud if the volume is gone) → `finalize` (overlay diff walk) → approval-gated `applyChanges` (the ONE live-root write) / `discardChanges` → `destroy`. The engine drives suspend + the write-back gate through a structural write-back port (`ContainerWriteBackBackend`, injected via `ExecuteWorkflowOptions.container`) so @archon/workflows never imports @archon/isolation. The write-back gate reuses the pause/approve machinery with a `type: 'writeback'` ApprovalContext (synthetic `__writeback__` node); the resume path branches on the persisted `metadata.pending_writeback` marker (idempotent via `writeback_resolved`). Container pauses are CLI-resumable only (chat/web resume fails fast with a CLI pointer, run stays resumable). `isolation list/cleanup` cover container envs; a paused run's container is never auto-pruned.
- **@archon/workflows**: Workflow engine - loader, router, executor, DAG, logger, bundled defaults (depends only on @archon/git + @archon/paths + @archon/providers/types + @hono/zod-openapi + zod; DB/AI/config injected via `WorkflowDeps`)
- **@archon/cli**: Command-line interface for running workflows and starting the web UI server (depends on @archon/server + @archon/adapters for the serve command)
- **@archon/core**: Business logic, database, orchestration (depends on @archon/providers for AI and @hono/zod-openapi for core Zod schemas; provides `createWorkflowStore()` adapter bridging core DB → `IWorkflowStore`)
- **@archon/adapters**: Platform adapters for Slack, Telegram, GitHub, Discord (depends on @archon/core)
- **@archon/server**: OpenAPIHono HTTP server (Zod + OpenAPI spec generation via `@hono/zod-openapi`), Web adapter (SSE), API routes, Web UI static serving (depends on @archon/adapters)
- **@archon/web**: React frontend (Vite + Tailwind v4 + shadcn/ui + Zustand), SSE streaming to server. `WorkflowRunStatus`, `WorkflowDefinition`, and `DagNode` are all derived from `src/lib/api.generated.d.ts` (generated from the OpenAPI spec via `bun generate:types`; never import from `@archon/workflows`)

**1. Platform Adapters**
- Implement `IPlatformAdapter` interface
- Handle platform-specific message formats
- **Web** (`packages/server/src/adapters/web/`): Server-Sent Events (SSE) streaming, conversation ID = user-provided string
- **Slack** (`packages/adapters/src/chat/slack/`): SDK with polling (not webhooks), conversation ID = `thread_ts`
- **Telegram** (`packages/adapters/src/chat/telegram/`): Bot API with polling, conversation ID = `chat_id`
- **GitHub** (`packages/adapters/src/forge/github/`): Webhooks + GitHub CLI, conversation ID = `owner/repo#number`
- **Discord** (`packages/adapters/src/community/chat/discord/`): discord.js WebSocket, conversation ID = channel ID

**Adapter Authorization Pattern:**
- Auth checks happen INSIDE adapters (encapsulation, consistency)
- Auth utilities co-located with each adapter (e.g., `packages/adapters/src/chat/slack/auth.ts`)
- Parse whitelist from env var in constructor (e.g., `TELEGRAM_ALLOWED_USER_IDS`)
- Check authorization in message handler (before calling `onMessage` callback)
- Silent rejection for unauthorized users (no error response)
- Log unauthorized attempts with masked user IDs for privacy
- Adapters expose `onMessage(handler)` callback; errors handled by caller

**2. Command Handler** (`packages/core/src/handlers/`)
- Process slash commands (deterministic, no AI)
- The orchestrator treats only these top-level commands as deterministic: `/help`, `/status`, `/reset`, `/workflow`, `/register-project`, `/update-project`, `/remove-project`, `/setproject` (binds by DB conversation id, clears cwd/worktree override, deactivates the session with `project-changed`), `/commands`, `/init` (falls back to the selected project root when `conversation.cwd` is null), `/worktree`
- `/workflow` handles subcommands like `list`, `run`, `status`, `cancel`, `resume`, `abandon`, `approve`, `reject`, `reset-sessions`
- Update database, perform operations, return responses

**3. Orchestrator** (`packages/core/src/orchestrator/`)
- Manage AI conversations
- Load conversation + codebase context from database
- Variable substitution: `$ARGUMENTS`/`$USER_MESSAGE` (the whole trigger message; positional `$1`/`$2`/`$3` are not supported)
- Session management: Create new or resume existing
- Stream AI responses to platform
- System prompt gets a "Managing Workflow Runs" section (`buildRunManagementSection` in `prompt-builder.ts`) teaching the chat agent to drive run management (`archon workflow runs/get/status/run --detach/approve/reject/abandon`) directly via bash. It is appended **only for project-scoped chats on providers without the native `manage_run` tool** (Codex/OpenCode/Copilot) — gated in `orchestrator-agent.ts` on `!scopedCaps.nativeTools`. Claude and Pi instead receive the in-process `manage_run` native tool (the prompt section would be redundant for them). This is the CLI-bash delivery path for providers that have neither native tools nor `skills:` (direct chat doesn't consume the `skills:` option — it is workflow-node-only).

**4. AI Agent Providers** (`packages/providers/src/`)
- Implement `IAgentProvider` interface
- **ClaudeProvider**: `@anthropic-ai/claude-agent-sdk`
- **CodexProvider**: `@openai/codex-sdk`
- **PiProvider** (community, `builtIn: false`): `@earendil-works/pi-coding-agent` — one harness for ~20 LLM backends via `<provider>/<model>` refs (e.g. `anthropic/claude-haiku-4-5`, `openrouter/qwen/qwen3-coder`); supports extensions, skills, tool restrictions, thinking level, best-effort structured output. See `packages/docs-web/src/content/docs/getting-started/ai-assistants.md` for setup, capability matrix, and extension config.
- Streaming: `for await (const event of events) { await platform.send(event) }`

## Configuration

**Environment Variables:**

see .env.example
see .archon/config.yaml setup as needed

**Assistant Defaults:**

Per-assistant model and option defaults live in `.archon/config.yaml` under `assistants.<provider>`, alongside `tiers:` and `aliases:`. The docs site's configuration reference (`packages/docs-web/src/content/docs/reference/configuration.md`) carries the full key set and value ranges; the schema in `@archon/core/config` is the authority. Two keys are worth knowing before you look: `claudeBinaryPath`/`codexBinaryPath` are required in compiled binaries when the matching `*_BIN_PATH` env var is unset, and `settingSources` controls which `CLAUDE.md`, skills, commands and agents the Claude SDK loads — use exactly `['project']` to restrict a run to project-only sources.

**Configuration Priority:**
1. Workflow-level options (in YAML `model`, `modelReasoningEffort`, etc.)
2. Config file defaults (`.archon/config.yaml` `assistants.*`)
3. SDK defaults

**Model Validation:**
- Workflows are validated at load time for provider _identity_ only — `provider:` (workflow-level and per-node) must be a registered provider id, otherwise the YAML is rejected with `Unknown provider '<id>'. Registered: claude, codex, pi`.
- Model strings are classified by `resolveModelSpec()` in `packages/workflows/src/model-validation.ts`: tier keywords (`small`/`medium`/`large`) resolve via built-in defaults plus `tiers:` overrides; `@<name>` refs resolve via the merged alias map from config; anything else remains a literal SDK model string.
- Tier and alias refs can resolve provider, model, and provider-specific options. Literal model strings keep the normal provider chain (`node.provider ?? workflow.provider ?? config.assistant`).
- `tiers:` and `aliases:` are valid on global and repo config (repo overrides global). Reserved names `small`, `medium`, `large` cannot be used as custom alias names. Custom alias keys must start with `@` (e.g. `@fast`).

## Archon Directory Structure

**User-level (`~/.archon/`):** per-project workspaces under `workspaces/owner/repo/` (`source/`, `worktrees/`, `artifacts/`, `logs/`), with folder projects at `workspaces/_folder/<slug>/` (no `source/` or `worktrees/` — they run in place), plus `archon.db` and the global `config.yaml`. The docs site's directory reference (`packages/docs-web/src/content/docs/reference/archon-directories.md`) has the full layout.

**Repo-level (`.archon/` in any repository):**

```text
.archon/
├── commands/       # Custom commands
├── workflows/      # Workflow definitions (YAML files)
├── scripts/        # Named scripts for script: nodes (.ts/.js for bun, .py for uv)
└── config.yaml     # Repo-specific configuration
```

The repo directory holds SOURCE only — every byte a run produces lives under
`~/.archon/workspaces/<project>/`. `.archon/state/` is the LEGACY location for cross-run
state: it had no engine support (prompts did `mkdir -p .archon/state` relative to cwd), so
inside an isolated run it wrote to the worktree and died at cleanup, and in a user's repo it
was stageable. Use `$STATE_DIR` instead. Archon detects a legacy directory, WARNs once with
the `mv`, and never moves it; `scripts/migrate-state-dir.ts` is the operator's one-shot
(dry run by default; pass `--apply` to move).

- `ARCHON_HOME` - Override the base directory (default: `~/.archon`)
- Docker: Paths automatically set to `/.archon/`
