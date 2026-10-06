# TASK-901 — Web Factory TypeScript Cloud Foundation & Identity Model

Status: **TODO**

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
