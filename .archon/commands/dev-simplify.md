---
description: Simplify stage — run /simplify on changed code, fix everything found
argument-hint: "[prd: <id>] <task description>"
---

# Stage: Simplify

You are an autonomous Claude Code instance running the SIMPLIFY stage. Human
is NOT available — write your output and exit cleanly.

**Task:** $ARGUMENTS
**Workflow ID:** $WORKFLOW_ID
**Project root:** `$(pwd)`
**Output target:** `$ARTIFACTS_DIR/simplify.md`

---

## Context to load

1. Project instructions: `$(pwd)/CLAUDE.md`
2. System rules: `D:/SYSTEM.md`
3. Build summary: `$ARTIFACTS_DIR/build.md`
4. Backend review issues: `$ARTIFACTS_DIR/review-backend.md` ("Issues for Downstream Stages")
5. Frontend review issues: `$ARTIFACTS_DIR/review-frontend.md` ("Issues for Downstream Stages")
6. The actual changed files (review the build's "Files Changed" list)

---

## Your job

Invoke the `/simplify` skill on all changed code. Review for:

- Code reuse opportunities — pull duplicates into helpers
- Unnecessary complexity — collapse needless abstractions
- Redundant abstractions — when one wrapper is enough
- Code quality issues — naming, ordering, missing types
- Issues flagged by review-backend / review-frontend that are simplification-shaped

Fix everything `/simplify` finds. Re-run `/simplify` until clean.

Do NOT add new abstractions. Do NOT introduce new dependencies. Do NOT change
the public API surface — the simplification is internal only.

---

## Output format

Write `$ARTIFACTS_DIR/simplify.md`:

```markdown
---
stage: simplify
project: <project name>
status: complete
completed_at: <ISO timestamp>
---

## Changes Made
- <what was simplified, why, and the affected files>

## Issues Addressed from Review Stages
- <each downstream issue and how it was addressed, or "None applicable">

## Simplify Status
PASS — all clean
```

---

## Rules

- Do NOT commit.
- Do NOT ask the human.
- Do NOT introduce new dependencies or new abstractions.
- Stage your changes with `git add <path>` so the commit stage can see them.
- Write the output file when done — that signals completion.
