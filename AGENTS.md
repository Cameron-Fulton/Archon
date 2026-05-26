# Agent Instructions — Archon

1. Read D:/SYSTEM.md before starting any work.
2. Read CLAUDE.md for project-specific context.
3. Check D:\projects\dev-system\_system\incidents\INCIDENT-LOG.md before debugging.
4. Check D:\projects\dev-system\_system\knowledge\INDEX.md before building integrations.
5. If you discover a reusable pattern, gotcha, or solution: write it to D:\projects\dev-system\_system\librarian\intake\ (see SYSTEM.md for format).
6. Do not create files or folders outside the defined structure.
7. **Git safety:** NEVER push to upstream (coleam00/Archon). Only push to SearchActions/ or Cameron-Fulton/ forks. Run `git remote -v` before every push.
8. **Test isolation:** Never run bare `bun test` from repo root — always use `bun run test` to avoid mock.module() pollution across packages.
