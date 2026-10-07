# Web Factory

The Phase 09 cloud application (ADR-0018). It receives what Z-Factory Thin Client Agents send over MQTT (docs/thin-client-agent.md), shows it, and will send commands back. It never replaces PLC logic (ADR-0015): commands reach command and setpoint tags only, and the PLC program decides. Code: `apps/web-factory/`.

| Task | Scope | Status |
|---|---|---|
| TASK-901 | foundation: app, sign-in, roles, identity model, PLC registration, health | done |
| TASK-902 | MQTT broker integration, agent onboarding, connectivity | done |
| TASK-903 | telemetry ingestion, persistence, latest state | done |
| TASK-904 | monitoring dashboards, events, alarms | done |
| TASK-905 | remote command and setpoint lifecycle | done |
| TASK-906 | production edge deployment, physical E2E | planned |

## Identity model
| Model | What it is |
|---|---|
| `Organization` | a tenant; everything belongs to one |
| `User`, `Membership` | a person who signs in, and their role in an organization: VIEWER, OPERATOR or ADMIN |
| `Site` | a plant location. `siteKey` is the site id in the agents' MQTT topics (`zfactory/{siteKey}/…`), so it is unique across the broker |
| `EdgeAgent` | a Thin Client Agent at a site. `agentKey` is its agent id in the topics, unique per site; it holds what the agent last reported (status, heartbeat, version), when Web Factory last heard from it live, and its broker client's user name, client id and issue/revoke times (never the password) |
| `AgentConnectionEvent` | a change of an agent's reported status, recorded once when Web Factory sees it |
| `Factory` | a Z-Factory factory as the deployments name it (`site.factoryId`), per site |
| `Plc`, `PlcMapping` | a PLC an agent runs, registered from its deployment file, with its tags (READ, or WRITE for command and setpoint tags) and their ranges: the cloud's copy of the allow-list. `edgeState` and the other `edge…` fields are its worker's state as the agent last reported it |
| `Module`, `PlcModule` | process modules a PLC carries signals of |
| `TagLatest` | the newest value of each tag of a PLC, by the tag's external id, with the quality the agent sent |
| `PlcEvent` | a change of a PLC's reported connection state, or of a tag's quality, recorded once |
| `telemetry.batch`, `telemetry.sample` | the history (outside Prisma, partitioned by day): one row per poll, one per tag per poll |
| `Alarm` | an alarm: source, severity, message, raised, cleared and acknowledged (by whom); `activeKey` while active |
| `Command` | a command or setpoint: who, which tag, the value, the configuration version, its status with rule and reason, the agent's read-back, and its times |
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

## Broker and agent onboarding
ADR-0019. The broker is Mosquitto 2 with Dynamic Security (`apps/web-factory/broker/mosquitto.conf`). Web Factory keeps one server-side MQTT 5 connection and uses it both to read what agents publish and to administer the agents' broker clients.

Onboarding an agent:
1. An admin registers the agent on its site page with the agent id it runs with.
2. On the agent's page, *Issue credentials* creates its broker client:
   - user name `agent:{site}:{agent}`, bound to client id `zfactory-agent-{site}-{agent}`;
   - a role that allows only its own topics: publishing telemetry, state, ack, heartbeat and status, and subscribing to commands.
3. The password is shown once, with the agent's settings (`ZFACTORY_AGENT_MQTT_URL`, `…_SITE_ID`, `…_ID`, `…_MQTT_CLIENT_ID`, `…_MQTT_USERNAME`, `…_MQTT_PASSWORD_FILE`). Web Factory never stores it.
4. *Issue a new password* rotates it and disconnects the agent until it restarts with the new file. *Revoke* disables the client: the agent is disconnected and refused.

If the broker cannot be reached, nothing changes. Every step can be repeated.

## Connectivity
`lib/mqtt/ingest.ts` applies each agent's messages in order:
- **Status:** `agent/status` sets the reported status. A change is recorded once as a connection event, timed by Web Factory.
- **Heartbeat:** `agent/heartbeat` stores the counters and marks the agent online. A heartbeat queued behind another is replaced by the newer one.
- **PLC state:** `state/{plcId}` stores the worker's state. An empty retained message marks the PLC `REMOVED`.
- **Telemetry and acks:** they only refresh last-seen, at most every 5 s; storing them is TASK-903 and TASK-905.
- **Retained messages:** the broker's latest word, applied but never counted as the agent being seen.
- **Dropped messages,** counted by reason: a topic that is not an agent topic, a body naming another agent, an unregistered agent or PLC, revoked credentials, malformed JSON, more than 1 MiB.

The pages project connectivity from this with the heartbeat interval (`WEB_FACTORY_AGENT_HEARTBEAT_S`, 10 s by default):

| State | When |
|---|---|
| UNKNOWN | never heard from |
| ONLINE | reported online, heard from within 2.5 intervals, every PLC worker online, nothing spooled |
| DEGRADED | online, but late (2.5 to 6 intervals), a PLC worker not online, or telemetry spooled at the edge |
| OFFLINE | reported offline (or its will), credentials revoked, or silent for 6 intervals |

A PLC shows its worker's reported state while its agent is reachable, and UNKNOWN ("last reported …") while it is not.

## Telemetry
ADR-0020. The agent publishes one batch per poll of each PLC. Web Factory checks it (`lib/domain/telemetry.ts`) and offers it to the pipeline (`lib/telemetry/pipeline.ts`). Fixed writers store it with `lib/telemetry/store.ts`:
- **Duplicates:** a batch is identified by its PLC and poll time. A redelivered or replayed batch is a duplicate and changes nothing.
- **History:** one row per tag per poll in `telemetry.sample`, in day partitions created as needed. Partitions older than the retention (30 days by default) are dropped whole. Batches past the retention, or from more than 10 minutes in the future, are refused.
- **Latest values:** a value replaces a tag's latest value only when it is newer. Pages project quality as:
  - DISCONNECTED while the PLC's reported connection is not up (or its agent is unreachable);
  - STALE when the value was not refreshed for 3 poll intervals;
  - otherwise what the agent sent: GOOD or BAD.
- **Events:** tag quality changes and PLC connection changes.
- **Not stored:** values of tags that are not registered, and batches of unregistered PLCs, are counted and skipped.
- **Bounds:** 2 writers by default, PLCs split between them, each queue a share of 10,000 batches. When a queue is full, its oldest batch is dropped and counted.
- **Broker session:** Web Factory's is persistent, so the broker keeps what agents publish while Web Factory is away.

API (JSON over the signed-in session; 401 without one, 404 for what the actor cannot see, 400 for a bad query):

| Path | What |
|---|---|
| `GET /api/v1/plcs/{id}/latest` | the PLC's tags with value, reported and projected quality, and time |
| `GET /api/v1/latest?organizationId=…` (or `siteId`, `agentId`) | the same for every PLC in scope |
| `GET /api/v1/plcs/{id}/history?tag=…&from=…&to=…&limit=…` | a tag's samples, oldest first; by default the last hour; at most 31 days and 10,000 points |
| `…&bucket=<seconds>` | the same in buckets: count, min, max, avg, last value, worst quality |
| `GET /api/v1/plcs/{id}/events?from=…&to=…&kind=PLC_STATE\|TAG_QUALITY` | state and quality changes, newest first |
| `GET /api/v1/agents/{id}/connections?from=…&to=…` | the agent's reported status changes |
| `GET /api/v1/alarms?organizationId=…&state=active\|history` | alarms, narrowed by `siteId`, `agentId` or `plcId`; the history takes `from`, `to` and `limit` |
| `GET /api/v1/live?scope=…` | the live view of a scope as server-sent events (TASK-904) |
| `GET /api/v1/plcs/{id}/commands?limit=…` | the PLC's recent commands, newest first (TASK-905) |
| `GET /api/v1/commands/{id}` | one command: who, what, status, the agent's answer, telemetry confirmation |

## Monitoring and alarms
ADR-0021.

**Alarms** (`lib/domain/alarms.ts`, `lib/alarms/engine.ts`): a sweep every 3 s raises and clears them.

| Source | Severity | Active while |
|---|---|---|
| PLC alarm tag (role ALARM) | high | its last value is true, whatever its quality now |
| PLC connection | high | its agent is reachable and reports it disconnected or reconnecting |
| Agent | medium | the agent is offline or degraded (never heard from or revoked: none) |

- **Connection alarms** are judged only after Web Factory has been connected to the broker for 2.5 heartbeat intervals.
- **Acknowledgement:** operators and admins acknowledge, once, and it is audited. An alarm stays on the active list until it is cleared and acknowledged.

**Live updates:** `GET /api/v1/live?scope=plc:|agent:|site:|org:<id>` is a server-sent event stream.
- Every 1.5 s it builds the scope's view from the database, checked against the actor, and sends it when it changed.
- It checks the session every 15 s.
- Pages show *live* or *reconnecting*.

**Charts:** built-in SVG on the tag page, for 15 min to 30 days.
- Up to about 300 buckets: the average with a min/max band, or a step line for booleans.
- Buckets of poor quality are shaded; gaps break the line.
- The two short ranges refresh every 5 s.

## Commands and setpoints
ADR-0022.
- **Where:** an operator or admin sends one from the PLC page, on a writable command tag (on/off) or setpoint (a number in its range); viewers get no controls.
- **Checks before publishing:** Web Factory checks the tag against the registered deployment (WRITE, COMMAND or SETPOINT, EXTERNAL_COMMAND), the value's type and range, and that the agent is reachable with valid credentials. A refusal is recorded as REJECTED and audited, and never published.
- **Publishing:** a command goes with QoS 1 to `zfactory/{site}/{agent}/command/{plc}`. It expires after 60 s and carries the user's id, never an e-mail.
- **At the edge:** the agent checks it again against its own deployment, writes once, reads back and answers.

| Status | Meaning |
|---|---|
| REQUESTED, PUBLISHED | checked and handed to the broker |
| ACCEPTED | the agent's allow-list took it; the write is queued |
| APPLIED | written and read back (shown); telemetry then confirms the value |
| REJECTED | refused by Web Factory or by the agent, with the rule |
| FAILED | the write failed, or the broker could not take the command |
| TIMED_OUT | no final answer 10 s after expiry (a late answer is still taken, marked late) |

- **No double actuation:** the same form sent twice is one command. A redelivered command is answered again by the agent, marked duplicate, and counted, never written again.
- **Broker right:** Web Factory gives its own broker client the role `web-factory-commands`, which allows publishing commands and nothing else.

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
| `/orgs/{id}` | members | active alarms by severity; sites with agent, PLC and factory counts and agents per connectivity state; admins create sites and see the broker connection |
| `/orgs/{id}/alarms` | members | active and unacknowledged alarms (live), the history of 24 h, 7 or 30 days; operators and admins acknowledge |
| `/sites/{id}` | members | agents with connectivity, last seen and PLCs, and the site's alarms (live); factories; admins register agents |
| `/factories/{id}` | members | the factory's modules and PLCs |
| `/modules/{id}` | members | the PLCs that carry the module's signals |
| `/agents/{id}` | members | status, heartbeat, PLC connections and alarms (live); the connection history; admins issue, rotate and revoke broker credentials and upload deployment files |
| `/plcs/{id}` | members | factory and module links, PLC id, configuration, Modbus endpoint; tags with value, quality and age, recent commands, and the PLC's alarms (live); operators and admins send commands and setpoints; the last week's events |
| `/plcs/{id}/tags/{tag}` | members | the live value, quality and age; the history chart; quality changes; the last samples |
| `/orgs/{id}/users` | admins | members, roles, enable/disable, add users, the audit log |
| `/account` | members | change one's own password; this ends one's sessions |

Something the actor cannot see, or that belongs to another organization, is a 404. While Web Factory is not connected to the broker, the pages say statuses may be out of date.

## Operations
- `GET /api/health`: liveness.
- `GET /api/ready`: the database answers and has the schema (503 otherwise). It also reports `mqtt` (`connected`, `disconnected`, `not-configured`) and `telemetry` (`ok`, or `backlogged` above 80 % of the queue), without failing readiness.
- Broker connection: logged on connect and loss. A `broker stats` line every minute carries:
  - the connection and ingest counters (received, applied, coalesced, transitions, errors, drops by reason);
  - the telemetry counters (offered, queued, stored, duplicates, samples, events, unknown tags, version mismatches, errors, drops by reason, last write time).

  Partition changes are logged as `telemetry partitions`.
- Logs: JSON lines on stdout (`lib/log.ts`); no password or secret is ever logged.
- Environment (`lib/env.ts`, `.env.example`):
  - `WEB_FACTORY_DATABASE_URL` and `AUTH_SECRET` (32 characters or more);
  - `AUTH_URL` or `AUTH_TRUST_HOST` behind a proxy;
  - `WEB_FACTORY_MQTT_URL`, `…_USERNAME`, `…_PASSWORD_FILE`, `…_CA_FILE`, `…_CLIENT_ID`. The broker URL may not hold credentials. The account needs Dynamic Security administration and read access to `zfactory/#`;
  - `WEB_FACTORY_MQTT_AGENT_URL`: the broker as agents reach it, shown when credentials are issued (default: `WEB_FACTORY_MQTT_URL`);
  - `WEB_FACTORY_AGENT_HEARTBEAT_S`: the agents' heartbeat interval;
  - `WEB_FACTORY_TELEMETRY_RETENTION_DAYS` (30), `…_QUEUE` (10,000 batches), `…_WRITERS` (2);
  - `WEB_FACTORY_MQTT_CLIENT_ID`: by default `web-factory-<host>`. It must be different for each Web Factory process on one broker, because the session is persistent.
- Broker for development: `docker run -d --name web-factory-broker -e MOSQUITTO_DYNSEC_PASSWORD=… -p 127.0.0.1:1883:1883 -v "$PWD/broker/mosquitto.conf:/mosquitto/config/mosquitto.conf:ro" eclipse-mosquitto:2`, from `apps/web-factory`. Then point `WEB_FACTORY_MQTT_URL=mqtt://127.0.0.1:1883` at it, with user name `admin` and the same password in a file.
- First admin: `WEB_FACTORY_ADMIN_PASSWORD_FILE=… npm run create-admin -- --org … --slug … --email … --name …`. It is refused once any user exists.

## As built (TASK-901)
The app, the identity model and migration `identity_foundation`, sign-in, roles, PLC registration, health, the MQTT boundary, and CI steps.

Tests (`npm test`; integration tests use `WEB_FACTORY_TEST_DATABASE_URL`):
- Unit: password hashing, the role order, the environment rules, the deployment contract.
- Identity: bootstrap once; neutral refusals and lockout; adding users and the role limits of viewers and operators; tenant isolation; sessions ending on a role change, disable or password change; the last admin kept.
- Registration:
  - topic-segment ids, unique across organizations;
  - a PLC registered with its tags, allow-list and modules;
  - the same version unchanged;
  - refused: a tampered file, wrong JSON or schema, a writable program output, an older or reused version, a viewer, another agent's PLC, a factory of another site;
  - an update to a newer version, and the audit trail.

## As built (TASK-902)
Migration `agent_connectivity`; the message contract (`lib/domain/agent-messages.ts`), broker access (`lib/domain/broker-access.ts`) and the projection (`lib/domain/connectivity.ts`); the broker connection, Dynamic Security control and ingestor (`lib/mqtt/`); onboarding (`lib/services/onboarding-service.ts`); the screens above; the broker configuration; CI runs the broker tests with the agent binary.

Tests:
- Unit: topic parsing, the agent's message schemas, an agent's broker rights, every connectivity state and the heartbeat interval.
- Database (`test/connectivity.test.ts`):
  - online, degraded and offline from status, heartbeat, PLC state and silence;
  - a status change recorded once however often delivered, including the will;
  - retained messages never refreshing last seen;
  - removed and unknown PLCs; drops by reason;
  - last seen throttled from telemetry; heartbeat coalescing;
  - credentials: admins only, shown once and never stored or audited, rotation, nothing changed when the broker is down, revocation, client-id clashes.
- Broker, with Docker (`test/broker.test.ts`; `WEB_FACTORY_TEST_DOCKER=1`, with `AGENT_BIN` for the real agent), against a real Mosquitto with Dynamic Security:
  - onboarding; a wrong password or client id refused;
  - online from what the agent publishes;
  - every other agent's topic, `zfactory/#` and the control topic refused (reason 135), and nothing ingested;
  - Web Factory's reconnect replaying retained state without new events or a false sign of life;
  - a broker restart, then reconnects of Web Factory and the agent;
  - offline from the will;
  - the real agent online with issued credentials and offline on SIGTERM;
  - revocation disconnecting the agent and refusing it.

## As built (TASK-903)
- **Migration `telemetry_storage`:** `TagLatest`, `PlcEvent`, and the `telemetry` schema.
- **Code:**
  - `lib/domain/telemetry.ts`: contract, latest-state walk, quality projection, day keys;
  - `lib/telemetry/store.ts`: `TelemetryStore` and its PostgreSQL implementation;
  - `lib/telemetry/pipeline.ts`;
  - `lib/services/telemetry-service.ts`, `lib/api.ts`, and the `/api/v1` routes.
- **PLC page:** values, quality and events.
- **Broker:** persistent session and queue limits.

Tests:
- Unit: the agent's batch format, latest values independent of arrival order, replays changing nothing, quality projection, day keys and time limits.
- Database (`test/telemetry.test.ts`):
  - two PLCs stored from the MQTT handler on, queried raw, in buckets and by organization, site and agent;
  - a redelivered and a replayed batch stored once;
  - an older batch after a newer one leaving the latest value alone;
  - quality and PLC state changes recorded once, and stale and disconnected projected;
  - unregistered PLCs and tags, version mismatches, expired and future batches, and an identity mismatch, all counted;
  - a bounded queue dropping the oldest batches;
  - partitions dropped past the retention;
  - tenant isolation and query limits.
- End to end (`test/telemetry-e2e.test.ts`, Docker and `AGENT_BIN`): two simulated Modbus PLCs (`test/modbus-server.ts`), the real agent and a real Mosquitto:
  - a PLC deployed to the running agent is stored, and a new value reaches the latest view and the history;
  - a second PLC is added at run time;
  - a PLC that goes away shows disconnected, with the change recorded;
  - during a broker outage the agent spools; after it, the backlog is replayed and stored once, with as many samples per tag as batches.

## As built (TASK-904)
- **Migration `alarms`.**
- **Code:**
  - `lib/domain/alarms.ts` (pure) and `lib/alarms/engine.ts`, the sweep, which runs in the broker runtime;
  - `lib/services/alarm-service.ts` (lists, acknowledgement) and `lib/services/live-service.ts` (live views);
  - `/api/v1/live` and `/api/v1/alarms`;
  - client components `components/live*.tsx` and `components/telemetry-chart.tsx`;
  - pages for factories, modules, tags and alarms.

Tests:
- Unit: every alarm source; unknown kept as unknown; connectivity left unjudged while Web Factory cannot judge it.
- Database (`test/monitoring.test.ts`):
  - an alarm raised and cleared by its PLC tag, raised again as a new alarm;
  - one active alarm when three sweeps run at once;
  - connection alarms, with the agent's alarm replacing the PLC's;
  - acknowledgement by operators only, once, audited;
  - active and history lists;
  - live views of every scope for members only;
  - factory and module navigation within the tenant;
  - the live stream itself: 401, 400, 404, and a new view sent when a value changes.
- End to end (`test/telemetry-e2e.test.ts`): the real agent's alarm tag raises and clears an alarm, and a lost PLC raises its connection alarm.

## As built (TASK-905)
- **Migration `commands`.**
- **Code:**
  - `lib/domain/commands.ts` (pure): checks, envelope, acknowledgement schema, transitions;
  - `lib/services/command-service.ts`: issue, `applyAck`, `expireCommands`, lists, telemetry confirmation;
  - the ack path in `lib/mqtt/ingest.ts`;
  - `ensureServiceRole` in `lib/mqtt/dynsec.ts`;
  - `components/command-control.tsx` and the commands table.

Tests:
- Unit: the checks, the exact envelope, forward-only transitions, value matching.
- Database (`test/commands.test.ts`):
  - publishing with the exact topic and envelope;
  - every refusal recorded and audited, never published (viewer, unknown and non-writable tags, type, range, offline and revoked agent);
  - one command for a form sent twice, even at once;
  - the broker unavailable;
  - forward-only answers, counted redeliveries, refusals with the agent's rule, timeouts and late answers;
  - acks through the MQTT handler and telemetry confirmation;
  - tenant isolation.
- End to end (`test/telemetry-e2e.test.ts`, the real agent and a simulated Modbus PLC that counts writes):
  - a setpoint applied, read back and confirmed by telemetry, written exactly once;
  - its redelivery answered as a duplicate, without a second write;
  - a forged command to a status tag refused by the agent (`not-writable`);
  - a command for a newer registration refused (`stale-config-version`).

