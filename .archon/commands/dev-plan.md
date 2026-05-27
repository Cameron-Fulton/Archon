---
description: Plan stage — write an implementation plan informed by research and design
argument-hint: "[prd: <id>] <task description>"
---

# Stage: Plan

You are an autonomous Claude Code instance running the PLAN stage. Human is
NOT available — write your output and exit cleanly.

**Task:** $ARGUMENTS
**Workflow ID:** $WORKFLOW_ID
**Project root:** `$(pwd)`
**Output target:** `$ARTIFACTS_DIR/plan.md`
**Design-gate response (if any):** $design-gate.output

---

## Context to load

1. Project instructions: `$(pwd)/CLAUDE.md`
2. System rules: `D:/SYSTEM.md`
3. Research: `$ARTIFACTS_DIR/research.md`
4. Design summary: `$ARTIFACTS_DIR/design.md` (if it exists)
5. Design artifacts in `$ARTIFACTS_DIR/`: `design-mockup.html`, `design-er.mmd`,
   `design-sequence.mmd`, `design-flow.mmd`, `design-architecture.mmd`,
   `design-before.mmd`, `design-after.mmd` (whichever apply).
6. Reviewer guidance from `$design-gate.output` (if non-empty, treat as
   highest-priority input for this plan).

---

## Your job

Create a detailed implementation plan based on research and design.

### Vertical-slice rule (HARD GATE)

This pipeline only ships **vertical slices** — DB → API → UI in one task.
Before writing the plan, confirm the task is a vertical slice. If the task is
a horizontal layer (e.g. "add an API endpoint" with no UI consumer, "build
the frontend" with no backing API), STOP. Write the no-vertical-slice output
and exit so the plan-review stage can flag it back to the human:

```markdown
---
stage: plan
project: <project name>
status: complete
review_result: NOT_VERTICAL_SLICE
completed_at: <ISO timestamp>
---

## Why this is not a vertical slice
<one paragraph — what layer is missing and how to re-scope>
```

### When the task is a vertical slice

1. Read the design discovery log FIRST. Every discovery item must be addressed
   in the plan (incorporated, or explicitly deferred with reasoning).
2. Reference specific design artifacts:
   - "Build the table matching `design-mockup.html`."
   - "Implement the schema shown in `design-er.mmd`."
   - "Follow the flow defined in `design-sequence.mmd`."
3. Break the work into concrete, ordered steps. Each step lists:
   - Files to create / modify
   - Imports and types it depends on
   - One executable validation command
4. Specify the test strategy — what unit / integration / E2E tests must exist
   when this task is done. Reference the PRD's E2E spec if a `[prd: <id>]` tag
   is present in `$ARGUMENTS`.
5. Dispatch `god-developer` for an architectural review of the plan **before**
   writing the output. Never self-review plans.

---

## Output format

Write `$ARTIFACTS_DIR/plan.md`:

```markdown
---
stage: plan
project: <project name>
status: complete
completed_at: <ISO timestamp>
---

## Objective
<what we're building, one paragraph>

## Vertical Slice Confirmation
DB layer: <what changes>
API layer: <what changes>
UI layer: <what changes>

## Architecture
<approach, key design decisions, component structure, references to design artifacts>

## Implementation Steps
1. <step with specific files, imports, and a single validation command>
2. <step>
...

## Test Strategy
- Unit: <what to test>
- Integration: <what to test>
- E2E: <reference the PRD's E2E spec if applicable>

## Files Affected
- <path> — <create | update | delete> — <reason>

## Acceptance Criteria
- [ ] <observable criterion 1>
- [ ] <observable criterion 2>
- [ ] All Level 1-3 validation commands pass
```

---

## Rules

- Do NOT write implementation code.
- Do NOT commit anything.
- Do NOT ask the human.
- Dispatch `god-developer` for plan review BEFORE writing output. Never self-review.
- Write the output file when done — that signals completion.
