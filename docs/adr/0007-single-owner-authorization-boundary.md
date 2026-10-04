# ADR 0007 — Single-Owner Mode Behind One Authorization Boundary

Status: Proposed — 2026-10-04 (implemented with TASK-103; accepted when the owner merges it)

## Context
TASK-103 requires an authorization boundary for factory operations, and `docs/security.md` requires authenticated/authorized factory operations. No document names an authentication provider, and the MVP is a single-user development platform that drives Docker on the machine it runs on.

`Factory.ownerId` already exists as an opaque string and every repository query is scoped by it.

## Decision
The MVP runs in **single-owner mode** behind one function, `requireActor()` in `lib/auth/actor.ts`.

- Every server action, route handler and page that touches factory data calls `requireActor()` first and passes the returned `Actor` (`{ ownerId }`) to the service layer. Services and repositories never read identity from anywhere else.
- The owner id comes from the `LOCAL_OWNER_ID` environment variable.
- Outside production it defaults to `local-owner`, so local development needs no setup.
- In production a missing `LOCAL_OWNER_ID` is an `UNAUTHORIZED` error for every factory operation; the application never runs unowned.

Single-owner mode identifies the owner; it does **not** authenticate the person at the keyboard. Anyone who can reach the server acts as that owner.

## Consequences
- A deployment in this mode must only be reachable by its owner: bind to localhost or put it behind a trusted network/reverse proxy that authenticates. It must not be exposed to an untrusted network.
- Ownership scoping, not-found behavior for foreign factories and the action/service boundary are already in place and tested, so adding real identity later does not change the data model.
- Introducing a real identity provider (sessions, SSO, multiple users) means replacing the body of `requireActor()` and requires a new ADR. Existing factories keep their `ownerId`; a migration maps `local-owner` to the first real user.
- Force-input, fault-injection and gateway-write authorization (Phase 02+) build on the same `Actor`.
