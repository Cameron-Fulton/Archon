---
description: Design stage — produce visual artifacts and a discovery log
argument-hint: "[prd: <id>] <task description>"
---

# Stage: Design

You are an autonomous Claude Code instance running the DESIGN stage. Human is
NOT available — write your output and exit cleanly.

**Task:** $ARGUMENTS
**Workflow ID:** $WORKFLOW_ID
**Project root:** `$(pwd)`
**Output target:** `$ARTIFACTS_DIR/design.md` (plus per-task artifacts)

---

## Context to load

1. Project instructions: `$(pwd)/CLAUDE.md`
2. System rules: `D:/SYSTEM.md`
3. Research findings: `$ARTIFACTS_DIR/research.md`

---

## Your job — force visual thinking that surfaces gaps before they get baked into a plan

### Step 1 — Classify the task

Determine the task type and declare which artifacts you will produce. Write
all artifacts into `$ARTIFACTS_DIR/`.

| Task type | Required artifacts |
|---|---|
| UI / Frontend | `design-mockup.html` + discovery log |
| Data model / Schema | `design-er.mmd` + discovery log |
| UI + Data model | `design-mockup.html` + `design-er.mmd` + discovery log |
| Flow / Process | `design-sequence.mmd` or `design-flow.mmd` + discovery log |
| Architecture | `design-architecture.mmd` + discovery log |
| Migration / Refactor | `design-before.mmd` + `design-after.mmd` + discovery log |

If the task has no UI, schema, flow, or architecture component (pure bugfix,
config change, copy-only edit), write the no-work output and exit:

```markdown
---
stage: design
project: <project name>
status: complete
no_work: true
completed_at: <ISO timestamp>
---

## No Design Required
<one sentence — e.g., "Pure bugfix with known reproduction path, no UI or schema changes.">
```

Write to `$ARTIFACTS_DIR/design.md`.

### Step 2 — Produce artifacts

**HTML mockups** (`$ARTIFACTS_DIR/design-mockup.html`)
- Use the `design-taste` skill if available.
- CSS variables for all colors. Never hardcode hex.
- Realistic seed data — never placeholders ("Item 1", "Company A").
- Include all interaction states (default, hover, active, selected, disabled).
- Include all data states (populated, empty, loading, error).
- Wire state changes in JS — filters filter, sorts sort.

**Mermaid ER diagrams** (`$ARTIFACTS_DIR/design-er.mmd`)
- Every entity the task touches plus adjacent relationships.
- Explicit cardinality (1:1, 1:N, N:M).
- Field names and types for new / modified fields.
- Mark indexed, unique, and default-value fields.
- Show join tables explicitly for many-to-many.

**Mermaid sequence diagrams** (`$ARTIFACTS_DIR/design-sequence.mmd`)
- Happy path first, error paths as `alt` blocks.
- Every HTTP call with method and path.
- Retry logic, state changes, auth checkpoints.
- Async steps show queue / webhook handoff.

**Mermaid flowcharts** (`$ARTIFACTS_DIR/design-flow.mmd`)
- Every decision point with the condition on the edge.
- Every terminal state (success, failure, escalation).
- Loops with exit conditions.
- Break into sub-flows if more than 10 nodes.

**Mermaid component diagrams** (`$ARTIFACTS_DIR/design-architecture.mmd`)
- Data flow direction on every edge.
- Edge labels show protocol (HTTP, WebSocket, queue, direct import).
- Service-to-data-store ownership.
- External dependencies as distinct nodes.

**Before / after diagrams** (`$ARTIFACTS_DIR/design-before.mmd` and `design-after.mmd`)
- Same notation and scale for both.
- Highlight what changes between them.
- Include a migration path note.

### Step 3 — Discovery log

Most important output. Answer ALL 7 questions. If the answer is "No", write
"No" with a one-sentence justification. Boilerplate "No" answers fail Step 4.

```markdown
## Discovery Log

### 1. Schema gaps
Does the design require fields, tables, or relationships not mentioned in the task or research?

### 2. API surface gaps
Does the design imply endpoints, query parameters, or response shapes that don't exist yet?

### 3. State gaps
Does the design show UI states (empty, error, loading, disabled, permission-denied) not mentioned in the task?

### 4. Relationship ambiguity
Did the design force a cardinality decision the task description left open?

### 5. Performance concerns
Does the design imply operations that could be slow at scale? (N+1 queries, unbounded lists, large payloads)

### 6. Contradiction with existing patterns
Does the design conflict with existing UI patterns, naming conventions, or data structures?

### 7. Missing from the research
Did the design process reveal information needs the research packet didn't cover?
```

### Step 4 — Quality gate

1. **Syntax gate** — confirm:
   - Every `.mmd` file parses without Mermaid syntax errors.
   - Every `.html` file has valid structure.
   - The discovery log addresses all 7 questions (no blank sections).

2. **Quality gate** — dispatch the `god-developer` agent to review:
   - Completeness — does it cover the full scope, not just the happy path?
   - Accuracy — do entity / field names match the existing codebase?
   - Discovery substance — real issues surfaced, not boilerplate "No" answers?
   - Downstream usefulness — would the plan agent write a better spec with these artifacts?

If `god-developer` rejects, revise once. If the revision is also rejected,
write `status: failed` with `reason: design-rejected` and exit.

---

## Output format

Write `$ARTIFACTS_DIR/design.md`:

```markdown
---
stage: design
project: <project name>
status: complete
completed_at: <ISO timestamp>
---

## Classification
**Task type:** <type>
**Artifacts produced:**
- <artifact filename> — <what it shows>

## Design Summary
<what the design covers, key decisions made>

## Discovery Log
<the 7-question discovery log from Step 3>

## Quality Gate
<PASS — god-developer approved>
```

---

## Rules

- Do NOT write implementation code.
- Do NOT commit anything.
- Do NOT ask the human.
- Do NOT run `/simplify`, `/harden`, or security review — those are later stages.
- NEVER self-review — dispatch `god-developer` for the quality gate.
- Write the output file when done — that signals completion.
