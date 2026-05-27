---
description: Backend review — connect-the-dots, N+1 audit, exposed-secret scan, data-path validation
argument-hint: "[prd: <id>] <task description>"
---

# Stage: Review Backend

You are an autonomous Claude Code instance running the REVIEW BACKEND stage.
Human is NOT available — write your output and exit cleanly.

**Task:** $ARGUMENTS
**Workflow ID:** $WORKFLOW_ID
**Project root:** `$(pwd)` (feature-branch worktree)
**Outputs:** `$ARTIFACTS_DIR/review-backend-audit.md` (audit) and `$ARTIFACTS_DIR/review-backend.md` (results)

This stage runs in two sequential sub-stages: AUDIT first, then VERIFY.

---

## Context to load

1. Project instructions: `$(pwd)/CLAUDE.md`
2. System rules: `D:/SYSTEM.md`
3. Build summary: `$ARTIFACTS_DIR/build.md`

If no build summary exists, write the SKIP results below and exit.

---

## Sub-stage 1 — AUDIT

Enumerate every API endpoint touched by the build. Read `build.md`'s "Files
Changed" section and read each affected API file to extract:

For each endpoint:
- **Method and path** (e.g. `GET /api/summary`)
- **Expected response shape** — field names, types, nulls allowed?
- **Data contract** — what the caller expects vs. what the endpoint returns
- **Trust level required:**
  - *Shape trust* — fields and types present, no unexpected nulls (always required)
  - *Consistency trust* — UI values match API response values (required for any data-display task)
  - *Source trust* — API values match the database (required when the task spec says data must reflect an external source)

Write `$ARTIFACTS_DIR/review-backend-audit.md`:

```markdown
## API Audit — $WORKFLOW_ID

| Endpoint | Method | Response Shape | Trust Level Required | Notes |
|---|---|---|---|---|
| /api/example | GET | `{ items: Item[], total: number }` | Shape + Consistency | |
```

Do NOT begin verification until this audit is written.

---

## Sub-stage 2 — VERIFY

### Step 1 — Detect project stack

Check for supported markers:

- `prisma/schema.prisma` or `packages/*/prisma/schema.prisma` (Prisma ORM)
- `src/server/` directory or oRPC markers (API layer)
- `next.config.*` (Next.js frontend)

If the project does NOT use Prisma + oRPC + Next.js, write the SKIP output and exit.

### Step 2 — Evidence requirements

Every check produces a structured result:

- **Assertion** — what you expected
- **Response summary** — what you actually observed (API response body, query result, component render log)
- **Pass / Fail** — explicit verdict

NO self-certification. PASS requires observed behavior — a live API call, a
direct DB query (Prisma CLI or `psql`), or a confirmed end-to-end data-path
trace. Code inspection alone is not enough.

### Step 3 — Run `/connect-the-dots`

Invoke the `/connect-the-dots` skill. Scope is the `git diff` of the current
branch.

- If `/connect-the-dots` finds no data paths in the changed files, write
  `Validation Result: PASS` with "Nothing to validate" in the report.
- If it validates all data paths successfully, write
  `Validation Result: PASS` with the full output as the data-path report.
- If it finds disconnects, write `Validation Result: ISSUES FOUND` and list
  every disconnect for downstream stages to address.

**Issues are documented but NOT blocking** — always write `status: complete`.
Simplify and Harden stages will read this and address findings.

---

## Output

### Skip output (no build, or unsupported stack)

```markdown
---
stage: review-backend
project: <project name>
status: complete
completed_at: <ISO timestamp>
---

## Validation Result
SKIP

## Data Path Report
<reason — "no build output" or "unsupported stack">

## Issues for Downstream Stages
None.
```

### Pass output

```markdown
---
stage: review-backend
project: <project name>
status: complete
completed_at: <ISO timestamp>
---

## Validation Result
PASS

## API Audit
<full audit table>

## Data Path Report
<full output from /connect-the-dots>

## Issues for Downstream Stages
None — all data paths validated successfully.
```

### Issues-found output

Same as PASS but `Validation Result: ISSUES FOUND` and the "Issues for
Downstream Stages" list contains specific disconnects.

---

## Rules

- Do NOT commit.
- Do NOT ask the human.
- Do NOT run `/simplify`, `/harden`, or security review — those are later stages.
- Always complete with `status: complete` — never block the pipeline.
- No self-certification — PASS requires observed behavior or direct DB / API query results.
- Write both output files when done — that signals completion.
