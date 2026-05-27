---
description: Update KB stage — append security findings to INCIDENT-LOG, run /memento + /librarian, archive lifecycle
argument-hint: "[prd: <id>] <task description>"
---

# Stage: Update Knowledgebase

You are an autonomous Claude Code instance running the UPDATE KB stage. Human
is NOT available — write your output and exit cleanly.

**Task:** $ARGUMENTS
**Workflow ID:** $WORKFLOW_ID
**Project root:** `$(pwd)` (feature-branch worktree)
**Output target:** `$ARTIFACTS_DIR/update-kb.md`

This stage is the SINGLE WRITE POINT for `INCIDENT-LOG.md` — the security
stage staged its findings to `$ARTIFACTS_DIR/security-findings.md`; you append
them here. Concurrent-write fix.

---

## Context to load

1. Project instructions: `$(pwd)/CLAUDE.md`
2. System rules: `D:/SYSTEM.md`
3. All artifacts in `$ARTIFACTS_DIR/`:
   - `research.md`, `design.md`, `plan-amended.md`, `build.md`,
     `review-backend.md`, `review-frontend.md`, `simplify.md`, `harden.md`,
     `security.md`, `commit.md`, `security-findings.md` (if it exists)

---

## Step 1 — Append security findings to INCIDENT-LOG.md (when present)

If `$ARTIFACTS_DIR/security-findings.md` exists:

1. Read the next available `INC-YYYY-NNN` number from
   `D:/projects/dev-system/_system/incidents/INCIDENT-LOG.md` (find the
   highest existing INC entry and add 1).
2. For each finding block in `security-findings.md`, render the canonical
   incident format (table row + detail section) into a single string. The
   format is defined in `D:/SYSTEM.md` rule 8 — do not deviate.
3. Append the rendered block(s) to
   `D:/projects/dev-system/_system/incidents/INCIDENT-LOG.md`.
4. Stage and commit the appended file from inside the dev-system repo. Do NOT
   commit from inside the worktree — `INCIDENT-LOG.md` lives outside the
   worktree's project tree.

If `security-findings.md` does NOT exist, skip Step 1 entirely. No findings
means no append, which is the expected happy path.

## Step 2 — Memento

Run the `/memento` slash command. Compress this session into a memory packet:

- The packet should be the next in series after the project's most recent `mp-NNN-` file.
- Write the packet to `$(pwd)/memory/`.
- Include: what was accomplished, key decisions, remaining work, entity state.

## Step 3 — Follow-up TODOs

Review every artifact in `$ARTIFACTS_DIR/` for follow-up work, deferred items,
or new tasks discovered during this run. If any exist, append them as
`- [ ]` items to `$(pwd)/TODO.md`. Create `TODO.md` if it doesn't exist:

```markdown
# TODO

- [ ] follow-up task description
```

Skip duplicates of existing unchecked or in-progress items. The Archon
dispatcher will pick up new TODO items on its next scan.

## Step 4 — Librarian

Run the `/librarian auto` slash command. It scans
`D:/projects/dev-system/_system/librarian/intake/` and promotes intake files
to the system knowledge base. The harden stage may have written intake files
this run; this is when they get processed.

## Step 5 — Cleanup commit

```bash
git status
```

Stage and commit any remaining tracked artifacts:
- new memory packet, `memory/INDEX.md` updates
- `TODO.md` if modified
- knowledge digest updates from the commit stage

Commit message: `chore: update-kb $WORKFLOW_ID + lifecycle cleanup`

Excluded by policy: `.env`, `node_modules/`, `.next/`, `*.db`, `.playwright-mcp/`.

Verify `git status` is clean (only untracked / ignored files remaining).

---

## Output format

Write `$ARTIFACTS_DIR/update-kb.md`:

```markdown
---
stage: update-kb
project: <project name>
status: complete
completed_at: <ISO timestamp>
packet_written: <packet filename>
incidents_appended: <count, or 0>
---

## Incident Log Append
<INC numbers added, or "No findings — skipped">

## Memory Packet
<filename + 1-line summary>

## Follow-up TODOs
- <item appended to TODO.md, or "None">

## Librarian
<intake items processed, knowledge entries promoted>

## Cleanup
<files committed in the cleanup commit>
```

---

## Rules

- Do NOT ask the human.
- Do NOT include credential values when copying findings — file path + credential type only for SEV:1 credential findings.
- Do NOT skip the INCIDENT-LOG.md append when `security-findings.md` exists.
- Do NOT modify INCIDENT-LOG.md if `security-findings.md` is absent.
- Always run `/librarian auto` — it's lightweight and idempotent.
- Write the output file when done — that signals completion.
