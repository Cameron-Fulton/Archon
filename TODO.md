# Archon (Cameron-Fulton fork) — TODO

> Project-level work tracker. One concern per item. Use checkboxes; `[skip: ...]` flags route around irrelevant pipeline stages.

## Strategy

- [ ] Strategy: Cameron-Fulton/Archon fork drift. Tracking upstream coleam00/Archon produced a 24-commit gap in one work session (CI red on PR #1 due to upstream prettier issues in AGENTS.md/CONTEXT.md that we don't touch). Decide: (a) upstream the generic pieces (kanban backend), (b) hard-fork — stop tracking upstream, cherry-pick selectively, (c) schedule weekly upstream-merge cron. Default if undecided: (b). Our `.archon/` slash-commands and kanban-orchestrator integration are SearchActions-specific and won't be accepted upstream. [serial]
