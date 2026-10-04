# TASK-003 — Development Bootstrap Specification

Status: **DONE**
Linear: [ZFA-3](https://linear.app/recruit-verse/issue/ZFA-3)

## Objective
Define the exact Next.js project bootstrap without implementing feature code yet.

## Planned choices
- Next.js App Router
- TypeScript strict
- Tailwind CSS
- PostgreSQL + Prisma
- Zod validation
- dockerode or equivalent Docker Engine client
- React Flow
- Three.js + React Three Fiber
- testing stack to be selected during task execution

## Deliverables
Package/runtime versions, directory skeleton, environment variable contract, lint/format/test commands, Docker development prerequisites, CI baseline, Graphify project install instructions.

## Acceptance
A coding agent can bootstrap the repository without making new architectural decisions.

## Choices recorded during TASK-101/TASK-104 (2026-10-04)
- Package manager: npm (lockfile `package-lock.json`); Node.js >= 22.
- Next.js 16.3 (App Router, Turbopack), React 19.3.
- TypeScript 6.0 — pinned below 7 because `typescript-eslint` supports `<6.1`.
- ESLint 9 flat config with `eslint-config-next` — pinned below 10 because the bundled `eslint-plugin-react` fails under ESLint 10.
- Tailwind CSS 4.3 with tokens declared in `app/globals.css`.
- Testing stack: Vitest 5 + Testing Library + jsdom; tests are colocated as `*.test.ts(x)`.
- Commands: `npm run dev | build | start | lint | typecheck | test`.

## Evidence (2026-10-04)
The specification is `docs/bootstrap.md` (linked from `docs/README.md` and `AGENTS.md`): versions, directory skeleton, server-only convention, environment variable contract, commands, Docker development prerequisites, CI baseline and Graphify instructions. Formatter: Prettier 3. Database tooling: PostgreSQL 17, Prisma 7.10, Zod 4.
