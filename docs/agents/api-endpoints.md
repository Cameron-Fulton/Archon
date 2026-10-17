# API endpoints

> Moved verbatim from the root `AGENTS.md` on 2026-10-17 to keep the files every agent session
> loads under 40,000 characters. The rules in each section stay in `AGENTS.md` under the same
> heading, which points here. This describes the fork's code at upstream v0.9.0; after an
> upstream sync, prefer upstream's `AGENTS.md` and delete this file if it is stale.

## API Endpoints

**Web UI REST API** (`packages/server/src/routes/api.ts`):

**Workflow Management:**
- `GET /api/workflows` - List available workflows; optional `?cwd=`; returns `{ workflows: [...], recommended: [...], errors?: [...] }`. Each entry is `{ workflow, source, parseWarnings? }` — `parseWarnings` (#2213) holds warning messages naming the keys the engine silently dropped from that YAML and is **omitted** when the workflow is clean, so presence alone is the signal
- `POST /api/workflows/validate` - Validate a workflow definition in-memory (no save); body: `{ definition: object }`; returns `{ valid: boolean, errors?: string[] }`
- `GET /api/workflows/:name` - Fetch a single workflow by name; optional `?cwd=` query param; returns `{ workflow, filename, source: 'project' | 'bundled' }`
- `PUT /api/workflows/:name` - Save (create or update) a workflow YAML; body: `{ definition: object }`; validates before writing; requires `?cwd=` or registered codebase
- `DELETE /api/workflows/:name` - Delete a user-defined workflow; bundled defaults cannot be deleted
- `DELETE /api/workflows/:name/node-sessions` - Reset persisted per-node provider sessions; optional `?scope=` and `?node=` narrow the deletion; omitting `?scope=` is a cross-scope wipe and requires `?confirm=all-scopes`; returns `{ success, deleted }`

**Workflow Run Lifecycle:**
- `POST /api/workflows/runs/{runId}/resume` - Resume a failed or paused run from where it left off (skips already-completed DAG nodes; AI session context is not restored).
- `POST /api/workflows/runs/{runId}/abandon` - Abandon a non-terminal run (marks as cancelled); cascade-cancels non-terminal `workflow:` sub-run descendants (#2121 Phase 2) and reports `cascadeFailures`/`blockedParentRunId`
- `DELETE /api/workflows/runs/{runId}` - Delete a terminal workflow run and its events

**Codebases:**
- `GET /api/codebases` / `GET /api/codebases/:id` - List / fetch codebases
- `POST /api/codebases` - Register a codebase (clone or local path). A non-git local `path` now auto-registers as a folder project (`kind: 'folder'`, runs in place) instead of erroring
- `DELETE /api/codebases/:id` - Delete a codebase and clean up resources
- `GET /api/codebases/:id/env` - List env var keys for a codebase (never returns values)
- `PUT /api/codebases/:id/env` / `DELETE /api/codebases/:id/env/:key` - Upsert / delete a single codebase env var
- `GET /api/codebases/:id/environments` - List tracked isolation environments for a codebase

**Artifact Files:**
- `GET /api/runs/:runId/artifacts` - List artifact files for a run; walks the on-disk artifact directory (dotfiles skipped) and returns `{ files: [{ path, size, modifiedAt }] }`; 400 on invalid run id or path-escape attempt, 404 if the run does not exist
- `GET /api/artifacts/:runId/*` - Serve a workflow artifact file by run ID and relative path; returns `text/markdown` for `.md` files, `text/plain` otherwise; 400 on path traversal (`..`), 404 if run or file not found

**Command Listing:**
- `GET /api/commands` - List available command names (bundled + project-defined); optional `?cwd=`; returns `{ commands: [{ name, source: 'bundled' | 'project' }] }`

**Providers:**
- `GET /api/providers` - List registered AI providers; returns `{ providers: [{ id, displayName, capabilities, builtIn }] }`. `capabilities.nativeTools` is `true` for providers that accept in-process native tools (Claude, Pi) — Archon's `manage_run` tool is auto-injected into project-scoped chat for those providers only. `capabilities.structuredOutput` is a tiered union `'enforced' | 'best-effort' | false` (not a boolean): `'enforced'` = SDK/backend grammar-constrained (Claude/Codex/OpenCode), `'best-effort'` = prompt-augmentation + validate (Pi/Copilot), `false` = unsupported.

**Web Auth (opt-in Better Auth; Postgres + `BETTER_AUTH_SECRET`):**
- Better Auth mounts email/password login at `/api/auth/*` (sign-up/sign-in/sign-out/get-session). Mounted only when enabled; the catch-all explicitly falls through (`isArchonOwnedAuthPath` in `auth/config.ts`, guard-tested) for Archon-owned `/api/auth/status` + `/api/auth/github*` + `/api/auth/providers*` + `/api/auth/me/ai-prefs*` paths so they aren't shadowed (a missing exemption 404s the route — see #1918).
- `GET /api/auth/status` - Web auth availability + signup posture (no auth required); returns `{ enabled: boolean, signup: 'allowlist' | 'open' | 'disabled' }`. Drives the Web UI login gate.
- The per-request identity seam is `resolveAuthContext(c): { userId, role } | undefined` (in `routes/api.ts`): Better Auth session first, then the `X-Archon-User` header, then undefined. `resolveWebUserId` delegates to it; `requireWebUser` is the session-aware strict variant (401 missing / 503 backend). `role` rides the canonical user row (default `admin`).
- **Server-side API gate** (`isApiGateEnabled`): when web auth is enabled, every `/api/*` request must resolve to an identity or gets **401** — except `/api/auth/*` (login surface) and `/api/health*` (healthcheck must stay reachable). `/webhooks/*` and `/internal/*` are outside `/api/*` and untouched. On by default; `ARCHON_WEB_AUTH_REQUIRED=false` keeps login-UI-only. This is what lets Better Auth replace the Caddy `forward_auth` sidecar as the real access boundary.
- **Signup safety** (`getSignupMode`): with web auth on and no `ARCHON_AUTH_ALLOWED_EMAILS`, signup defaults to **disabled** (login only) + a boot WARN — never silently open. `ARCHON_AUTH_OPEN_SIGNUP=true` opts into open public signup.
- `GET /api/workflows/runs?mine=true` and `GET /api/conversations?mine=true` - Non-enforcing "my" filter (narrows to `ctx.userId` only when an identity resolves; default lists everything). Not a security boundary.

**GitHub Identity (per-user device flow; App mode + `TOKEN_ENCRYPTION_KEY`):**
- `POST /api/auth/github/device/start` - Begin the device flow for the current web user (from `X-Archon-User`); returns `{ device_code, user_code, verification_uri, interval, expires_in }`; 401 if no web-auth header
- `POST /api/auth/github/device/poll` - Single non-blocking poll; body `{ device_code }`; returns `{ status: 'pending' | 'connected' | 'expired' | 'denied' | 'error', githubLogin?, detail? }`
- `GET /api/auth/github` - Connection status for the current web user; returns `{ connected, githubLogin }`
- `DELETE /api/auth/github` - Disconnect the current web user's GitHub identity

**AI-Provider Keys (per-user; `requireWebUser`):**
- `GET /api/auth/providers` - List the current web user's connected provider keys; returns `{ enabled, connections: [{ provider, kind, label }], available: string[], subscriptionAvailable: string[], agents: [...] }` (no secret values; `available` = registry-derived connectable **vendor** catalog, `subscriptionAvailable` = subset that supports OAuth login; `enabled` is always `true` — vault is auto-provisioned). `agents` (#1955) is the agent → credential matrix: per registered agent `{ id, displayName, catalog: 'static'|'dynamic', ready, credentials: [{ vendor, displayName, kinds, connected, subscriptionAvailable, installEnv, ambientConfigured? }] }` — `installEnv`/`ambientConfigured` report server-env detection so readiness works on solo installs too; OpenCode is `catalog:'dynamic'` (introspect via the endpoint below). `requireWebUser` (401 without identity)
- `PUT /api/auth/providers/:provider` - Connect (upsert) an API key by **vendor id** (legacy `claude`/`codex`/`copilot` accepted + normalized); body `{ apiKey, label? }`; returns `{ success, provider: <vendor>, kind: 'api_key', label }` (never echoes the key). 400 on unknown vendor / blank key, 404 when per-user keys disabled, 500 (opaque) on storage failure
- `DELETE /api/auth/providers/:provider` - Disconnect a credential (idempotent, vendor-normalized); returns `{ success }`. 404 when disabled
- `POST /api/auth/providers/:provider/oauth/start` - Begin a subscription (OAuth) login (`anthropic`/`openai`/`github-copilot`); returns `{ sessionId, mode: 'manual'|'device', url?, userCode?, verificationUri?, expiresIn }` (no secret). 400 non-subscription vendor, 404 disabled, 503 when a previous login still holds the OAuth callback port (#1963 — retryable). Held server-side by the `oauth-bridge`: Pi's `login()` for anthropic/github-copilot; an Archon-OWNED PKCE flow for openai/ChatGPT (`openai-oauth.ts` — captures the `id_token` Pi drops, manual-paste only with no local callback server, #1924). `SUBSCRIPTION_PROVIDERS` (in `oauth-providers.ts`) is the single source of truth.
- `POST /api/auth/providers/:provider/oauth/poll` - Poll the login session; body `{ sessionId, code? }` (`code` = pasted manual-code); returns `{ status: 'pending'|'connected'|'error', detail? }`. Session bound to the caller's userId.
- Credentials (API keys + subscriptions) injected into runs/chat env at execution time (vault always active — `TOKEN_ENCRYPTION_KEY` overrides the auto-key on managed deploys). Subscription tokens refresh-on-read and re-save on rotation. Subscriptions are delivered to native Claude/Codex (env / `CODEX_HOME/auth.json`) AND to Pi — in workflow runs via a per-run `auth.json` (`ARCHON_PI_AUTH_PATH`), and in env-only direct chat (no artifacts dir) an `anthropic` subscription rides `ANTHROPIC_OAUTH_TOKEN` in the env bag, which the Pi env bridge reads ahead of `ANTHROPIC_API_KEY` (#1984).

**Per-User AI Prefs (Phase 3; `requireWebUser` — identity only, NO `TOKEN_ENCRYPTION_KEY`):**
- `GET /api/auth/me/ai-prefs` - The current user's stored prefs (raw per-user layer, not merged with config); returns `{ tiers?, aliases?, defaultProvider? }`. 401 without identity — the console hides "Just me" on failure.
- `PATCH /api/auth/me/ai-prefs/tiers` / `…/aliases` - Per-key merge writes (`null` unsets); validate provider via `isRegisteredProvider`, effort via `isEffortValidForProvider`, alias names (`@` prefix, not a reserved tier keyword). All return the updated prefs.
- `PATCH /api/auth/me/ai-prefs/default` - Set the personal default assistant + default chat model: `{ provider, model? }` written ATOMICALLY (omitted `model` clears any pin; `model` without `provider` → 400; `provider: null` clears both). Chat model precedence (#1998, chat call-site only): user `default_model` (provider must match) → configured `large` tier (user > repo > global) → install `assistants.<p>.model` (beats only the built-in tier default) → built-in tier default.
- Stored in `remote_agent_user_ai_prefs` (non-encrypted); folded into `buildAiProfile` as the **highest-precedence** layer (global < repo < user) at the userId-aware seams — workflow executor (`deps.getUserAiPrefs`, resolved from the run starter) and chat orchestrator (sender-first: `executionUserId = context.userId ?? conversation.user_id` — the SENDER's prefs and credentials win; the conversation creator is only the fallback when no sender identity resolves, see #1982). The per-user `defaultProvider` rebases tier defaults and the chat assistant. No identity → byte-for-byte config-only behavior (solo unchanged). A chat request for tier `large` that resolves via the fallback chain emits a one-line non-blocking nudge (`orchestrator.tier_fallback_nudge`). Note: on genuinely shared threads (Slack/Telegram), per-sender prefs mean the provider can differ per turn within one thread (session transitions churn accordingly), and a sender's turn carries the shared thread history into a call billed to their credential — accepted semantics.

**Config and provider metadata (System; not `requireWebUser`, but covered by the global API gate):**

- These routes are ungated on solo installs and when `ARCHON_WEB_AUTH_REQUIRED=false`. With web auth's default API gate enabled, they require either a Better Auth session or the trusted reverse-proxy identity header; only `/api/auth/*` and `/api/health*` bypass that gate. The proxy header is safe only when a trusted proxy strips client-supplied copies (or Archon binds to loopback).
- The config `PATCH` routes do not add a route-specific identity requirement. Consequently, disabling the global API gate leaves them writable whether or not the optional proxy header is present; deployments that opt out must enforce the equivalent boundary at their proxy.
- `GET /api/config` - Read-only safe config; returns `{ config, database }`. `config` includes `tiers` (configured small/medium/large presets), `tierDefaults` (built-in presets for the default provider, computed via `buildAiProfile` — lets the UI show what an unset tier resolves to), and `aliases` (configured `@custom` aliases, merged repo > global).
- `PATCH /api/config/assistants` - Update default assistant + per-provider model defaults.
- `PATCH /api/config/tiers` - Update model-tier presets; body `{ tiers: { small?, medium?, large? } }` where each tier is `{ provider, model, effort? }` or `null` (unset). Per-key merge; validates each `provider` via `isRegisteredProvider`. Writes `~/.archon/config.yaml`. Drives the console "AI Settings → Model Tiers" panel + `archon ai tier` CLI.
- `PATCH /api/config/aliases` - Update `@custom` model aliases; body `{ aliases: Record<'@name', entry | null> }`. Same per-key merge + validation as `/tiers`, plus alias-name checks (`@` prefix, not reserved). Drives the console "Model Aliases" panel + `archon ai alias` CLI.
- `GET /api/providers/pi/models` - Pi's model catalog (`{ models: [{ ref, provider, id, name, reasoning, cost, contextWindow }] }`) for the tier picker's cost/reasoning hint. Best-effort: returns `{ models: [] }` on any catalog failure — never blocks tier/alias saves.
- `GET /api/providers/opencode/credentials` - Introspect OpenCode's backend providers (#1955): proxies the embedded server's `GET /provider` + `/provider/auth`; returns `{ providers: [{ id, name, env, connected, modelCount, authMethods }] }` (metadata only; `connected` is install-wide — OpenCode's auth store is server-global). **Heavyweight**: starts the embedded OpenCode runtime when not already running — call on demand from the settings card, never on passive page load. 503 (never a silent `[]`) when the runtime is unavailable.

**System:**
- `GET /api/health` - Health check with adapter/system status
- `GET /api/update-check` - Check for available updates; returns `{ updateAvailable, currentVersion, latestVersion, releaseUrl }`; skips GitHub API call for non-binary builds

**OpenAPI Spec:**
- `GET /api/openapi.json` - Generated OpenAPI 3.0 spec for all Zod-validated routes

**Webhooks:**
- `POST /webhooks/github` - GitHub webhook events
- Signature verification required (HMAC SHA-256)
- Return 200 immediately, process async

**Internal (App mode only; bind 127.0.0.1):**
- `POST /internal/git-credential` - Git credential helper endpoint. Returns `{token}` for the installation matching the requested host/path. Used by the `git-credential-archon` script in worktree `.git/config` to refresh installation tokens for long-running workflow `git` operations. Hands out installation tokens — MUST NOT be exposed beyond loopback. Server **refuses to start** (not just WARN) if App mode is active and `hostname != 127.0.0.1/localhost`, unless `ARCHON_ALLOW_INTERNAL_ON_PUBLIC_BIND=1` is set as an opt-in escape hatch for deployments where the reverse proxy already drops `/internal/*`.

**@Mention Detection:**
- Parse `@archon` in issue/PR **comments only** (not descriptions)
- Events: `issue_comment` only
- Note: Descriptions often contain example commands or documentation - these are NOT command invocations (see #96)
