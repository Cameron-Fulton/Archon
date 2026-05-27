---
description: Discovery — write the PRD with a mandatory E2E usability test
argument-hint: "<raw idea description>"
---

# Stage: PRD

You are an autonomous Claude Code instance running the PRD stage of dev-idea.
Human is NOT available — write your output and exit cleanly.

**Idea:** $ARGUMENTS
**Workflow ID:** $WORKFLOW_ID
**Project root:** `$(pwd)`
**Output target:** `$(pwd)/lifecycle/prds/$WORKFLOW_ID/prd.md`

---

## Context to load

1. Project instructions: `$(pwd)/CLAUDE.md`
2. System rules: `D:/SYSTEM.md`
3. Grill output: `$ARTIFACTS_DIR/grill.md`
4. ICP research: `$ARTIFACTS_DIR/icp-research.md` (also at
   `$(pwd)/lifecycle/prds/$WORKFLOW_ID/icp-research.md`)

---

## Your job — write a problem-first PRD

The PRD reads top-to-bottom. Each section answers a specific question. Skip
no section. If you cannot answer a section honestly, write "TBD — needs
research" rather than filler.

### Mandatory E2E Usability Test (HARD REQUIREMENT)

Every PRD MUST include at least one E2E usability test in the format below.
The test specifies the user's golden path from "they need this" to "their
goal is achieved" with explicit visual proof requirements at each step. The
review-frontend node in dev-feature executes this test verbatim against a
real browser.

A PRD without a credible E2E test is rejected by the prd-review node.

### PRD sections

1. **Problem Statement** — from the ICP "JTBD" + "currently uses" sections.
   Concrete, observable, testable.
2. **Evidence** — quote ICP research and competitor pain-points. Cite the
   source of each quote.
3. **Proposed Solution** — synthesized from the inputs. Prefer extending
   existing primitives over creating new ones (cite file paths from ICP
   research's "Existing Primitives" section).
4. **Key Hypothesis** — "We believe [capability] will [solve problem] for
   [users]. We'll know we're right when [measurable outcome]."
5. **What we're NOT building** — explicit non-goals. Trims scope creep early.
6. **Success Metrics** — outcome-shaped, not output-shaped. "Reduces
   first-task time-to-value from 30 min to 5 min" beats "ships X feature".
7. **Open Questions** — anything that requires human judgment, business
   decision, or external research before this is shippable.
8. **Users & Context** — primary ICP (full), secondary ICP (brief), non-ICP.
9. **Solution Detail** — MoSCoW table (Must / Should / Could / Won't) for
   the v1 scope. MVP definition.
10. **Technical Approach** — references actual codebase files. Mark
    unverified items as "needs verification". Prefer "extend X" over
    "create new Y".
11. **Implementation Phases** — table of phases, each phase a vertical slice
    (DB → API → UI). Mark dependencies between phases. The dev-slice node
    will turn each phase into one Kanban task.
12. **E2E Usability Test** — see below. MANDATORY.
13. **Decisions Log** — key decisions made during this run; rejected
    alternatives with reasoning.

### E2E Usability Test format

```markdown
## E2E Usability Test

**Goal:** <plain-English statement of what the user achieves>

### Setup
- **User profile:** <which ICP (primary / secondary)>
- **Test data:** <required seed data, e.g. "1 organization with 3 members and 2 sample projects">
- **Auth state:** <signed-in / signed-out / specific role>
- **Starting URL:** <route>

### Steps

1. **<action verb> <element>** — e.g. "Click 'New Task' in the top nav"
   - Expected state change: <what visibly changes>
   - Visual proof: <screenshot of the resulting state>

2. **<action verb> <element>**
   - Expected state change: …
   - Visual proof: …

… (continue until the user has achieved the goal)

### Success Assertion
- The page shows: <observable state>
- The URL is: <expected path>
- The API call <method> <path> returned: <expected response shape>
- A reload preserves the new state: YES | NO (and why)

### Failure Modes to Test
- <bad input> → <expected error message + screenshot>
- <network failure mid-flow> → <expected behavior>
- <empty state> → <expected fallback>
```

---

## Output

Write `$(pwd)/lifecycle/prds/$WORKFLOW_ID/prd.md`. Create the directory if it
doesn't exist:

```bash
mkdir -p "$(pwd)/lifecycle/prds/$WORKFLOW_ID"
```

Frontmatter:

```markdown
---
stage: prd
project: <project name>
status: complete
prd_id: $WORKFLOW_ID
completed_at: <ISO timestamp>
---
```

After the frontmatter, the 13 sections in order.

---

## Rules

- Do NOT write any application code.
- Do NOT commit — the dev-slice node owns the commit.
- Do NOT ask the human — write open questions to section 7 instead.
- Do NOT skip the E2E Usability Test section. The prd-review node WILL reject.
- Write the output file when done — that signals completion.
