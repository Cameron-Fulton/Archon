# Archon (Cameron-Fulton fork) — TODO

> Project-level work tracker. One concern per item. Use checkboxes; `[skip: ...]` flags route around irrelevant pipeline stages.

## Strategy

- Fork drift: RESOLVED. The fork carried a kanban board (~950 lines) and a 17-command dev-pipeline (~2,900 lines); both were removed once the board was found to have no consumer — the dispatcher meant to poll it was never built — and the pipeline was found to duplicate dev-system's own stages while instructing a banned hand-edit of the generated incident log. What remains is this file plus `AGENTS.md` / `CLAUDE.md` / `CONTEXT.md`, a few `.gitignore` lines, and `lifecycle/`. Every source file is now byte-identical to upstream, so tracking upstream costs nothing and the hard-fork option is moot. Merge upstream releases directly.

## Machine-generated findings (triage; not queued)

- Server test `GET /api/commands > includes bundled commands with source:bundled` (`packages/server/src/routes/api.workflows.test.ts:1441`) fails on this machine: a user-global `archon-assist` command in ARCHON_HOME shadows the bundled one, so `source` is `global` not `bundled`. Verified to fail identically on a pristine `v0.9.0` checkout, so it is upstream/environmental, not fork drift. Fix = isolate ARCHON_HOME in the test.
- `bun run validate` cannot complete on Windows: `scripts/test-install.sh` exits with "Windows is not supported. Please use WSL2". Every other gate step (capability matrix, type-check, eslint, prettier) passes. Fix = skip `test:install` off-Linux, or run validate under WSL2.
- Archon is absent from the dev-system orchestrator's project registry and has no `project-kb/` directory, unlike sibling projects. Not paused and not disabled — simply never registered. Fix = run the reconciler for this project.
- CI job "Run marketplace auto-review" fails on every PR in this fork and cannot pass. It runs Claude against marketplace submissions and the fork has no Anthropic credential (`Not logged in · Please run /login`); `.archon/scripts/marketplace-fetch-source.ts:38` then throws on an undefined `sourceUrl` because our PRs are not marketplace submissions. Upstream automation that does not apply to us. Fix = disable the workflow in the fork, or gate it on the marketplace label.
