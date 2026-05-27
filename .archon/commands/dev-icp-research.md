---
description: Discovery — define ICP, research competitors and UGC, write icp-research.md
argument-hint: "<raw idea description>"
---

# Stage: ICP Research

You are an autonomous Claude Code instance running the ICP RESEARCH stage of
dev-idea. Human is NOT available — write your output and exit cleanly.

**Idea:** $ARGUMENTS
**Grill-gate response (if any):** $grill-gate.output
**Workflow ID:** $WORKFLOW_ID
**Project root:** `$(pwd)`
**Output target:** `$ARTIFACTS_DIR/icp-research.md`

---

## Your job

Define the Ideal Customer Profile (ICP) for this idea, then research the
landscape so the PRD can be grounded in real users and real alternatives.

### Step 1 — Define the ICP

For this idea, answer in writing:

1. **Who** is the primary user? Be specific — role, context, organization
   size, technical maturity. Not "developers" — "solo full-stack engineer
   shipping a SaaS as a side project, uses Cursor, ships nightly".
2. **What** is their actual job-to-be-done? Use the JTBD framing:
   "When [situation], I want to [motivation], so I can [outcome]."
3. **Why now?** What changed in their context that makes this a problem
   worth solving today?
4. **What do they reach for today?** List every workaround / competing
   product they currently use. Note the gap each one leaves.
5. **What's the secondary user**, if any? Same questions, briefer.
6. **Who is explicitly NOT the user?** This narrows scope.

### Step 2 — Competitor research (WebSearch)

Use the WebSearch tool to find:

- 3+ direct competitors (named, with their pricing, positioning)
- Their public roadmaps (GitHub issues, public Trello, changelog)
- Recent feature shipments and announcements
- User reviews on G2, Trustpilot, Reddit, ProductHunt

For each competitor, note:
- The one thing they do better than the alternatives
- The one thing users complain about most
- Whether they overlap with our ICP or sit adjacent

### Step 3 — UGC and pain-point research (WebSearch)

Search for:
- Reddit threads about the problem space (`site:reddit.com <problem>`)
- Hacker News discussions (`site:news.ycombinator.com <problem>`)
- Stack Overflow / Discord transcripts where users describe the pain
- Tweets / blog posts from the ICP describing what they want

Capture exact quotes. Anonymized but verbatim. The PRD writer will reference
these directly.

### Step 4 — Existing primitives in the codebase

Read `$(pwd)` to find what already exists. The PRD should EXTEND existing
primitives where possible, not duplicate them. List:
- Existing endpoints / pages that partially solve this problem
- Existing components / utilities that could be composed
- Existing data already collected that the new feature could read

### Step 5 — Persist the ICP file for downstream workflows

Write the canonical ICP file to **TWO** locations:

1. `$ARTIFACTS_DIR/icp-research.md` — for this workflow run.
2. `$(pwd)/lifecycle/prds/$WORKFLOW_ID/icp-research.md` — durable, shared
   with downstream `dev-feature` runs that reference this PRD via
   `[prd: $WORKFLOW_ID]`.

The dev-slice node will commit the durable copy after the PRD finalizes.

---

## Output format

Write the ICP research to BOTH paths above. Format:

```markdown
---
stage: icp-research
project: <project name>
status: complete
prd_id: $WORKFLOW_ID
completed_at: <ISO timestamp>
---

## Idea
<one paragraph restatement, post-grill>

## Primary ICP
**Who:** <specific role, context, org size, tech maturity>
**JTBD:** "When …, I want to …, so I can …"
**Why now:** <trigger>
**Currently uses:** <list of workarounds + the gap each leaves>

## Secondary ICP (if any)
<same fields, briefer>

## Non-ICP
<who is explicitly out of scope, and why>

## Competitors
| Name | Strength | Weakness | Overlap with ICP |
|---|---|---|---|

## Pain-Point Quotes (verbatim, anonymized)
> "<quote>" — <source>

## Existing Primitives
- <file:line> — <what it already does, how the new idea could extend it>

## Insights for the PRD
- <insight 1>
- <insight 2>
```

---

## Rules

- Do NOT skip WebSearch — this stage is competitive intelligence, not vibes.
- Do NOT make up quotes. If you cannot find a verbatim quote, write
  "No verbatim source found" rather than inventing one.
- Do NOT commit — the dev-slice node owns the durable commit.
- Do NOT ask the human.
- Always create `$(pwd)/lifecycle/prds/$WORKFLOW_ID/` if it doesn't exist.
- Write the output files when done — that signals completion.
