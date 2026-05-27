---
description: Discovery — adversarial PRD review via god-developer; blocks if no credible E2E test
argument-hint: "<raw idea description>"
---

# Stage: PRD Review

You are an autonomous Claude Code instance running the PRD REVIEW stage of
dev-idea. Human is NOT available — write your output and exit cleanly.

**Idea:** $ARGUMENTS
**Workflow ID:** $WORKFLOW_ID
**Project root:** `$(pwd)`
**Outputs:**
- `$ARTIFACTS_DIR/prd-review.md` (review report)
- `$(pwd)/lifecycle/prds/$WORKFLOW_ID/prd-amended.md` (amended PRD, when corrections apply)

---

## Context to load

1. Project instructions: `$(pwd)/CLAUDE.md`
2. System rules: `D:/SYSTEM.md`
3. PRD to review: `$(pwd)/lifecycle/prds/$WORKFLOW_ID/prd.md`
4. ICP research: `$(pwd)/lifecycle/prds/$WORKFLOW_ID/icp-research.md`
5. Grill output: `$ARTIFACTS_DIR/grill.md`

---

## Your job — adversarial review via god-developer

Dispatch the `god-developer` agent with this prompt:

> Adversarially review the PRD at `$(pwd)/lifecycle/prds/$WORKFLOW_ID/prd.md`.
> The job is to find every gap, weak claim, and unjustified assumption — not
> to validate the author. Run all of these checks:
>
> 1. **E2E test credibility (BLOCKING).** Does the "E2E Usability Test"
>    section describe a flow a real user would actually run, with verifiable
>    intermediate state changes and a concrete success assertion? If the
>    test is generic, hand-wavy, or omits the success assertion, FAIL.
> 2. **Vertical-slice scope.** Each phase in "Implementation Phases" must be
>    a vertical slice (DB → API → UI). Flag any phase that is purely a
>    horizontal layer (e.g. "build the API"). Slices that are too large
>    (≥150K tokens) should be split.
> 3. **Existing-primitive reuse.** Does the "Technical Approach" section
>    cite specific files / endpoints / components that already exist? Or
>    does it describe everything as new? FAIL if it ignores reuse.
> 4. **JTBD grounding.** Does the "Problem Statement" cite the ICP's job-to-
>    be-done verbatim? Generic problem statements are a red flag.
> 5. **Success metrics shape.** Are metrics outcome-shaped, not output-
>    shaped? "Reduces time-to-first-value from X to Y" is outcome.
>    "Ships dropdown" is output. FAIL if metrics are output-shaped.
> 6. **Decision log honesty.** Does the "Decisions Log" list rejected
>    alternatives with real reasoning, or is it empty / boilerplate?
> 7. **Open questions list.** Are real open questions surfaced, or is the
>    list missing / sanitized?
>
> Report PASS or FAIL with specific, actionable corrections. Use this format:
>
> ```
> ## Review Verdict
> PASS | FAIL
>
> ## Corrections Required
> ### [C1] <type> — <section in PRD>
> **Issue:** <what's wrong>
> **Required fix:** <what to change in the amended PRD>
> ```

---

## Threshold logic

- **PASS** with zero corrections → `review_result: APPROVED`. Do NOT write
  `prd-amended.md` — the original `prd.md` is already approved.
- **PASS with corrections (≤5)** → apply each correction to a copy of
  `prd.md` and write it as `prd-amended.md`. Frontmatter
  `review_result: CORRECTIONS_REQUIRED`.
- **FAIL on E2E test credibility** → `review_result: BLOCKED_NO_E2E`. Do NOT
  write `prd-amended.md`. The prd-gate will halt the workflow until the
  human revises the PRD manually.
- **FAIL with more than 5 corrections** → `review_result: TOO_INACCURATE`.
  Do NOT write `prd-amended.md`. The PRD needs a rewrite.

---

## Output

### `$ARTIFACTS_DIR/prd-review.md` (always)

```markdown
---
stage: prd-review
project: <project name>
status: complete
review_result: APPROVED | CORRECTIONS_REQUIRED | BLOCKED_NO_E2E | TOO_INACCURATE
completed_at: <ISO timestamp>
prd_id: $WORKFLOW_ID
---

## PRD Review — $WORKFLOW_ID

**Reviewer:** god-developer (dispatched by prd-review stage)
**PRD reviewed:** $(pwd)/lifecycle/prds/$WORKFLOW_ID/prd.md

## Review Verdict
PASS | FAIL — <reason>

## Corrections Required
### [C1] <type> — <section>
**Issue:** <what's wrong>
**Required fix:** <what to change>

(repeat per correction; omit section entirely if zero corrections)

## E2E Test Credibility Check
- Has named user steps with state changes? YES | NO
- Has explicit success assertion? YES | NO
- Has failure-mode tests? YES | NO
- Verdict: PASS | FAIL

## Reviewer Sign-off
> All [C*] corrections applied to amended PRD. (Or: BLOCKED — see verdict.)
```

### `$(pwd)/lifecycle/prds/$WORKFLOW_ID/prd-amended.md` (when applicable)

Apply every correction to a copy of `prd.md`. The dev-slice node will use
`prd-amended.md` if it exists, falling back to `prd.md`. Skip writing this
file if `review_result` is `BLOCKED_NO_E2E` or `TOO_INACCURATE`.

---

## Rules

- Do NOT modify `prd.md` directly — always write `prd-amended.md`.
- Do NOT commit — the dev-slice node owns the commit.
- Do NOT ask the human — write blockers to `prd-review.md` and exit.
- NEVER self-certify — dispatch `god-developer` for the actual review.
- Write the output file(s) when done — that signals completion.
