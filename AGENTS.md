# Agent Instructions — Archon

1. Read D:/SYSTEM.md before starting any work.
2. Read CLAUDE.md for project-specific context.
3. Check D:\projects\dev-system\_system\incidents\INCIDENT-LOG.md before debugging.
4. Check D:\projects\dev-system\_system\knowledge\INDEX.md before building integrations.
5. If you discover a reusable pattern, gotcha, or solution: write it to D:\projects\dev-system\_system\librarian\intake\ (see SYSTEM.md for format).
6. Do not create files or folders outside the defined structure.
7. **Git safety:** NEVER push to upstream (coleam00/Archon). Only push to SearchActions/ or Cameron-Fulton/ forks. Run `git remote -v` before every push.
8. **Test isolation:** Never run bare `bun test` from repo root — always use `bun run test` to avoid mock.module() pollution across packages.

## Project Overview

**Archon — a self-hostable, governed agentic automation engine.** Archon runs multi-step workflows that mix deterministic steps (bash/scripts) with AI agents (Claude Code SDK, Codex SDK, and others), with human approval gates and full audit trails — driven remotely from Slack, Telegram, GitHub, Discord, the web UI, or the CLI. Its most mature surface today is agentic **coding** (controlling Claude Code / Codex against repos); the same engine is being extended to drive general **business-operations** automation. Built with **Bun + TypeScript + SQLite/PostgreSQL** and deployed as a single-tenant install (one isolated instance per operator or client — see *Single-Tenant per Install*). Architecture prioritizes simplicity, flexibility, governance, and user control.

## Product Direction

Archon is being positioned as a governed agentic automation engine for business operations, not only coding.

## Core Principles

**Single-Tenant per Install**
- One isolated instance per operator or client — the deployment model is one install (e.g. one VPS) per client, **not** one install serving many tenants. Keep the data model and runtime single-tenant: no per-tenant isolation, row-scoping, or tenant multiplexing. Client isolation is achieved at the **deployment** layer, not in code — a deliberate simplification, not a limitation.
- Multi-**user** within one install (several humans sharing an instance, each with their own identity and credentials) **is** supported, and is distinct from multi-**tenant**. Don't conflate them.

**Platform Agnostic**
- Unified conversation interface across Slack/Telegram/GitHub/cli/web
- Platform adapters implement `IPlatformAdapter`
- Stream/batch AI responses in real-time to all platforms

**Type Safety (CRITICAL)**
- Strict TypeScript configuration enforced
- All functions must have complete type annotations
- No `any` types without explicit justification
- Interfaces for all major abstractions

**Zod Schema Conventions**
- Schema naming: camelCase, descriptive suffix (e.g., `workflowRunSchema`, `errorSchema`)
- Type derivation: always use `z.infer<typeof schema>` — never write parallel hand-crafted interfaces
- Import `z` from `@hono/zod-openapi` (not from `zod` directly). Exception: `@archon/providers` imports `z` from `zod` directly in `claude/native-tools.ts` — it only builds the Zod shape the Claude SDK's `tool()` expects (never an OpenAPI schema), and being an SDK-deps-only leaf package it must not pull in Hono.
- Recursive schemas: use zod v4 getter properties plus an explicit `z.ZodType<T>` annotation with a hand-written `T` to break the inference cycle — the annotation forces structural agreement so drift is a compile error. Established precedent: `loopGroupNodeConfigSchema`/`LoopGroupNodeConfig` in `packages/workflows/src/schemas/dag-node.ts` (the one sanctioned exception to the z.infer-only rule)
- Record schemas: always pass an explicit key type — `z.record(z.string(), valueSchema)` — zod v4 dropped the single-arg `z.record(valueSchema)` form
- All new/modified API routes must use `registerOpenApiRoute(createRoute({...}), handler)` — the local wrapper handles the TypedResponse bypass. Two narrow exceptions exist: (1) routes that serve raw non-JSON content (e.g. `/api/artifacts/:runId/*` returns `text/markdown`/`text/plain`) AND use wildcard path params that OpenAPI 3.0 can't represent, use `app.get(...)` with an explanatory comment; (2) multipart-or-JSON routes (e.g. `/api/conversations/:id/message`, `/api/workflows/:name/run`) register through `registerOpenApiRoute` but drop `request.body` from the route config so Zod doesn't validate multipart payloads against a JSON schema — the handler parses both content types manually.
- Core row schemas live in `packages/core/src/schemas/` — one file per data shape (conversation, message, user, codebase, session, workflow-event, env-var, workflow-run); `index.ts` re-exports all
- Route schemas live in `packages/server/src/routes/schemas/` — one file per domain
- Engine schemas live in `packages/workflows/src/schemas/` — one file per concern (dag-node, workflow, workflow-run, retry, loop, hooks, node-artifact); `index.ts` re-exports all
- Engine schema naming: camelCase (e.g., `dagNodeSchema`, `workflowBaseSchema`, `nodeOutputSchema`)
- `TRIGGER_RULES` and `WORKFLOW_HOOK_EVENTS` are derived from schema `.options` — never duplicate as a plain array (exception: `@archon/web` must define a local constant since `api.generated.d.ts` is type-only and cannot export runtime values)
- `loader.ts` uses `dagNodeSchema.safeParse()` for node validation; graph-level checks (cycles, deps, `$nodeId.output` refs) remain as imperative code in `validateDagStructure()`

**Git Workflow and Releases**
- `main` is the release branch. Never commit directly to `main`.
- `dev` is the working branch. All feature work branches off `dev` and merges back into `dev`.
- All PRs must use the template at `.github/pull_request_template.md`. Always keep Problem and outcome, Review guidance, Solution, and Validation; include the conditional sections only when they add material information, and delete the rest along with every instructional comment. Do not write "N/A" to preserve a section. When opening a PR via `gh pr create`, copy the template into the body explicitly; GitHub only auto-applies it through the web UI.
- Link the issue with `Closes #<number>` (or `Fixes` / `Resolves`) in the PR description so it auto-closes on merge.
- To release, use the `/release` skill. It compares `dev` to `main`, generates changelog entries, bumps the version, and creates a PR to merge `dev` into `main`.
- Releases follow Semantic Versioning: `/release` (patch), `/release minor`, `/release major`.
- Changelog lives in `CHANGELOG.md` and follows Keep a Changelog format.
- Version is the single `version` field in the root `package.json`.

**Git as First-Class Citizen**
- Let git handle what git does best (conflicts, uncommitted changes, branch management)
- Surface git errors to users for actionable issues (conflicts, uncommitted changes)
- Handle expected failure cases gracefully (missing directories during cleanup)
- Trust git's natural guardrails (e.g., refuse to remove worktree with uncommitted changes)
- Use `@archon/git` functions for git operations; use `execFileAsync` (not `exec`) when calling git directly
- Worktrees enable parallel development per conversation without branch conflicts
- Workspace sync is non-destructive by default: fetch, classify state, and fast-forward only when safe
- Use explicit `mode: 'reset'` only for Archon-owned checkout paths where the caller intentionally wants to hard-reset to `origin/<branch>` before creating a managed worktree
- **NEVER run `git clean -fd`**. For user-owned workspaces, preserve tracked and untracked changes and surface the state for user action; never commit their artifacts or logs. Explicit reset mode is limited to Archon-owned checkout paths.

## Engineering Principles

These are implementation constraints, not slogans. Apply them by default.

**KISS — Keep It Simple, Stupid**
- Prefer straightforward control flow over clever meta-programming
- Prefer explicit branches and typed interfaces over hidden dynamic behavior
- Keep error paths obvious and localized

**YAGNI — You Aren't Gonna Need It**
- Do not add config keys, interface methods, feature flags, or workflow branches without a concrete accepted use case
- Do not introduce speculative abstractions without at least one current caller
- Keep unsupported paths explicit (error out) rather than adding partial fake support

**DRY + Rule of Three**
- Duplicate small, local logic when it preserves clarity
- Extract shared utilities only after the same pattern appears at least three times and has stabilized
- When extracting, preserve module boundaries and avoid hidden coupling

**SRP + ISP — Single Responsibility + Interface Segregation**
- Keep each module and package focused on one concern
- Extend behavior by implementing existing narrow interfaces (`IPlatformAdapter`, `IAgentProvider`, `IDatabase`, `IWorkflowStore`) whenever possible
- Avoid fat interfaces and "god modules" that mix policy, transport, and storage
- Do not add unrelated methods to an existing interface — define a new one

**Fail Fast + Explicit Errors** — Silent fallback in agent runtimes can create unsafe or costly behavior
- Prefer throwing early with a clear error for unsupported or unsafe states — never silently swallow errors
- Never silently broaden permissions or capabilities
- Document fallback behavior with a comment when a fallback is intentional and safe; otherwise throw

**No Autonomous Lifecycle Mutation Across Process Boundaries**
- When a process cannot reliably distinguish "actively running elsewhere" from "orphaned by a crash" — typically because the work was started by a different process or input source (CLI, adapter, webhook, web UI, cron) — it must not autonomously mark that work as failed/cancelled/abandoned based on a timer or staleness guess.
- Surface the ambiguous state to the user and provide a one-click action.
- Heuristics for *recoverable* operations (retry backoff, subprocess timeouts, hygiene cleanup of terminal-status data) remain appropriate; the rule is about destructive mutation of *non-terminal* state owned by an unknowable other party.
- Reference: #1216 and the CLI orphan-cleanup precedent at `packages/cli/src/cli.ts:256-258`.

**Natural Language Is Not a Wire Format** — trust the agent to interpret; make the code validate
- Never reconstruct a user's intent from prose with regexes, keyword lists, or hand-written parsers. Let the agent read the complete message, then hand it a typed tool (`NativeTool` + JSON Schema) or a resolver that turns that understanding into a deterministic id, path, or action. Precedents: `manage_run` (`packages/core/src/orchestrator/manage-run-tool.ts`) and `resolveWorkflowName` (`packages/workflows/src/router.ts`) — tiered matching that throws on ambiguity rather than guessing.
- Put determinism after interpretation, at the tool boundary: validate resolved arguments, permissions, and invariants — never the grammar of the prose. When exact syntax is genuinely required, expose an explicit structured interface (slash command, CLI flag, button `action_id`) instead of disguising it as natural language.
- Deciding an intent *without* interpreting it is the same violation inverted. Applying one fixed action to arbitrary prose — "any message here means approve" — promises understanding and delivers a hard-coded branch. Either interpret, or expose the structured interface; never claim the first while doing the second.
- In workflows: **prose inside a node is the model thinking; prose between nodes is a wire format you invented.** A node told to emit an exact token so a later node can grep it must instead use `output_format` + `when: $node.output.field`, a bash/script exit code, or `until_bash`. Loops are the one gap: no structured completion channel exists yet (#2563), so use `until_bash` wherever completion is externally checkable and reserve the `until:` prose sentinel for genuine judgment until that lands.
- Classifying third-party output you don't control — git stderr, SDK error strings, vendor limit text surfaced as assistant prose — is NOT this rule; neither is repairing a model's own JSON that you then schema-validate. Don't cite this rule to delete an error classifier.
- Axis note: this governs runtime code and node wiring. The Workflow Language Constitution below governs the authoring-time YAML surface. Related values, different objects — don't collapse them.

**Workflow Language Constitution — YAML coordinates, code computes, agents judge**
- The workflow YAML expresses only what the ENGINE must see to govern a run: ordering, gates, joins, retries, sessions, artifacts, reusable structure. Computation stays out of the YAML and lives inside a node's body (the `bash:`/`script:` source or the `prompt:` text) — node fields like `when:`/`retry:` are YAML surface and stay declarative. This boundary is what keeps load-time validation, the visual builder, resume, and audit trails possible.
- **The rule governs the YAML surface, not what an agent does inside a node.** A `prompt:` node that computes is a legitimate authoring choice — often the right one when the author doesn't know the rule and wants the model to decide. Script nodes and prompt nodes are both escape hatches from the language; picking between them is ordinary engineering, not a constitutional question. Never cite the constitution to argue a prompt should become a script. (The one narrow exception is a *reliability* argument, not a constitutional one: a check with no judgment content whose failure is irreversible is better as a node that can't decline to fire.)
- Admissibility test for every new YAML surface feature (field, node type, expression capability): (1) does the engine need to see it to govern? (2) is it declarative data, not evaluation? (3) could a script node + existing wiring express it today? A feature that computes rather than coordinates is rejected — point to the escape hatch instead.
- `when:` never grows incrementally (no parens, no functions, no arithmetic). The answer to "when: can't express X" is a script node that computes the decision + `when:` on its structured output. If expression demand ever genuinely accumulates, adopt CEL wholesale in one versioned change — never home-grow operators.
- Composition features must resolve fully at LOAD time (the executor runs a flat static DAG); include parameterization, if ever added, is data-only. Runtime-resolved structure = a sub-run (its own governance object), not a language feature.
- New per-provider capabilities default to provider config / tier-alias presets, not new node fields; capability mismatches warn loudly (capabilities.ts is the source of truth).
- Implicit behaviors need the same scrutiny as new fields: documented, individually defeatable, fail-safe — or not added.
- Full rationale, case law, and the five failure smells: `packages/docs-web/src/content/docs/reference/workflow-language-constitution.md` (archon.diy/reference/workflow-language-constitution/). Cite it in `feat(workflows)` PRs touching the YAML surface.

**Determinism + Reproducibility**
- Prefer reproducible commands and locked dependency behavior in CI-sensitive paths
- Keep tests deterministic — no flaky timing or network dependence without guardrails
- Ensure local validation commands (`bun run validate`) map directly to CI expectations

**Reversibility + Rollback-First Thinking**
- Keep changes easy to revert: small scope, clear blast radius
- For risky changes, define the rollback path before merging
- Avoid mixed mega-patches that block safe rollback

## Essential Commands

### Development

`bun run dev` starts server + Web UI together with hot reload; `bun run dev:server` (port 3090) and `bun run dev:web` (port 5173) run them individually. Regenerating the frontend API types needs the server already running: `bun --filter @archon/web generate:types`. To use PostgreSQL instead of the default SQLite, `docker-compose --profile with-db up -d postgres` and set `DATABASE_URL` in `.env`.

### Testing

`bun run test` runs everything (per-package, isolated processes). `bun test --watch` and `bun test <path>` work within a single package.

**Test isolation (mock.module pollution):** Bun's `mock.module()` permanently replaces modules in the process-wide cache — `mock.restore()` does NOT undo it ([oven-sh/bun#7823](https://github.com/oven-sh/bun/issues/7823)). To prevent cross-file pollution, packages with conflicting `mock.module()` calls split their tests into separate `bun test` invocations — see each package's `package.json` `test` script for the current splits.

**Do NOT run `bun test` from the repo root** — it discovers all test files across all packages and runs them in one process, causing ~135 mock pollution failures. Always use `bun run test` (which uses `bun --filter '*' --parallel test` for per-package isolation).

**`bunfig.toml` is read from the cwd only, in both directions.** `bun --filter` runs each package script from that package's directory, so the root config never applies to a package's tests — hence `@archon/adapters`' own copy for the no-network guard. But the root `test` script ends with `bun test ./scripts/`, which *does* run from the root, so the root config's keys — `coverage` today — apply to that leg. Stating only the first half is how #2306 ruled coverage out for the wrong leg.

**When a subprocess-spawning test times out on windows-latest, get its healthy baseline before theorising (#2306).** `bun test`'s default reporter does not reliably print a passing test's duration — a fully green run can print none at all — so a failure log gives you the timeout and no baseline to compare it against — use `--reporter=junit` locally, and read passing durations out of past green CI job logs (`gh api /repos/<owner>/<repo>/actions/jobs/<id>/logs`; note `gh run view --job` can return a different run's logs). The baseline tells you which of two mechanisms you have, and they take opposite fixes:

- **Bimodal** — tight cluster far below 5000 ms, then an isolated jump to ~5015 ms, nothing between. A bounded stall, and every cause proven so far was a specific bound meeting Bun's 5000 ms default: #2473 was SQLite's `PRAGMA busy_timeout = 5000`, the same number; #2240 was a "fully mocked" test silently opening a real database. Find the bound. Raising the timeout would have buried both, and it disarms the only alarm that catches undeclared I/O.
- **Gradient** — a high, variable baseline creeping toward the budget. Genuine cost, so count the work. Windows has no `fork`, and Git-Bash/MSYS emulation makes each process creation far dearer than on Linux, so a shell loop that forks per item is the usual culprit.

Either way prefer removing work over widening the window: #2310 dropped a `tar` spawn for an in-process fixture, and #2306 stopped a dry run creating a database. Best of all, keep subprocess-spawning tests rare and cheap in the first place — every one of them is a test whose cost you do not control.

### Type Checking & Linting

`bun run type-check`, `lint`, `lint:fix`, `format`, `format:check`.

### Pre-PR Validation

**Always run `bun run validate` before creating a pull request.** Every step must pass for CI to succeed — see the `validate` script in the root `package.json` for the current list.

CI runs one check that `validate` does not: `bun run check:schema-upgrades` needs a live PostgreSQL, so it runs as its own job. A change to `migrations/000_combined.sql` is not fully validated locally until you run it too (see *Schema changes are additive-only* below).

### ESLint Guidelines

**Zero-tolerance policy**: CI enforces `--max-warnings 0`. No warnings allowed.

**When to use inline disable comments** (`// eslint-disable-next-line`):
- **Almost never** - fix the issue instead
- Only acceptable when:
  1. External SDK types are incorrect (document which SDK and why)
  2. Intentional type assertion after validation (must include comment explaining the validation)

**Never acceptable:**
- Disabling `no-explicit-any` without justification
- Disabling rules to "make CI pass"
- Bulk disabling at file level (`/* eslint-disable */`)

### Database

**Auto-Detection (SQLite is the default — zero setup):**
- **Without `DATABASE_URL`**: Uses SQLite at `~/.archon/archon.db` (auto-initialized, recommended for most users)
- **With `DATABASE_URL` set**: Uses PostgreSQL (schema auto-applied on startup; no manual `psql` needed). The Postgres adapter runs the idempotent `migrations/000_combined.sql` inside an advisory-lock transaction on first connection, so upgrades that add tables or columns converge automatically.

**Schema changes are additive-only (both dialects) — this is a hard rule, not a convention.**

There is no migration ledger and no version gate. Both schemas are re-applied in full on every connection, by every process that opens the database — the server, *every* CLI invocation, every `--detach` child — including an **older** Archon binary that happens to be on `PATH` beside a dev checkout. Any writer may apply any vintage of the schema at any time. Therefore:

- **Only ADD** tables, columns, and indexes. Never rename, retype, or drop anything a shipped version still reads or writes.
- **Every `ADD COLUMN ... NOT NULL` must carry a `DEFAULT`.** Without one the statement fails outright on a non-empty table, and a writer that predates the column would produce rows the newer writer rejects. This holds for every `ADD COLUMN` in the tree today — keep it that way.
- **Adding `NOT NULL` to a column already in a `CREATE TABLE` body only binds databases created after the change.** `CREATE TABLE IF NOT EXISTS` is a no-op on existing tables and SQLite has no `ALTER COLUMN`, so the old shape survives forever. Treat such a constraint as documentation and keep application code tolerant of NULL, or do a full table rebuild in `migrateColumns()`.
- **New indexes and `COMMENT ON COLUMN` statements go in the trailing "Indexes and column comments" section of `migrations/000_combined.sql`, never beside the table body.** A column declared only in a `CREATE TABLE IF NOT EXISTS` body does not exist while that block runs on an upgrade — the table is already there, so the statement is a no-op and the column arrives later, in the additive `ALTER TABLE` block. An index or column comment placed next to its table therefore passes on a fresh install and aborts the entire single-transaction apply with `42703` on an upgrade, crash-looping every boot (#2508). `migration-statement-order.test.ts` enforces the placement; `bun run check:schema-upgrades` proves it against real databases.
- **Test an upgrade, not just a fresh install.** `bun run check:schema-upgrades` applies the current schema on top of databases created by older releases, re-applies it to prove idempotence, and compares the result against a fresh install across columns, indexes, column comments, constraints and sequences. Baselines are every DISTINCT schema ever shipped in a release tag (tags that did not touch the schema share a file, so 21 tags give 8 baselines) — the set of vintages an install can actually have, not a sample. Exactly one divergence is expected and excused, `remote_agent_codebases_kind_check`, matched on the exact constraint identity in one direction only and printed on every run; if it ever stops occurring the check fails as stale, so the exception cannot outlive its reason. It needs a reachable PostgreSQL (`PGHOST`/`PGUSER`/… or `DATABASE_URL`; it creates and drops its own scratch databases), so it is a CI job rather than part of `bun run validate`.
- **Mirror every change into both schemas** (see the generated-files note in the Defaults section). The parity test in `sqlite.test.ts` checks table names and columns in both directions, against small tracked allowlists — so a column added to one dialect and forgotten in the other fails CI.
- `remote_agent_schema_version` records which Archon build created the database and which last applied schema to it, surfaced by `archon doctor` and `GET /api/health`. It is diagnostic only — nothing gates on it, and the values come from `APP_VERSION` in `packages/core/src/db/schema-version.ts`, never from a hand-bumped number.

### CLI (Command Line)

Run workflows directly from the command line without needing the server.

`archon --help` is the authoritative command list, and the docs site's CLI reference
(`packages/docs-web/src/content/docs/reference/cli.md`) is the authoritative detail — both stay
current with the code in a way a transcription here would not. From source, prefix any command
with `bun run cli` (e.g. `bun run cli workflow list`).

The rules `--help` will not tell you:

- Workflow and isolation commands must run inside a git repository; subdirectories resolve to the repo root. `--folder` is the escape hatch for a non-git directory.
- Isolation is the default for `workflow run` — it creates a worktree unless you pass `--no-worktree` or `--folder`.
- `--json` is supported on the read/write subcommands (`list`, `status`, `runs`, `get`, `approve`, `reject`, `abandon`, `resume`). On `approve`/`reject`/`resume` it records the decision and returns an ack **without** the inline auto-resume, leaving the run resumable — drive continuation separately.

## Architecture

### Directory Structure

Moved to `docs/agents/architecture.md`, section "Directory Structure". Read it before changing this area. The rules below stay here.

**Import Patterns:**

- `import type` for types, named imports for values, `import *` only for submodules with many exports (`@archon/core/db/conversations`, `@archon/git`) — **never** `import * as core from '@archon/core'`.
- Import workflow-engine types and functions from their direct subpaths (`@archon/workflows/deps`, `/store`, `/executor`, `/router`, `/schemas/workflow`), not from a package root.
- `@archon/web` must never import from `@archon/workflows` — it is a server package. Use the re-exports in `@/lib/api`, which derive from the generated OpenAPI spec.

### Database Schema

Moved to `docs/agents/architecture.md`, section "Database Schema". Read it before changing this area.

### Architecture Layers

Moved to `docs/agents/architecture.md`, section "Architecture Layers". Read it before changing this area.

### Configuration

Moved to `docs/agents/architecture.md`, section "Configuration". Read it before changing this area.

### Running the App in Worktrees

Agents working in worktrees can run the app for self-testing (make changes → run app → test via curl → fix). `bun dev` auto-allocates a port and logs it at startup.

**Port Allocation:**
- Worktrees: Automatic unique port (3190-4089 range, hash-based on path)
- Main repo: Default 3090
- Override: `PORT=4000 bun dev` (works in both contexts)
- Same worktree always gets same port (deterministic)

**Important:**
- Use the web API routes for manual validation (avoid running multiple platform adapters)
- Database is shared (same conversations/codebases available)
- Stop the server when done using its recorded PID. If that PID is unavailable, identify and stop only the process bound to the exact configured port; never use a broad process-name match across worktrees.

### Archon Directory Structure

Moved to `docs/agents/architecture.md`, section "Archon Directory Structure". Read it before changing this area. The rules below stay here.

What matters here: **artifacts and logs live outside the repo and must never be committed** — `$ARTIFACTS_DIR` points at `artifacts/runs/{id}/`, and typed node sidecars land in its `nodes/` subdirectory. `ARCHON_HOME` overrides the base directory; Docker sets it to `/.archon/`.

## Development Guidelines

### UI and Visual Design

All UI changes — production web (`packages/web/`), experiments (`packages/web/src/experiments/`), the docs site, marketing surfaces, and any future visual surface — must align with the Archon brand foundation.

- **Canonical brand guide:** https://archon.diy/brand/ (source: `packages/docs-web/src/content/docs/brand/index.md` + `packages/docs-web/public/brand/foundation.html`).
- **Use brand tokens, not ad-hoc values.** Colors, gradients, surfaces, and typography must come from the established design tokens (`packages/web/src/index.css`) or the brand guide. Don't hard-code hex values that aren't in the system.
- **Introducing a new visual token** (color, font, radius, spacing) means updating both the token source and the brand guide. Don't fork the palette per package.
- **When in doubt, consult the brand guide first** before inventing new visual treatments. Open a discussion if the guide doesn't cover your case.

### When Creating New Features

**Quick reference:**
- **Platform Adapters**: Implement `IPlatformAdapter`, handle auth, polling/webhooks
- **AI Providers**: Implement `IAgentProvider`, session management, streaming
- **Slash Commands**: Add to command-handler.ts, update database, no AI
- **Database Operations**: Use `IDatabase` interface (supports PostgreSQL and SQLite via adapters)
- **Plan insertion points**: Use stable text anchors (e.g., "after the `it('throws on ...')` test block"), never raw line numbers — line numbers drift on every preceding edit.

### SDK Type Patterns

Import and use external SDK types directly (`import { query, type Options } from '@anthropic-ai/claude-agent-sdk'`) rather than redeclaring an equivalent local interface. Duplicated shapes drift on every SDK bump and force `as any` at the call site; the SDK's own type keeps compatibility checked by the compiler. Use a narrow type assertion where an SDK response shape needs pinning.

### Testing

**Unit Tests:**
- Test pure functions (variable substitution, command parsing)
- Mock external dependencies (database, AI SDKs, platform APIs)

**Integration Tests:**
- Test database operations with test database
- Test end-to-end flows (mock platforms/AI but use real orchestrator)
- Clean up test data after each test

**Mock isolation rules (IMPORTANT):**
- **`mock.module()` MERGES over the real module — it does NOT replace the namespace.** An export omitted from the factory keeps its REAL implementation (verified on bun 1.3.11). So adding a new export to a production module silently un-mocks it in every test that mocks that module, and those tests start doing real I/O with no signal. This is exactly how `/workflow abandon` tests began opening a real SQLite DB: `findChildRuns` was added to `db/workflows` by #2121 but never added to `command-handler.test.ts`'s factory (see #2240). **When you add an export to a module, grep for `mock.module('<that module>'` and update every factory.**
- Unit tests must not touch real external resources. A missing stub does not fail loudly — it stalls, and the only bound is Bun's 5000 ms per-test timeout, which surfaces on CI as an intermittent, hard-to-attribute timeout (#2186, #2240). To audit a suspect file, run it with `ARCHON_HOME` pointed at an empty temp dir and check whether an `archon.db` appears.
- `@archon/adapters` enforces the network half via `packages/adapters/bunfig.toml` → `src/test/no-network.ts` (other packages can adopt it with the same three lines). Two limits, both verified: it traps only `globalThis.fetch`, so axios/undici clients (`@slack/web-api`, `@discordjs/rest`) slip past it; and **Bun reads `bunfig.toml` only from cwd**, so the guard is INACTIVE in the `bun test packages/…` single-file form above — it applies to `bun run test` and to `bun test` run from inside `packages/adapters/`. That same cwd rule means the ROOT `bunfig.toml` never applies to the `bun --filter` half of `bun run test`, since each package runs from its own directory — but it DOES apply to that script's trailing `bun test ./scripts/`, which runs from the root. See the cwd note under **Testing**.
- Bun's `mock.module()` is process-global and irreversible — `mock.restore()` does NOT undo it
- Do NOT add `afterAll(() => mock.restore())` for `mock.module()` cleanup — it has no effect
- Use `spyOn()` for internal modules that other test files import directly (e.g., `spyOn(git, 'checkout')`) — `spy.mockRestore()` DOES work for spies
- Never `mock.module()` a module path that another test file also `mock.module()`s with a different implementation
- When adding a new test file with `mock.module()`, ensure its package.json test script runs it in a separate `bun test` invocation from any conflicting files

**Manual Validation:** Use the web API (`curl`) or CLI commands directly for end-to-end testing of new features.

### Logging

Structured logging uses Pino via `createLogger('<module>')` from `@archon/paths`. Log a structured object first, event name second — `log.info({ conversationId, sessionId }, 'session.create_completed')`. On failure include `error: err.message`, `errorType: err.constructor.name`, and `err` itself.

**Event naming rules:**
- Format: `{domain}.{action}_{state}` — e.g. `workflow.step_started`, `isolation.create_failed`
- Avoid generic events like `processing` or `handling`
- Always pair `_started` with `_completed` or `_failed`
- Include context: IDs, durations, error details

**Log Levels:** `fatal` > `error` > `warn` > `info` (default) > `debug` > `trace`

**Verbosity:**
- CLI: `archon --quiet` (errors only) — suppresses Pino logs and workflow progress output
- CLI: `archon --verbose` (debug) — enables debug Pino logs and tool-level workflow progress events
- Server: `LOG_LEVEL=debug bun run start`

**Never log:** API keys or tokens (mask: `token.slice(0, 8) + '...'`), user message content, PII.

### Command System

Moved to `docs/agents/command-system.md`, section "Command System". Read it before changing this area. The rules below stay here.

- **After adding, removing, or editing a default file, run `bun run generate:bundled`** to refresh the embedded bundle. A new default file must be staged in git first (`git add`); `bun run generate:bundled` (and `check:bundled`) refuse to embed untracked files in `defaults/`. After editing `migrations/000_combined.sql`, run `bun run generate:bundled-schema` to keep the embedded schema in sync, AND mirror any new table into `createSchema()` in `packages/core/src/db/adapters/sqlite.ts` — the SQLite schema is hand-maintained separately and is NOT generated from the migration; the only intentional Postgres-only exception is the `remote_agent_auth_*` Better Auth tables, and the schema-parity test in `sqlite.test.ts` fails CI on any other drift. After a `@earendil-works/pi-ai` upgrade, run `bun run generate:pi-vendor-map` to regenerate the Pi backend → env-var map + credential specs from the installed SDK (a new upstream backend must be classified in `scripts/generate-pi-vendor-map.ts`). After changing any provider's `capabilities.ts` (or adding a provider/capability axis), run `bun run generate:capability-matrix` to refresh the canonical provider capability matrix at `packages/docs-web/src/content/docs/reference/provider-capabilities.md` — it is generated from the registry's capability constants (the same objects the dag-executor reads for ignored-capability warnings), so the docs can never drift from runtime behavior; a new `ProviderCapabilities` field fails the generator until it gets a matrix axis in `scripts/generate-capability-matrix.ts`. `bun run validate` (and CI) run `check:bundled`, `check:bundled-skill`, `check:bundled-schema`, `check:pi-vendor-map`, and `check:capability-matrix` and will fail loudly if any generated file is stale.

### Error Handling

**Database errors.** Wrap writes in try/catch, log with the failing parameters, and re-throw — never swallow. Archon's update helpers already throw when no row matched, so a re-thrown error is how a missing record surfaces; don't check rowCount yourself.

**Git/isolation errors — don't fail silently.** Map the raw error through `classifyIsolationError()` (`@archon/isolation`), which turns permission-denied / timeout / no-space / not-a-git-repo into a user-facing message. Log the raw error for debugging **and** send the classified message to the user; doing only one of the two is the bug this pattern exists to prevent.

### API Endpoints

Moved to `docs/agents/api-endpoints.md`, section "API Endpoints". Read it before changing this area. The rules below stay here.

**Security:**
- Verify webhook signatures (GitHub: `X-Hub-Signature-256`)
- Use `c.req.text()` for raw webhook body (signature verification)
- Never log or expose tokens in responses
- `/internal/*` paths hand out live credentials — the reverse proxy in production MUST drop them, or the server MUST bind to `127.0.0.1` only.
