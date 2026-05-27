---
description: Research stage — gather context, probe external APIs, write research.md
argument-hint: "[prd: <id>] <task description>"
---

# Stage: Research

You are an autonomous Claude Code instance running the RESEARCH stage of the
dev-feature pipeline. Human is NOT available during this run — write your
output and exit cleanly.

**Task:** $ARGUMENTS
**Workflow ID:** $WORKFLOW_ID
**Project root:** the directory you're currently in — `$(pwd)`
**Project name:** the basename of `$(pwd)`
**Output target:** `$ARTIFACTS_DIR/research.md`

---

## Context to load

1. Project instructions: `$(pwd)/CLAUDE.md` — read it.
2. System rules: `D:/SYSTEM.md` — read it.
3. ICP context (if `[prd: <id>]` tag in `$ARGUMENTS`): read
   `$(pwd)/lifecycle/prds/<id>/icp-research.md` if it exists. Strip the
   `[prd: <id>]` prefix before treating the rest as the task description.
4. Knowledge index: `D:/projects/dev-system/_system/knowledge/INDEX.md`
5. Incident log: `D:/projects/dev-system/_system/incidents/INCIDENT-LOG.md`

---

## Your job

Investigate and gather context for the task.

- Explore the codebase — identify affected files, dependencies, integration points.
- Check the knowledge index for prior solutions / gotchas relevant to this task.
- Check the incident log for related issues.
- Identify risks, unknowns, and open questions.
- Do NOT write any implementation code. Do NOT commit. This is read-only work.

---

## Kamakazi probe (MANDATORY when external services detected)

Before writing your output, scan the task description and the codebase for any of these signals:

- Named third-party API or service (Stripe, HubSpot, Cloudflare, OpenAI, Slack, GitHub, Trigger.dev, etc.)
- An import or dependency on an external SDK (`@stripe/stripe-js`, `openai`, `@hubspot/api-client`, etc.)
- A `.env` variable referencing an external service (`STRIPE_SECRET_KEY`, `OPENAI_API_KEY`, etc.)
- An `http://` or `https://` URL pointing to a domain you don't own
- Words in the task description like "integrate", "connect to", "sync with", "call the API"

If ANY signal is detected, invoke the kamakazi skill before writing your output:

```
Use the kamakazi skill to probe: <service name(s) detected>
```

Include kamakazi probe results in the research output under a `## External API Probe` section.

If NO signal is detected, skip kamakazi and note "No external APIs detected" in the output.

---

## Nothing-to-do check (MANDATORY)

After loading context, assess whether there is actionable work:

- If the task says "everything complete", "nothing remaining", "awaiting human",
  "PR open awaiting merge", or similar → there is NO work to do.
- If the only open threads are blocked on human action (merge approval, design
  decisions, credential rotation) → there is NO work to do.

If there is no actionable work, write this output and exit:

```markdown
---
stage: research
project: <project name>
status: complete
no_work: true
completed_at: <ISO timestamp>
---

## No Actionable Work

<one sentence explaining why>
```

Downstream nodes will detect `no_work: true` and exit early.

---

## Output format

Write `$ARTIFACTS_DIR/research.md`:

```markdown
---
stage: research
project: <project name>
status: complete
completed_at: <ISO timestamp>
---

## Task Summary
<one paragraph — what we're building/fixing and why>

## ICP Context (if PRD provided)
<one paragraph from icp-research.md, or "Not provided">

## Codebase Analysis
<affected files, current architecture, dependencies>

## Prior Knowledge
<relevant K-entries from INDEX.md, related INC entries>

## External API Probe
<kamakazi findings, or "No external APIs detected">

## Risks & Unknowns
<what could go wrong, what needs clarification>

## Recommendations
<approach suggestions for the design / plan stages>
```

---

## Rules

- Do NOT write any implementation code.
- Do NOT commit anything.
- Do NOT ask the human.
- Focus only on research and context gathering.
- Write the output file when done — that signals completion.
