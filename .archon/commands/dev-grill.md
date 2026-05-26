---
description: Discovery — adversarially challenge the idea using the grill-me skill
argument-hint: "<raw idea description>"
---

# Stage: Grill

You are an autonomous Claude Code instance running the GRILL stage of
dev-idea. Human is NOT available — write your output and exit cleanly.

**Idea:** $ARGUMENTS
**Workflow ID:** $WORKFLOW_ID
**Project root:** `$(pwd)` (no worktree — running on the live checkout)
**Output target:** `$ARTIFACTS_DIR/grill.md`

---

## Your job

Apply the `grill-me` skill to the raw idea. This is adversarial by design —
your goal is to find every weak point BEFORE we burn cycles writing a PRD.

Surface, in writing:

1. **Hidden assumptions** — what does this idea quietly assume about users,
   the codebase, the market, the underlying tech?
2. **Weak reasoning** — where does the idea say "obviously X" without
   evidence? Where does the logic skip a step?
3. **Missing alternatives** — what other ways are there to solve this
   problem? Why this approach over those?
4. **Scope risk** — what's the smallest version of this idea that proves the
   hypothesis? What's the bloat that would slip in by default?
5. **Existing patterns** — does this duplicate something we already have?
   Read `D:/projects/dev-system/_system/knowledge/INDEX.md` and `$(pwd)/`
   for prior art.
6. **Failure modes** — what happens when this is half-built? When traffic
   spikes? When the dependency it relies on changes API?

Be ruthless. Politeness here costs us a wasted PRD cycle.

---

## Output format

Write `$ARTIFACTS_DIR/grill.md`:

```markdown
---
stage: grill
project: <project name>
status: complete
idea_survived: true | false
completed_at: <ISO timestamp>
---

## Idea (as stated)
<one paragraph restatement>

## Hidden Assumptions
1. <assumption + why it might be wrong>

## Weak Reasoning
- <claim in idea> → <what's missing to make it credible>

## Alternatives Considered
- <alternative 1> — <why preferred / rejected>
- <alternative 2> — <why preferred / rejected>

## Existing Patterns Found
- <K-entry / file> — <how it relates>

## Smallest Viable Version
<what would prove the hypothesis with the least code>

## Failure Modes
- <mode> — <consequence>

## Verdict
**Idea survived:** YES | NO
**Refinement needed:** <one paragraph — what the ICP / PRD must address>
```

If the idea is fundamentally flawed (no real user, duplicates existing work,
relies on impossible primitives), set `idea_survived: false`. The grill-gate
will then halt the workflow without spending PRD cycles.

---

## Rules

- Do NOT write any code.
- Do NOT commit anything.
- Do NOT ask the human.
- Do NOT soften the critique to be polite.
- Write the output file when done — that signals completion.
