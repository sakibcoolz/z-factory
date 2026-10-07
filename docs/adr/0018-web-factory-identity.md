# ADR-0018 — Web Factory Identity, Sign-in and Data Ownership

Status: **ACCEPTED** (TASK-901, 2026-10-07)

## Context
Web Factory (Phase 09) is the cloud application that shows what the Z-Factory Thin Client Agents send over MQTT and that will send commands back to them. Unlike Z-Factory, which runs in single-owner mode behind a trusted network (ADR-0007), Web Factory is internet-facing, serves several people per organization and needs roles.

## Decision
1. **Separate application in this repository.** It lives in `apps/web-factory/`, a Next.js app with its own package, lockfile, lint, tests and build. It imports no Z-Factory code. Contracts it shares with the edge, such as the edge deployment file and later the MQTT messages, are its own typed copies, checked strictly.
2. **Own database.** It uses PostgreSQL database `web_factory` (tests `web_factory_test`) with its own Prisma schema and migrations, and shares no table with Z-Factory. Edge identities are stored by their external ids, as the agents name them. It may move to its own server without code changes.
3. **Sign-in:** Auth.js (`next-auth` 5, pinned beta) with e-mail and password.
   - Users live in Web Factory's database. Passwords are hashed with Node's scrypt (N=2^15, r=8, p=1), with the parameters stored with each hash.
   - A failed sign-in never reveals whether the e-mail exists, and five failures lock the account for 15 minutes.
   - The first organization and admin come from a bootstrap script that reads the password from a file.
4. **Sessions.** With credentials sign-in, Auth.js issues signed-cookie (JWT) sessions only.
   - The cookie carries the user id and a session version and lives at most 8 hours.
   - Every request checks both against the database, so disabling a user, or changing their role or password, ends their sessions at once.
5. **Authorization:** one membership per user and organization, with roles VIEWER < OPERATOR < ADMIN (`lib/auth/roles.ts`).
   - Viewers see; operators also send commands (TASK-905); admins also manage sites, agents, PLC registrations and users.
   - Every service call checks the membership. Another organization's data is NOT_FOUND, never FORBIDDEN, so other tenants cannot be probed.
   - An organization always keeps an admin.
6. **MQTT stays on the server.** Broker settings come from server environment variables, with the password in a file. No variable is public and no browser code gets a broker connection or credential.

## Consequences
- Registering a PLC means uploading the edge deployment file its agent runs. Web Factory verifies the checksum and the command allow-list and never reaches a PLC.
- Single sign-on (OIDC) is not built. Auth.js can add a provider later; that would need a new decision on how roles map.
- `next-auth` 5 is still published as a beta. It is pinned to an exact version and must be reviewed before production.
