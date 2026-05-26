---
description: Frontend review — runs the PRD's E2E test in a real browser with screenshot proof
argument-hint: "[prd: <id>] <task description>"
---

# Stage: Review Frontend

You are an autonomous Claude Code instance running the REVIEW FRONTEND stage.
Human is NOT available — write your output and exit cleanly.

**Task:** $ARGUMENTS
**Workflow ID:** $WORKFLOW_ID
**Project root:** `$(pwd)` (feature-branch worktree)
**Outputs:** `$ARTIFACTS_DIR/review-frontend-audit.md` (audit) and `$ARTIFACTS_DIR/review-frontend.md` (results)

> **Browser MCP priority:**
> 1. **Chrome DevTools MCP** — load with `ToolSearch("chrome devtools")`, then call `mcp__chrome-devtools__*`.
> 2. **Playwright MCP (fallback)** — if a `system-reminder` reports `mcp__chrome-devtools__*` tools as "no longer available (MCP server disconnected)", OR if `ToolSearch("chrome devtools")` returns no results, switch to Playwright: `ToolSearch("playwright browser")` → `mcp__plugin_playwright_playwright__*`.
> 3. **Localhost Bash probing (last resort)** — only if both MCPs are unavailable. Document the gap in the audit report's "Missing Verification Capabilities" section.
>
> Never stall waiting for chrome-devtools to recover — disconnect is permanent for the session.

---

## Context to load

1. Project instructions: `$(pwd)/CLAUDE.md`
2. System rules: `D:/SYSTEM.md`
3. Build summary: `$ARTIFACTS_DIR/build.md`
4. Backend review (if it exists): `$ARTIFACTS_DIR/review-backend.md`
5. PRD E2E spec (if a `[prd: <id>]` tag is present in `$ARGUMENTS`):
   `$(pwd)/lifecycle/prds/<id>/prd.md` — find the "E2E Usability Test" section.

---

## Sub-stage 1 — AUDIT

### Step 1 — Detect frontend stack

Check for stack markers:

- `next.config.*`, `vite.config.*`, `nuxt.config.*`
- `app/` or `pages/` directory with `.tsx`/`.jsx`/`.vue`/`.svelte` files
- `package.json` with React / Vue / Svelte / Next.js dependencies

If no frontend framework is detected, write SKIP and exit.

### Step 2 — Frontend file changes (parallel with Step 3)

Run `git diff --name-only main...HEAD` and filter for `.tsx`, `.jsx`, `.vue`,
`.svelte`, CSS / Tailwind, page / route files. If no frontend files changed,
write SKIP and exit.

### Step 3 — Locate the dev server

You're running inside an Archon worktree. The dev server's port is
auto-allocated in the 3190–4089 range (hash-based on the worktree path) — do
NOT assume `localhost:3000`.

1. Start the dev server in the background:
   ```bash
   bun dev > /tmp/devserver-$WORKFLOW_ID.log 2>&1 &
   ```
   (or `npm run dev` / `pnpm dev` — match the project's `package.json`).

2. Poll the log until you see the allocated port:
   ```bash
   timeout 60 sh -c '
     until grep -oE "http://(localhost|127\.0\.0\.1):[0-9]+" /tmp/devserver-$WORKFLOW_ID.log | head -1; do
       sleep 1
     done
   '
   ```

3. Use that exact URL as `BASE_URL` for every browser action.

If the dev server never starts, write SKIP and note "Dev server unavailable —
Harden stage should verify UI manually".

### Step 4 — Produce audit report

Crawl the running app and produce:

- **Sitemap** — every URL the app exposes, auth required, expected HTTP status. Any nav or sidebar link not in the sitemap is an automatic finding. Any nav link resolving to 4xx / 5xx is a critical pre-test finding.
- **Feature matrix** — every interactive element on every page (buttons, filters, forms, dropdowns, file uploads, modals, tabs). Record what the DOM contains, not just what the spec says should exist.
- **API call inventory** — every network request per page load and interaction: method, path, expected response shape (from task spec and design artifacts).

Write `$ARTIFACTS_DIR/review-frontend-audit.md`:

```markdown
## Audit Report — $WORKFLOW_ID

### Sitemap
| Route | Auth Required | HTTP Status | Notes |
|---|---|---|---|

### Feature Matrix
| Route | Element | Type | Expected Behavior |
|---|---|---|---|

### API Call Inventory
| Trigger | Method | Path | Expected Response Shape |
|---|---|---|---|

### Pre-Test Findings
- <critical findings before testing begins>

### Missing Verification Capabilities
- <any test type that cannot run due to environment constraints>
```

Do NOT begin testing until the audit is written.

---

## Sub-stage 2 — TEST

### Step 5 — Execute the test matrix

Run every route in the sitemap and every interaction in the feature matrix.
Use the named test types — do not improvise.

| Type | Tests | Proof required |
|---|---|---|
| `page-load` | route renders, no console errors, no 4xx/5xx calls | screenshot + network log summary |
| `nav-link` | every sidebar / header link resolves to non-404 | HTTP status + screenshot of destination |
| `dropdown-populate` | dropdown options present after page load | option count + option values in assertion |
| `filter-apply` | filter changes the displayed data | before screenshot + after screenshot + API call diff |
| `form-submit` | form produces the expected state change | success indicator screenshot + persisted state on reload |
| `file-upload` | upload flow completes end-to-end | dialog-closed screenshot + new asset rendered + persists on reload |
| `api-response` | API returns the expected shape with non-empty data | response body diff against expected schema |
| `empty-state` | component handles zero-data correctly | screenshot of empty state with correct copy |
| `error-state` | component handles API failure or invalid input | screenshot of error state with correct messaging |

### Step 6 — Run the PRD's E2E test (when applicable)

If `[prd: <id>]` is in `$ARGUMENTS` and the PRD has an "E2E Usability Test"
section, execute that exact flow end-to-end. The test specifies start point,
user actions, and the success state. Capture a screenshot at each named step
and at the success assertion.

The PRD's E2E test failing for any reason is a CRITICAL failure even if every
test in Step 5 passed. The PRD's E2E represents the user's golden path; the
generic matrix represents coverage hygiene.

### Step 7 — Three-gate quality check

- **Gate 1 (Syntax):** audit report exists; every route in the sitemap has at least one test result; every result has screenshot path, API summary (where applicable), and pass / fail assertion.
- **Gate 2 (Evidence):** no PASS verdict has a missing screenshot or API summary; no section is blank or marked "not tested" without a logged capability gap.
- **Gate 3 (Quality):** dispatch `god-developer` to review the full report — coverage completeness, evidence quality, failure specificity, data-trust appropriateness.

If `god-developer` rejects, revise once. If revision is also rejected, write
`status: STALLED` with `reason: verify-rejected`.

### Step 8 — Tear down the dev server

```bash
pkill -f "bun.*dev|node.*dev|next.*dev|vite|webpack" 2>/dev/null || true
```

---

## Output format

Write `$ARTIFACTS_DIR/review-frontend.md`:

```markdown
---
stage: review-frontend
project: <project name>
status: complete | STALLED
completed_at: <ISO timestamp>
---

## Validation Result
PASS | ISSUES FOUND | STALLED

## QA Report

### Coverage Summary
- Routes tested: {n} / {total in sitemap}
- Features tested: {n} / {total in feature matrix}
- API contracts tested: {n} / {total in API inventory}
- PRD E2E test: PASS | FAIL | N/A

### Results
| Route | Test Type | Element | Result | Evidence |
|---|---|---|---|---|

### Failures (prioritized)
#### [F1] CRITICAL — <route> <element>
**Test type:** <type>
**Expected:** <what should happen>
**Actual:** <what actually happened>
**Evidence:** <screenshot path, API response>
**Classification:** <root cause classification>

### Gate Results
- Gate 1 (Syntax): PASS | FAIL
- Gate 2 (Evidence): PASS | FAIL
- Gate 3 (Quality): PASS | FAIL | REVISION REQUIRED

## Issues for Downstream Stages
<issues for Simplify / Harden, or "None">
```

**Issues are documented but NOT blocking** — always write `status: complete`
unless STALLED. Simplify and Harden will read this and address findings.

---

## Rules

- Do NOT commit.
- Do NOT ask the human.
- Do NOT run `/simplify`, `/harden`, or security review — those are later stages.
- Always complete with `status: complete` (or STALLED on verify-rejected).
- No self-certification — PASS requires screenshot evidence or API response observation.
- Tear down the dev server before exiting.
- Write both output files when done — that signals completion.
