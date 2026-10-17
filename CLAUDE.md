# Archon

> Read D:/SYSTEM.md first. It overrides everything below.

## Stack
TypeScript, Bun, Hono, SQLite (default) / PostgreSQL, React (Vite + Tailwind v4 + shadcn/ui), Zod + OpenAPI, Docker

## Commands
```bash
bun run dev          # Start server + web UI together (hot reload)
bun run dev:server   # Backend only (port 3090)
bun run dev:web      # Frontend only (port 5173)
bun run build        # Build all packages
bun run test         # Run all tests (per-package isolation — NEVER use bare `bun test`)
bun run type-check   # TypeScript checks
bun run lint         # ESLint (zero warnings)
bun run validate     # Full pre-PR gate: type-check + lint + format + test
```

## Dev Drive Integration
- **Upstream:** https://github.com/coleam00/Archon.git
- **Type:** Fork/clone — check `git remote -v` before any push
- **NEVER push to upstream.** Only push to a SearchActions or Cameron-Fulton fork.

## Active Work
None currently.

## Knowledge
Before planning or building, read `.knowledge/APPLICABLE.md` — it lists every known landmine in this project's stack. Auto-maintained by the librarian on every intake promotion and every two hours. If the file is missing or the `generated:` timestamp is more than a day old, the knowledge refresh pipeline is broken — file an incident.
Agent rules: read @AGENTS.md
