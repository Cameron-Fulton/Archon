---
description: Harden stage — review, refactor, fill test gaps, write librarian intake
argument-hint: "[prd: <id>] <task description>"
---

# Stage: Harden

You are an autonomous Claude Code instance running the HARDEN stage. Human is
NOT available — write your output and exit cleanly.

**Task:** $ARGUMENTS
**Workflow ID:** $WORKFLOW_ID
**Project root:** `$(pwd)`
**Output target:** `$ARTIFACTS_DIR/harden.md`

---

## Context to load

1. Project instructions: `$(pwd)/CLAUDE.md`
2. System rules: `D:/SYSTEM.md`
3. Build: `$ARTIFACTS_DIR/build.md`
4. Backend review: `$ARTIFACTS_DIR/review-backend.md`
5. Frontend review: `$ARTIFACTS_DIR/review-frontend.md`
6. Simplify: `$ARTIFACTS_DIR/simplify.md`

---

## Your job

Invoke the `/harden` slash command. It covers:

- Code review — dispatch the `god-developer` agent. NEVER self-review.
- Self-heal — fix lint, type, and test failures automatically.
- Refactor opportunities — improve structure where it pays off.
- Test-gap analysis — add missing coverage for edge cases, error paths, and
  newly-touched code.
- Solutions extraction — identify reusable patterns and write them to the
  librarian intake at `D:/projects/dev-system/_system/librarian/intake/` using
  the format from `D:/SYSTEM.md` (with frontmatter `source`, `project`, `date`, `type`).

Fix everything `/harden` flags. Re-run until it passes.

If the build, simplify, or review stages flagged issues for downstream
attention, address each one explicitly here. Do not declare PASS while a
downstream-tagged issue remains open.

---

## Output format

Write `$ARTIFACTS_DIR/harden.md`:

```markdown
---
stage: harden
project: <project name>
status: complete
completed_at: <ISO timestamp>
---

## Review Findings
<what god-developer flagged>

## Fixes Applied
- <fix and why, with affected files>

## Test Gaps Filled
- <test added, what it covers>

## Refactors
- <refactor, why, affected files>

## Solutions Extracted
- <intake filename written, one-line summary>

## Downstream Issues Addressed
- <each issue from review-* and how it was fixed, or "None">

## Harden Status
PASS — all gates clear
```

---

## Rules

- Do NOT commit.
- Do NOT ask the human.
- NEVER self-review — dispatch `god-developer` for ALL reviews.
- Stage changes with `git add <path>` so the commit stage can see them.
- Write librarian intake files only inside `D:/projects/dev-system/_system/librarian/intake/`.
- Write the output file when done — that signals completion.
