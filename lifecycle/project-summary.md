# Project Summary — Archon

**Stack:** TypeScript, Bun, Hono, SQLite/PostgreSQL, React (Vite + Tailwind v4 + shadcn/ui), Zod + OpenAPI, Docker
**Description:** AI agentic harness creator — control Claude Code SDK and Codex remotely from Slack, Telegram, GitHub, and web UI. Makes AI coding deterministic and repeatable via YAML workflows.
**Upstream:** https://github.com/coleam00/Archon.git
**Created:** 2026-04-11
**Status:** Cloned from upstream, dev drive scaffolding applied

## System Architecture

Bun monorepo with 9 packages: paths → git → isolation/workflows → core → adapters → server/cli/web.
Workflow engine uses YAML DAG definitions executed by a TypeScript executor.
Platform adapters (Slack, Telegram, GitHub, Discord, Web) share a unified IPlatformAdapter interface.
SQLite by default; PostgreSQL optional for heavy parallel workloads.

## Recent Learnings

(None yet.)

## Open Risks

- Upstream git remote must never be pushed to — always verify `git remote -v` before push.
- Bun mock.module() has process-global scope — never run `bun test` from repo root.
