# TASK-101 — Bootstrap Next.js

Status: **DONE**
Linear: [ZFA-4](https://linear.app/recruit-verse/issue/ZFA-4)

## Objective
Create the single Next.js TypeScript application according to Phase 00 bootstrap specification.

## Instructions for AI agent
- Read `AGENTS.md` and all mandatory docs.
- Use App Router and strict TypeScript.
- Preserve server/client boundaries.
- Add environment template and quality scripts.
- Do not add Docker feature behavior in this task.

## Acceptance criteria
- Project boots locally.
- Typecheck, lint, test commands exist and pass.
- Server-only module convention is established.
- Directory structure matches architecture.
- Graphify is generated/refreshed after bootstrap.
- Task and Linear status are updated.

## Progress (2026-10-04)
Started together with TASK-104 at the owner's request, limited to what the UI shell needs.

Done:
- Next.js 16 App Router application at the repository root, strict TypeScript (`noUncheckedIndexedAccess` on), `@/*` path alias.
- Tailwind CSS 4 via `@tailwindcss/postcss`.
- Quality scripts: `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` — all pass.
- Directory structure per `docs/architecture.md`: `app/`, `components/`, `lib/domain/`, plus `lib/navigation/` and `lib/fixtures/`.
- Graphify graph generated (`graphify update .`).

## Completion (2026-10-04)
- Environment template `.env.example` and validated contract `lib/env.ts` (names only in errors, never values).
- Server-only convention: `server-only` in `lib/env.ts`, `lib/db/**`, `lib/services/**`; ESLint blocks `components/**` from importing them; Vitest stubs `server-only`.
- Formatter: Prettier (`npm run format`, `npm run format:check`).
- Local database: `compose.yaml` (PostgreSQL 17 on 127.0.0.1) with `npm run db:up`.
- CI baseline: `.github/workflows/ci.yml` (format check, lint, typecheck, migrations, tests, build). Written to the specification; it has not run on GitHub yet because nothing is pushed.
- Validation: `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test` (109 tests) and `npm run build` pass locally.
- Graphify refreshed.
