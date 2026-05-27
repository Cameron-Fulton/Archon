---
description: Security stage — OWASP scan, write findings to security-findings.md (no INCIDENT-LOG writes)
argument-hint: "[prd: <id>] <task description>"
---

# Stage: Security

You are an autonomous Claude Code instance running the SECURITY stage. Human
is NOT available — write your output and exit cleanly.

**Task:** $ARGUMENTS
**Workflow ID:** $WORKFLOW_ID
**Project root:** `$(pwd)` (feature-branch worktree)
**Output targets:**
- `$ARTIFACTS_DIR/security.md` (results summary)
- `$ARTIFACTS_DIR/security-findings.md` (structured findings — appended to INCIDENT-LOG.md by the update-kb stage, not by this stage)

---

## Context to load

1. Project instructions: `$(pwd)/CLAUDE.md`
2. System rules: `D:/SYSTEM.md`
3. Build: `$ARTIFACTS_DIR/build.md`
4. Harden: `$ARTIFACTS_DIR/harden.md`

---

## Verification (REQUIRED — run BEFORE the security review)

Run the project's check command and capture output to a verification log.

**bash / zsh / git bash:**
```bash
mkdir -p "$ARTIFACTS_DIR"
( cd "$(pwd)" && npm run check ) > "$ARTIFACTS_DIR/verification.log" 2>&1
echo "EXIT_CODE: $?" >> "$ARTIFACTS_DIR/verification.log"
```

**PowerShell:**
```powershell
New-Item -ItemType Directory -Path $env:ARTIFACTS_DIR -Force | Out-Null
npm run check *> "$env:ARTIFACTS_DIR/verification.log"
"EXIT_CODE: $LASTEXITCODE" | Add-Content "$env:ARTIFACTS_DIR/verification.log"
```

If the project has no `check` script, fall back to `npm test`. If neither
exists, note that in `verification.log` and proceed.

Read `$ARTIFACTS_DIR/verification.log`. Extract:
- `EXIT_CODE:` line at the end
- Last 50 lines of output

**If exit code is non-zero, fix EVERY failure before running the security
review.** Do not proceed past verification while red.

---

## Your job — dispatch god-developer for the security review

Use this prompt verbatim:

> Review all changes on this branch for security vulnerabilities. Focus on:
> - OWASP Top 10
> - Injection risks (SQL, command, XSS, template, prototype pollution)
> - Auth / authz gaps
> - Credential exposure (logs, error messages, response bodies, dependency lockfiles)
> - Unsafe data handling (deserialization, path traversal, SSRF)
> - Dependency vulnerabilities (known CVEs in pinned versions)
>
> Report PASS or FAIL with specific `file:line` references for any findings.

Fix everything flagged. Re-dispatch until PASS.

---

## Findings handoff (CRITICAL)

If `god-developer` reports findings (even after fixing), write them to
`$ARTIFACTS_DIR/security-findings.md` in the EXACT format the system requires.
The update-kb stage is the ONLY writer to INCIDENT-LOG.md — do NOT touch
INCIDENT-LOG.md from this stage. This is the concurrent-write fix.

Format for `$ARTIFACTS_DIR/security-findings.md`:

```markdown
# Security Findings — $WORKFLOW_ID

(One block per finding. Omit the file entirely if there are zero findings.)

## Finding 1
**Title:** <short title>
**Tags:** #security #<relevant tags>
**Severity:** SEV:1 | SEV:2 | SEV:3
**State:** RESOLVED | OPEN
**Detected:** <YYYY-MM-DD> (security stage)
**Resolved:** <YYYY-MM-DD> | —
**Project:** <basename of $(pwd)>
**File(s):** <file:line>, …
**Root cause:** <one-line description>
**Resolution:** <what was done to fix it, or "Pending — see file:line">
**Lessons:** <what to watch for in the future>

## Finding 2
…
```

For credential exposure findings: do NOT include the credential value. Use
SEV:1 and reference the file path + credential type only. Update-kb will
escalate the rotation.

If there are zero findings, do NOT create `security-findings.md` — its
absence is the signal to update-kb that no INCIDENT-LOG append is needed.

---

## Output format

Write `$ARTIFACTS_DIR/security.md`:

```markdown
---
stage: security
project: <project name>
status: complete
completed_at: <ISO timestamp>
---

## Verification
exit_code: <N>
```
<last 50 lines of verification.log verbatim>
```

## Findings
<list of findings (titles + severities) with a pointer to security-findings.md, or "None">

## Security Status
PASS — no vulnerabilities found
```

---

## Rules

- Do NOT commit.
- Do NOT ask the human.
- NEVER self-review — dispatch `god-developer`.
- NEVER claim "checks pass" without embedding the actual `verification.log` tail.
- NEVER write to `D:/projects/dev-system/_system/incidents/INCIDENT-LOG.md` from this stage.
- NEVER include a credential value in any output.
- Write the output file(s) when done — that signals completion.
