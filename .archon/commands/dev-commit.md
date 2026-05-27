---
description: Commit stage — /done-gate then /gate then commit on the feature branch
argument-hint: "[prd: <id>] <task description>"
---

# Stage: Commit

You are an autonomous Claude Code instance running the COMMIT stage. Human is
NOT available — write your output and exit cleanly.

**Task:** $ARGUMENTS
**Workflow ID:** $WORKFLOW_ID
**Project root:** `$(pwd)` (feature-branch worktree)
**Output target:** `$ARTIFACTS_DIR/commit.md`

---

## Context to load

1. Project instructions: `$(pwd)/CLAUDE.md`
2. System rules: `D:/SYSTEM.md`
3. Build summary: `$ARTIFACTS_DIR/build.md`
4. Harden results: `$ARTIFACTS_DIR/harden.md`
5. Security results: `$ARTIFACTS_DIR/security.md`

---

## Your job

### Step 1 — `/done-gate`

Invoke the `/done-gate` slash command. It is a final completeness check that
verifies every data path, every UI/API alignment, every test that should exist
actually exists. Fix anything it flags before continuing.

### Step 2 — Inspect changes

```bash
git status
git diff --stat
```

Confirm the branch matches `feat/...` or `fix/...` (never `main`).

### Step 3 — Stage implementation files only

Stage the specific files that the build, simplify, harden, and security stages
modified. **Never** use `git add -A` or `git add .` — those would sweep up
ephemeral artifacts.

```bash
git add <explicit paths>
```

Excluded by policy (do not stage):
- `.env`, `.env.*`
- `node_modules/`, `.next/`, `dist/`, `build/`
- `*.db`, `*.db-shm`, `*.db-wal`
- `.playwright-mcp/`, `.archon/state/`

### Step 4 — Compose commit message

Format:
```
<type>(<scope>): <imperative summary under 70 chars>

<body — why this change matters>

Workflow-Id: <workflow id>
```

`<type>` ∈ `feat | fix | refactor | docs | chore | test | perf | build | ci`.
Scope is the affected package or feature area.

### Step 5 — Commit

```bash
git commit -m "<message>"
```

If the pre-commit hook fails, **investigate the failure**. Fix it and create a
NEW commit. **Never** use `--no-verify` to bypass.

### Step 6 — `/gate`

Invoke the `/gate` slash command. It runs lint, typecheck, tests, and writes a
journal entry. If `/gate` reports failures, fix them and create a follow-up
commit (`fix: address /gate findings`). Re-run `/gate` until clean.

### Step 7 — Knowledge digest refresh (autonomous, always safe)

If any committed file matches one of these patterns, the project's stack may
have changed and its retrieval digest is stale:

- `package.json`
- `pyproject.toml`
- `Cargo.toml`
- `Dockerfile`
- `docker-compose.yml` / `docker-compose.yaml`
- `pnpm-workspace.yaml`

Run:
```bash
python D:/projects/dev-system/_system/librarian/jobs/regenerate-project-digests.py "$(basename "$(pwd)")"
```

This rewrites `.knowledge/APPLICABLE.md` for the project. Stage and commit it
as `chore: refresh knowledge digest for stack changes`. If the script fails,
note the error in `commit.md` and continue — the 2-hour librarian cron retries.

---

## Output format

Write `$ARTIFACTS_DIR/commit.md`:

```markdown
---
stage: commit
project: <project name>
status: complete
completed_at: <ISO timestamp>
branch: <branch name>
commit_hashes:
  - <hash>: <subject line>
---

## Done-Gate
<PASS — what was verified>

## Commit
<commit subject + 1-2 line summary>

## Gate Status
<PASS — lint/typecheck/test all green>

## Digest Refresh
<ran / skipped — reason>
```

---

## Rules

- NEVER work on `main` — feature branch only.
- NEVER use `git add -A` or `git add .` — explicit paths only.
- NEVER `--no-verify` past a hook failure — fix the underlying issue.
- Do NOT ask the human.
- Write the output file when done — that signals completion.
