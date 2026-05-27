---
description: Discovery — decompose PRD into vertical-slice tasks via POST /api/tasks
argument-hint: "<raw idea description>"
---

# Stage: Slice

You are an autonomous Claude Code instance running the SLICE stage of
dev-idea. Human is NOT available — write your output and exit cleanly.

**Idea:** $ARGUMENTS
**Workflow ID:** $WORKFLOW_ID
**Project root:** `$(pwd)`
**Output target:** `$ARTIFACTS_DIR/slice.md`

---

## Context to load

1. Authoritative PRD: prefer
   `$(pwd)/lifecycle/prds/$WORKFLOW_ID/prd-amended.md`. Fall back to
   `$(pwd)/lifecycle/prds/$WORKFLOW_ID/prd.md` only if the amended file does
   not exist.
2. ICP research: `$(pwd)/lifecycle/prds/$WORKFLOW_ID/icp-research.md`
3. Project instructions: `$(pwd)/CLAUDE.md`
4. System rules: `D:/SYSTEM.md`

---

## Your job

### Step 1 — Decompose the PRD into vertical slices

Read the "Implementation Phases" section of the PRD. Each phase becomes one
Kanban task. Each task is a vertical slice (DB → API → UI), small enough that
a single dev-feature run can finish it (≤100K tokens of work).

If a phase is too large or is a horizontal layer, split it into multiple
slices. Examples:
- Bad: "Add an API endpoint" (horizontal — no UI consumer named).
- Good: "Surface workspace member count on the dashboard header — adds DB query, oRPC endpoint, and updates DashboardHeader.tsx".

For each slice, produce:

- **title** — under 80 chars; first 4 words become the branch slug. Imperative voice.
- **description** — 2–4 sentences: what changes, why, acceptance criteria.
- **priority** — `low | normal | high` (use `normal` unless the PRD is explicit otherwise).
- **flags** — JSON object with optional `serial: true`, `depends: [slug]`, `skip: [stage]`. Default `{}`.

### Step 2 — Determine the project name

The Kanban task's `project` field MUST match the directory name of the
target codebase. Default to `basename "$(pwd)"`. If the PRD targets a
different project than the one the discovery workflow is running in, that
project name goes in the `project` field — but read the PRD carefully; this
is rare.

### Step 3 — Persist the ICP file (commit-once handoff)

Confirm `$(pwd)/lifecycle/prds/$WORKFLOW_ID/icp-research.md` exists. If not,
copy from `$ARTIFACTS_DIR/icp-research.md`:

```bash
mkdir -p "$(pwd)/lifecycle/prds/$WORKFLOW_ID"
[ -f "$(pwd)/lifecycle/prds/$WORKFLOW_ID/icp-research.md" ] || \
  cp "$ARTIFACTS_DIR/icp-research.md" "$(pwd)/lifecycle/prds/$WORKFLOW_ID/icp-research.md"
```

**Branch guard.** Discovery runs without a worktree, so `$(pwd)` is the live
checkout. Refuse to commit on a protected branch — switch to `prd/$WORKFLOW_ID`
instead so the human can review / merge it manually:

```bash
CURRENT=$(git rev-parse --abbrev-ref HEAD)
case "$CURRENT" in
  main|master|dev|develop)
    PRD_BRANCH="prd/$WORKFLOW_ID"
    git checkout -b "$PRD_BRANCH" || git checkout "$PRD_BRANCH"
    ;;
esac
```

Then commit the PRD directory so downstream `dev-feature` runs (which use a
fresh worktree from the base branch the PRD branch was created from) can
read it:

```bash
git add "lifecycle/prds/$WORKFLOW_ID/"
git commit -m "chore(prd): add PRD + ICP artifacts for $WORKFLOW_ID" || true
```

If `git status` shows nothing to commit (because the PRD directory was
already committed by an earlier run), skip the commit and continue.

### Step 4 — Create one Kanban task per slice

For each slice, POST to the local Archon REST API:

```bash
curl -sS -X POST http://localhost:3090/api/tasks \
  -H "Content-Type: application/json" \
  -d "$(jq -nc \
    --arg project "<project>" \
    --arg title "<title>" \
    --arg description "<description>" \
    --arg prd_id "$WORKFLOW_ID" \
    --arg priority "<priority>" \
    --argjson flags '<flags-json>' \
    '{ project:$project, title:$title, description:$description, prd_id:$prd_id, priority:$priority, flags:$flags, status:"ready" }')"
```

The endpoint returns `201` with the created task JSON. Capture the `id` of
each task for the output report. If a POST returns non-201, log the
response, skip that slice, and continue with the rest — partial success is
better than total rollback.

### Step 5 — Confirm tasks landed

For each task `id` returned, GET it back to confirm it persisted:

```bash
curl -sS "http://localhost:3090/api/tasks/<id>"
```

If any GET returns 404, mark the slice's `slice.md` row with `verified: NO`
and note the gap in `## Issues`.

---

## Output format

Write `$ARTIFACTS_DIR/slice.md`:

```markdown
---
stage: slice
project: <project name>
status: complete
prd_id: $WORKFLOW_ID
slice_count: <N>
tasks_created: <N>
completed_at: <ISO timestamp>
---

## PRD
**File:** $(pwd)/lifecycle/prds/$WORKFLOW_ID/prd-amended.md (or prd.md if no amendment)

## Slices

| # | Title | Project | Priority | Flags | Task ID | Verified |
|---|---|---|---|---|---|---|
| 1 | <title> | <project> | normal | {} | <uuid> | YES |

## Issues
- <any POSTs that failed, any GETs that 404'd, or "None">

## Next Step
The Archon dispatcher (Phase 3, scheduled via Task Scheduler) polls
`/api/tasks?status=ready` every 5 minutes and starts a `dev-feature` workflow
per task. Tasks created here will be picked up automatically once the
dispatcher is running.

For now (Phase 2 ship), promote tasks manually by running:

```bash
archon workflow run dev-feature \
  --branch feat/<project>-<slug>-<sha> \
  --cwd "D:/projects/<project>" \
  "[prd: $WORKFLOW_ID] <task title>"
```
```

---

## Rules

- Do NOT POST a slice that is not a vertical slice — split it first.
- Do NOT commit anything other than the PRD + ICP directory in Step 3.
- Do NOT push the commit — the dispatcher / next workflow run handles that.
- Do NOT ask the human.
- ALWAYS verify each created task with a GET — partial creates without
  verification are worse than no creates.
- Write the output file when done — that signals completion.
