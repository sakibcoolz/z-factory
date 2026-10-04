# TASK-103 — Factory CRUD

Status: **READY**
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

## Open decision before implementation
"Authorization boundary exists" needs an owner identity, and no document names an authentication provider. `Factory.ownerId` is an opaque string and `factoryRepository` already scopes every query by owner. The owner must choose how `ownerId` is obtained (for example a single local development owner behind one `requireActor()` seam, or a real provider) and record it in an ADR before this task starts.

## Available from TASK-102
`factoryRepository` (owner-scoped create/list/find/update/delete), `factoryInputSchema` (name, slug, private canonical subnet), constraint-to-domain-error translation, and the Factories / Create Factory screens from TASK-104 that currently read `lib/fixtures/factories.ts`.
