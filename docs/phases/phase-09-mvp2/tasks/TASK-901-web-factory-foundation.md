# TASK-901 — Web Factory TypeScript Cloud Foundation & Identity Model

Status: **DONE**
Linear: [ZFA-44](https://linear.app/recruit-verse/issue/ZFA-44)

Phase: **09 — MVP 2: Production Edge & Cloud Integration**

## Objective
Create **Web Factory** as a separate cloud-hosted TypeScript/Next.js application for monitoring and controlling Z-Factory installations through the Thin Client Agent and MQTT. Establish the application boundary, authentication/authorization, cloud identity model, deployment configuration and test foundation.

## Scope
- Next.js/TypeScript cloud app bootstrap with strict TypeScript, lint, test and build gates.
- Server-only MQTT integration boundary; browser receives no broker credentials.
- PostgreSQL/Prisma cloud persistence foundation.
- Core identities: Tenant/Organization, Site, Factory, EdgeAgent, PLC, Module and User.
- Stable external identifiers for agent/PLC correlation with exported Z-Factory JSON.
- Role/permission model for viewer/operator/admin.
- Environment/secrets validation and secure deployment configuration.
- Health/readiness endpoints and structured logging.
- CI for typecheck, lint, unit/integration tests and production build.

## Acceptance criteria
- Web Factory runs independently from Z-Factory Engineering UI and the Go Thin Client Agent.
- User authentication and authorization boundaries exist.
- A site can register an agent and its configured PLC identities without direct PLC connectivity from the browser.
- MQTT credentials remain server-side.
- PostgreSQL migrations and repository/service boundaries are defined.
- CI gates pass.

## Decisions (owner, 2026-10-07)
- **Location:** `apps/web-factory` in this repository.
- **Sign-in:** Auth.js with e-mail and password.
- **Data:** its own database `web_factory` on the same PostgreSQL server.

Recorded in ADR-0018.

## As built
Design: `docs/web-factory.md`.
- **App:** `apps/web-factory`, Next.js 16, strict TypeScript, its own lint, tests, build and lockfile; the root project ignores it. Security headers; health `/api/health`, readiness `/api/ready`; JSON logs.
- **Data:** Prisma schema and migration `identity_foundation`:
  - Organization, User, Membership(role), Site(siteKey), EdgeAgent(agentKey, status, lastSeenAt), Factory(externalFactoryId), Plc(externalPlcId, configVersion, checksum, deployment), PlcMapping(access, range), Module, PlcModule, AuditEvent.
- **Sign-in:** Auth.js credentials with scrypt and lockout. Sessions are checked against the database on every request (session version), and a bootstrap script creates the first admin from a password file.
- **Authorization:** VIEWER < OPERATOR < ADMIN per organization. Other tenants' data is a 404, and an organization keeps at least one admin.
- **Registration:** a PLC is registered from its edge deployment file, after the checksum and the allow-list are checked and versions are ordered; one agent per PLC.
- **MQTT boundary:** settings from server environment variables only, with the password in a file, and topic roots; the client is TASK-902.
- **CI:** steps for the app.

## Evidence
- `npm test` in `apps/web-factory` passes: 4 files, 15 tests (unit, identity, registration) against `web_factory_test`.
- Lint, typecheck and `next build` are clean.
- The root project's prettier, lint and typecheck are clean with `apps/` excluded.
- **Browser check** (headless Chromium, `next start` on 3211, the dev database `web_factory`, emptied afterwards):
  1. An anonymous request is redirected to `/login`; health and readiness answer; the security headers are present.
  2. A wrong password gets the neutral message. The admin signs in, creates site `north-plant` and agent `edge-1`, and uploads a real export from Z-Factory. A temporary Z-Factory factory was used and then removed.
  3. The PLC page shows the factory, PLC id, v3, the endpoint, and tags with read/writable access and ranges.
  4. A tampered file is refused for its checksum. The admin adds a viewer, and the audit log lists every step.
  5. The viewer sees no admin forms, and gets 404 for the users page and for an unknown organization.
  6. Changing a password ends the session; the old password is refused and the new one works.

## Notes
- `next-auth` 5 is a pinned beta (ADR-0018).
- `npm audit` lists high findings inside Prisma's own tooling (`deepmerge-ts`, `mysql2`), the same as the Z-Factory root. The only "fix" downgrades Prisma.
