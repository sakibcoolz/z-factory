# Web Factory

The Phase 09 cloud application (ADR-0018). It receives what Z-Factory Thin Client Agents send over MQTT (docs/thin-client-agent.md), shows it, and will send commands back. It never replaces PLC logic (ADR-0015): commands reach command and setpoint tags only, and the PLC program decides. Code: `apps/web-factory/`.

| Task | Scope | Status |
|---|---|---|
| TASK-901 | foundation: app, sign-in, roles, identity model, PLC registration, health | done |
| TASK-902 | MQTT broker integration, agent onboarding, connectivity | planned |
| TASK-903 | telemetry ingestion, persistence, latest state | planned |
| TASK-904 | monitoring dashboards, events, alarms | planned |
| TASK-905 | remote command and setpoint lifecycle | planned |
| TASK-906 | production edge deployment, physical E2E | planned |

## Identity model
| Model | What it is |
|---|---|
| `Organization` | a tenant; everything belongs to one |
| `User`, `Membership` | a person who signs in, and their role in an organization: VIEWER, OPERATOR or ADMIN |
| `Site` | a plant location. `siteKey` is the site id in the agents' MQTT topics (`zfactory/{siteKey}/…`), so it is unique across the broker |
| `EdgeAgent` | a Thin Client Agent at a site. `agentKey` is its agent id in the topics, unique per site; it has a status and a last-seen time (TASK-902) |
| `Factory` | a Z-Factory factory as the deployments name it (`site.factoryId`), per site |
| `Plc`, `PlcMapping` | a PLC an agent runs, registered from its deployment file, with its tags (READ, or WRITE for command and setpoint tags) and their ranges: the cloud's copy of the allow-list |
| `Module`, `PlcModule` | process modules a PLC carries signals of |
| `AuditEvent` | who did what: sign-ins and refusals, users and roles, sites, agents and PLC registrations |

## Registering a PLC
An admin uploads the PLC's edge deployment file on its agent's page; it is the same file the agent runs, from Z-Factory → PLC → Export → *Edge deployment (JSON)*. Web Factory then:
- checks the file strictly (`lib/domain/edge-deployment.ts`);
- recomputes the checksum over the compact JSON of `deployment`, so any edit after export is refused;
- refuses a writable tag that is not a command or setpoint of external command memory on a coil or holding register.

Registration is refused for:
- an older version (`stale-config`);
- the same version with other content (`config-version-reused`);
- a PLC another agent of the organization runs (`plc-elsewhere`);
- a factory registered at another site (`factory-site`).

A newer version replaces the tags and modules. Uploading the same version again changes nothing.

## Sign-in and sessions
- **Sign-in:** e-mail and password, through Auth.js credentials (`auth.ts`).
- **Session:** a signed cookie of at most 8 hours that carries the user id and session version, checked against the database on every request (`lib/auth/session.ts`).
- **Revocation:** disabling a user, or changing their role or password, raises the session version, which ends every session of theirs.
- **Lockout:** five failed sign-ins lock the account for 15 minutes. The message never says whether the e-mail exists.
- **Passwords:** 12 to 256 characters, hashed with scrypt.
- **Security headers:** every response carries `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin` and a restrictive `Permissions-Policy`.

## Screens
| Path | Who | What |
|---|---|---|
| `/login` | anyone | sign in |
| `/orgs/{id}` | members | sites with agent, PLC and factory counts; admins create sites |
| `/sites/{id}` | members | agents with status and PLCs; admins register agents |
| `/agents/{id}` | members | agent id, topic root, PLCs with version and writable count; admins upload deployment files |
| `/plcs/{id}` | members | factory, PLC id, configuration version and checksum, Modbus endpoint, modules, tags with access and range |
| `/orgs/{id}/users` | admins | members, roles, enable/disable, add users, the audit log |
| `/account` | members | change one's own password; this ends one's sessions |

Something the actor cannot see, or that belongs to another organization, is a 404.

## Operations
- `GET /api/health`: liveness.
- `GET /api/ready`: the database answers and has the schema (503 otherwise).
- Logs: JSON lines on stdout (`lib/log.ts`); no password or secret is ever logged.
- Environment (`lib/env.ts`, `.env.example`):
  - `WEB_FACTORY_DATABASE_URL` and `AUTH_SECRET` (32 characters or more);
  - `AUTH_URL` or `AUTH_TRUST_HOST` behind a proxy;
  - `WEB_FACTORY_MQTT_URL`, `…_USERNAME`, `…_PASSWORD_FILE`, `…_CA_FILE`. The broker URL may not hold credentials.
- First admin: `WEB_FACTORY_ADMIN_PASSWORD_FILE=… npm run create-admin -- --org … --slug … --email … --name …`. It is refused once any user exists.

## As built (TASK-901)
The app, the identity model and migration `identity_foundation`, sign-in, roles, PLC registration, health, the MQTT boundary (`lib/mqtt/boundary.ts`: settings and topic roots only; the client is TASK-902), and CI steps.

Tests (`npm test`; integration tests use `WEB_FACTORY_TEST_DATABASE_URL`):
- Unit: password hashing, the role order, the environment rules, the deployment contract.
- Identity: bootstrap once; neutral refusals and lockout; adding users and the role limits of viewers and operators; tenant isolation; sessions ending on a role change, disable or password change; the last admin kept.
- Registration:
  - topic-segment ids, unique across organizations;
  - a PLC registered with its tags, allow-list and modules;
  - the same version unchanged;
  - refused: a tampered file, wrong JSON or schema, a writable program output, an older or reused version, a viewer, another agent's PLC, a factory of another site;
  - an update to a newer version, and the audit trail.
