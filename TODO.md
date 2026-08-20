# Archon (Cameron-Fulton fork) — TODO

> Project-level work tracker. One concern per item. Use checkboxes; `[skip: ...]` flags route around irrelevant pipeline stages.

## Strategy

- [ ] Strategy: Cameron-Fulton/Archon fork drift. Tracking upstream coleam00/Archon produced a 24-commit gap in one work session (CI red on PR #1 due to upstream prettier issues in AGENTS.md/CONTEXT.md that we don't touch). Decide: (a) upstream the generic pieces (kanban backend), (b) hard-fork — stop tracking upstream, cherry-pick selectively, (c) schedule weekly upstream-merge cron. Default if undecided: (b). Our `.archon/` slash-commands and kanban-orchestrator integration are SearchActions-specific and won't be accepted upstream. [serial]

## Machine-generated findings (triage; not queued)

- Server test `GET /api/commands > includes bundled commands with source:bundled` (`packages/server/src/routes/api.workflows.test.ts:1441`) fails on this machine: a user-global `archon-assist` command in ARCHON_HOME shadows the bundled one, so `source` is `global` not `bundled`. Verified to fail identically on a pristine `v0.9.0` checkout, so it is upstream/environmental, not fork drift. Fix = isolate ARCHON_HOME in the test.
- `bun run validate` cannot complete on Windows: `scripts/test-install.sh` exits with "Windows is not supported. Please use WSL2". Every other gate step (capability matrix, type-check, eslint, prettier) passes. Fix = skip `test:install` off-Linux, or run validate under WSL2.
- Archon is absent from the dev-system orchestrator's project registry and has no `project-kb/` directory, unlike sibling projects. Not paused and not disabled — simply never registered. Fix = run the reconciler for this project.
- CI job "Run marketplace auto-review" fails on every PR in this fork and cannot pass. It runs Claude against marketplace submissions and the fork has no Anthropic credential (`Not logged in · Please run /login`); `.archon/scripts/marketplace-fetch-source.ts:38` then throws on an undefined `sourceUrl` because our PRs are not marketplace submissions. Upstream automation that does not apply to us. Fix = disable the workflow in the fork, or gate it on the marketplace label.
