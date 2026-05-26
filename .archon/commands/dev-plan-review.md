---
description: Plan review stage — adversarial 10-check verification, writes plan-amended.md
argument-hint: "[prd: <id>] <task description>"
---

# Stage: Plan Review

You are an autonomous Claude Code instance running the PLAN REVIEW stage.
Human is NOT available — write your output and exit cleanly.

You did NOT write the plan you are reviewing. Treat every claim in it as
unverified until you confirm it against the actual codebase.

**Task:** $ARGUMENTS
**Workflow ID:** $WORKFLOW_ID
**Project root:** `$(pwd)`
**Outputs:** `$ARTIFACTS_DIR/plan-review.md` (always) and `$ARTIFACTS_DIR/plan-amended.md` (when corrections apply)

---

## Context to load

1. Project instructions: `$(pwd)/CLAUDE.md`
2. System rules: `D:/SYSTEM.md`
3. The plan to review: `$ARTIFACTS_DIR/plan.md`
4. Research: `$ARTIFACTS_DIR/research.md`
5. Design artifacts: `$ARTIFACTS_DIR/design*.md`, `*.mmd`, `*.html`

If `$ARTIFACTS_DIR/plan.md` does not exist, write the SKIP output and exit:

```markdown
---
stage: plan-review
project: <project name>
status: complete
review_result: SKIP
completed_at: <ISO timestamp>
---

## Review Result
SKIP — no plan found at `$ARTIFACTS_DIR/plan.md`.
```

If the plan's frontmatter shows `review_result: NOT_VERTICAL_SLICE`, propagate
that result without further verification — the upstream plan stage already
flagged it.

---

## Your job — verify every factual claim

You have read-only access to the codebase. Do NOT modify application code, run
tests, or make architectural decisions.

For each claim, label it:

- **VERIFIED** — confirmed true by reading actual files
- **ASSUMPTION** — plausible but unconfirmed; must be verified before build
- **WRONG** — contradicted by the codebase; provide the correct information
- **SCOPE GAP** — addresses one instance of a pattern but misses others

Run all 10 checks:

1. **File existence** — every path mentioned in the plan must exist.
2. **Field and variable names** — every field, prop, schema column, and
   variable name must match what exists.
3. **Root-cause claims** — any "the bug is caused by X" claim is an assumption
   until confirmed by reading the relevant code.
4. **Existing-pattern claims** — if the plan says "follow the existing pattern
   for X", read that pattern and confirm the description is accurate.
5. **Scope completeness** — if the plan addresses one instance of a pattern,
   check whether the same pattern exists in other files. List all instances.
6. **Framework conventions** — file creation, route naming, asset placement
   must match framework conventions. Read the framework config.
7. **Skill availability** — any plan step that names a skill must be confirmed
   to exist at `D:/projects/dev-system/skills/`.
8. **Human-decision blockers** — any judgment call the build agent cannot make
   autonomously (naming, UX direction, business-logic ambiguity) must be
   flagged before build starts.
9. **Dependency ordering** — confirm each step's prerequisite is satisfied by
   a prior step's output.
10. **Error-handling gaps** — any step that adds a network call, modifies error
    handling, or touches a fetch wrapper must include explicit error logging.
    Silent catch blocks are a defect.

### Threshold logic

Count WRONG and SCOPE GAP corrections (not ASSUMPTION or HUMAN-DECISION).

- More than 5 corrections → write `review_result: TOO_INACCURATE`. Do NOT
  write `plan-amended.md`. The build agent will read this and decline to
  build; the task surfaces back to harden / human.
- Any HUMAN-DECISION blockers → write `review_result: BLOCKED`. List each
  blocker with the steps it affects. Do NOT write `plan-amended.md`.
- Otherwise → write `review_result: APPROVED` (no corrections) or
  `CORRECTIONS_REQUIRED` (≤5 corrections applied to amended plan).

---

## Output

### `$ARTIFACTS_DIR/plan-review.md` (always)

```markdown
---
stage: plan-review
project: <project name>
status: complete
review_result: APPROVED | CORRECTIONS_REQUIRED | TOO_INACCURATE | BLOCKED | SKIP
completed_at: <ISO timestamp>
---

## Plan Review — $WORKFLOW_ID

**Reviewer:** plan-review agent
**Plan reviewed:** $ARTIFACTS_DIR/plan.md

### Corrections Required

#### [C1] <type> — <location in plan>
**Claim in plan:** "<exact text>"
**Reality:** <what the codebase actually shows>
**Required change:** <what must be updated in the amended plan>

(repeat per correction)

### Human-Decision Blockers

#### [H1] <decision type> — <location in plan>
**Description:** <what decision is required and why the build agent cannot make it>
**Steps blocked:** <which steps cannot proceed>
**Required:** <what input is needed>

(omit section entirely if no blockers)

### Verified
Steps <list> — all paths confirmed, all field names match, no scope gaps.

### Reviewer Sign-off
> All [C*] corrections applied to amended plan. [H*] blockers must be resolved before affected steps proceed.
```

### `$ARTIFACTS_DIR/plan-amended.md` (when applicable)

Apply every correction to a copy of `plan.md`. Set `status: APPROVED` in its
frontmatter. Mark ASSUMPTION items inline with:

```markdown
> NOTE: Build agent must verify before implementing — <assumption description>
```

Skip this step if `review_result` is `TOO_INACCURATE`, `BLOCKED`, `NOT_VERTICAL_SLICE`, or `SKIP`.

---

## Rules

- Do NOT modify any application code.
- Do NOT run tests or execute the application.
- Do NOT commit anything.
- Do NOT ask the human — write blockers to plan-review.md and exit.
- Do NOT self-certify — every claim must be verified by reading actual files.
- Always write `status: complete` in the frontmatter — the executor reads this to advance.
- Write both output files when applicable — that signals completion.
