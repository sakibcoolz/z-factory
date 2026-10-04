# TASK-103 — Factory CRUD

Status: **DONE**
Linear: [ZFA-6](https://linear.app/recruit-verse/issue/ZFA-6)

## Objective
Implement factory list/create/view/edit/delete using SSR/server actions or route handlers.

## Acceptance criteria
- Authorization boundary exists.
- Factory name/subnet fields validated.
- Desired configuration is separate from runtime state.
- Loading/error/empty states exist.
- Tests cover validation and persistence.
- Docker is not started by CRUD operations.

## Decision
Owner identity: single-owner mode behind `requireActor()` — ADR-0007, accepted by the owner on 2026-10-05.

## Evidence (2026-10-04)
- Authorization boundary: `lib/auth/actor.ts`; every action and data-loading page calls `requireActor()` first. Production refuses all factory operations without `LOCAL_OWNER_ID`. Foreign factories read as not found.
- Validation: `factoryInputSchema` / `factoryUpdateSchema` (name, slug, private canonical subnet /16–/28); subnet overlap rejected in the service and by the `Factory_subnet_no_overlap` database constraint (migration `factory_subnet_no_overlap`).
- Desired configuration vs runtime state: CRUD writes `status`-side fields only and never `runtimeStatus`; the overview shows both separately. Subnet change and delete are refused unless the factory is `STOPPED`.
- States: `app/factories/loading.tsx`, `app/factories/error.tsx` (no internal detail shown), first-run welcome as the empty state, not-found for unknown/foreign/malformed ids, per-field and form-level errors on the form.
- Docker: no Docker code exists or is called; created factories are `DRAFT` / `STOPPED` and only record a `FACTORY_CREATED` event.
- Screens: `/factories` (list or welcome), `/factories/new`, `/factories/[factoryId]`, `/factories/[factoryId]/edit`. The fixture list and the `/welcome` route are removed; fixture screens stay reachable from the explorer's "Design fixtures" section.
- Tests: 145 pass in total. Factory CRUD adds 13 PostgreSQL integration tests (service and server actions), 18 page/component tests and 12 unit tests (owner resolution, subnet arithmetic, form-state mapping).
- End to end in headless Chromium against `next start`: empty state → create with an invalid subnet (field error, input kept) → create → overview → list → edit → delete with confirmation → empty state; no console errors.
- `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build` pass locally and in CI on PR #2.

## Known limits
- Single-owner mode does not authenticate the browser user (see ADR-0007 and `docs/security.md`).
- With the streaming loading state, a not-found factory renders the not-found screen with HTTP 200 (Next.js behavior once the shell has streamed).
- Differences from wireframe 2c are listed in `docs/design.md`.
