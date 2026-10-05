# Development Bootstrap Specification

Deliverable of TASK-003. It fixes the toolchain so that a coding agent can bootstrap or extend the repository without making new architectural decisions. Changing anything here requires updating this file in the same change.

## Runtime and package versions
| Tool | Version | Note |
|---|---|---|
| Node.js | >= 22 | `engines` in `package.json`; CI uses 22 |
| Package manager | npm | lockfile `package-lock.json`; use `npm ci` in CI |
| Next.js | 16.3 | App Router, Turbopack |
| React | 19.3 | |
| TypeScript | 6.0 | strict; pinned below 7 because `typescript-eslint` supports `<6.1` |
| Tailwind CSS | 4.3 | tokens in `app/globals.css` |
| ESLint | 9 | flat config with `eslint-config-next`; pinned below 10 (bundled `eslint-plugin-react` fails on 10) |
| Prettier | 3 | formatter; config in `.prettierrc.json` |
| Vitest | 5 | with Testing Library and jsdom |
| PostgreSQL | 17 | local development through `compose.yaml` |
| Prisma | 7.10 | `prisma`, `@prisma/client`, `@prisma/adapter-pg`; pinned because npm `latest` currently points at an 8.0 release candidate |
| Zod | 4 | validation at every untrusted boundary |
| dockerode | 5 | Docker Engine API client; server-only (`lib/docker/`) |
| STruC++ | 0.7.0 | Structured Text → C++ compiler (GPL-3.0-or-later); installed from its GitHub release, run only as a separate process (ADR-0009) |
| fflate | 0.8 | builds the program upload zip |
| OpenPLC Runtime image | v4.2.4 | `ghcr.io/autonomy-logic/openplc-runtime`, pinned by digest in the image allow-list |

Planned, added by their owning tasks: React Flow (TASK-303), Three.js + React Three Fiber (TASK-402).

## Directory skeleton
```text
app/                    routes, pages, route handlers, server actions
components/             UI only; never imports server-only modules
lib/domain/             pure domain types and rules
lib/validation/         Zod schemas and domain invariants
lib/db/                 Prisma client and repositories (server-only)
lib/services/           domain services over validation + repositories (server-only)
lib/auth/               authorization boundary `requireActor()` (server-only)
lib/factories/          factory form state and formatting shared by actions and components
lib/generated/prisma/   generated Prisma client (git-ignored)
lib/env.ts              environment contract (server-only)
lib/navigation/         route builders
lib/fixtures/           temporary design fixtures (TASK-104)
lib/docker/             Docker Engine integration (server-only, TASK-201)
lib/runtimes/           OpenPLC and device-simulator adapters (server-only, Phase 02)
lib/protocols/          Modbus codecs and mappings (Phase 02)
lib/events/             event bus and SSE transport (Phase 04)
lib/catalog/            catalog access (Phase 03)
lib/export/             engineering export (Phase 03)
prisma/schema.prisma    database schema
prisma/migrations/      committed migrations
prisma/seed.ts          generic category seed (never vendor facts)
prisma.config.ts        Prisma CLI configuration (schema, migrations, datasource)
test/                   global test setup, stubs and integration tests
docs/                   engineering documentation
```

## Server-only convention
- Every module under `lib/db/`, `lib/services/`, `lib/auth/`, `lib/docker/`, `lib/runtimes/`, `lib/protocols/` and `lib/env.ts` starts with `import "server-only";`. The one exception is `lib/runtimes/openplc/strucpp-worker.mjs`, which runs as its own process.
- `components/**` may not import those paths; ESLint enforces it (`no-restricted-imports`).
- Client components are opt-in (`"use client"`) and receive plain serializable props from server components.
- Vitest aliases `server-only` to an empty module so server modules stay testable.

## Environment variable contract
All variables are read through `lib/env.ts`, which validates them with Zod and fails fast with the variable name (never the value). `.env.example` lists every variable; real `.env*` files are git-ignored.

| Variable | Required | Used by | Meaning |
|---|---|---|---|
| `DATABASE_URL` | yes | Prisma CLI, `lib/db` | PostgreSQL connection string |
| `TEST_DATABASE_URL` | no | integration tests | Database the integration tests may reset; tests are skipped when unset |
| `LOCAL_OWNER_ID` | production: yes | `lib/auth/actor.ts` | Owner every factory operation is scoped to (ADR-0007); defaults to `local-owner` outside production |
| `DOCKER_HOST` | no | `lib/docker/client.ts` | Docker Engine endpoint: `unix:///path` or `tcp://host:port` (default `unix:///var/run/docker.sock`) |
| `RUNTIME_SECRET` | production: yes | `lib/runtimes/openplc/credentials.ts` | Secret (>= 32 characters) the per-container runtime API credentials are derived from; a development value is used outside production |
| `RUNTIME_PORT_RANGE` | no | `lib/docker/policy.ts` | Host ports runtime containers may publish, `min-max` within 1024–65535 (default `15000-15999`) |
| `RUNTIME_BIND_ADDRESSES` | no | `lib/docker/policy.ts` | Comma-separated IPv4 addresses runtime ports may bind to (default `127.0.0.1`). Must include `127.0.0.1`; add a LAN address to let external gateways reach a PLC's Modbus port |
| `SIMULATION_TICK_MS` | no | `lib/services/runtime-deps.ts` | Device-simulator cycle time in milliseconds, 20–5000 (default `100`) |
| `SIMULATION_SNAPSHOT_MS` | no | `lib/services/runtime-deps.ts` | How often the simulator stores a state snapshot per device, 1000–3600000 ms (default `10000`) |
| `ASSET_STORAGE_DIR` | no | `lib/assets/storage.ts` | Directory the catalog's 3D asset files are stored in (default `./data/assets`, relative to the server's working directory; ignored by Git). Back it up with the database (ADR-0012) |
| `TAG_POLL_MS` | no | `lib/services/runtime-deps.ts` | How often the tags of a running PLC are read for live values, 100–60000 ms (default `500`) |
| `TELEMETRY_MIN_INTERVAL_MS` | no | `lib/services/runtime-deps.ts` | A tag is stored as telemetry at most this often, 100–3600000 ms (default `1000`) |
| `TELEMETRY_MAX_INTERVAL_MS` | no | `lib/services/runtime-deps.ts` | A tag is stored at least this often even when unchanged, 1000–86400000 ms (default `60000`) |
| `TELEMETRY_DEADBAND_PERCENT` | no | `lib/services/runtime-deps.ts` | A change below this percentage of the last stored value is not stored, 0–100 (default `1`) |
| `TELEMETRY_RETENTION_HOURS` | no | `lib/services/runtime-deps.ts` | Stored telemetry older than this is deleted, 1–8760 hours (default `24`) |
| `EVENT_RETENTION_DAYS` | no | `lib/services/runtime-deps.ts` | Recorded events and cleared alarms older than this are deleted, 1–3650 days (default `30`) |
| `TEST_DOCKER` | no | integration tests | `1` runs the Docker lifecycle tests against the engine; they are skipped otherwise |
| `POSTGRES_PORT` | no | `compose.yaml` | Host port for the local database (default 5432) |

A task that introduces a variable adds it to this table, to `.env.example` and to `lib/env.ts` in the same change. Variables are never exposed to the browser unless explicitly prefixed `NEXT_PUBLIC_` and documented here.

## Commands
| Command | Purpose |
|---|---|
| `npm run dev` | development server |
| `npm run build` / `npm start` | production build / serve |
| `npm run lint` | ESLint, including the design-token adherence rule |
| `npm run format` / `npm run format:check` | Prettier write / check |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | unit and component tests; database integration tests when `TEST_DATABASE_URL` is set; Docker lifecycle tests when `TEST_DOCKER=1` |
| `npm run db:up` / `npm run db:down` | start / stop the local PostgreSQL container |
| `npm run db:generate` | generate the Prisma client (also runs on `npm install`) |
| `npm run db:migrate` | create/apply migrations in development |
| `npm run db:deploy` | apply committed migrations (CI, production) |
| `npm run db:seed` | load the device categories and the shipped catalog (verified vendor records, generic simulated models); safe to repeat |

## Docker development prerequisites
- Docker Engine with the Compose plugin; the developer's user can reach the Docker daemon.
- Local database: `npm run db:up` starts PostgreSQL 17 from `compose.yaml`, bound to `127.0.0.1` only, with development-only credentials.
- The Next.js server talks to the Docker Engine API through `DOCKER_HOST`. Local development may use the Docker socket knowingly; it is never mounted into, or reachable from, browser code (see `docs/security.md`).
- The Docker tests (`TEST_DOCKER=1`) pull `busybox:1.37` and the pinned OpenPLC image (about 360 MB to download, 1.4 GB on disk) and create labelled test networks and containers, which they remove afterwards.
- Factory runtime containers are created by the application, not by `compose.yaml`.

## CI baseline
GitHub Actions workflow `.github/workflows/ci.yml`, on pushes and pull requests to `develop`:
1. `npm ci`
2. `npm run format:check`
3. `npm run lint`
4. `npm run typecheck`
5. `npm run db:deploy` against a PostgreSQL 17 service container
6. `npm test` with `TEST_DATABASE_URL` and `TEST_DOCKER=1` set (the runner's Docker Engine)
7. `npm run build`

The OpenPLC integration tests run in the same step: they pull the pinned runtime image and exercise compile, deploy, execution and Modbus access.

## Graphify
1. Install the CLI: `pipx install graphifyy` (provides the `graphify` command).
2. Register the project skill for the agents in use: `graphify install --project --platform claude` (repeat with `codex`, `copilot`).
3. Build or refresh the code graph: `graphify update .` (no LLM needed). Output goes to `graphify-out/`, which is git-ignored except `GRAPH_REPORT.md`.
4. Query before cross-module work, e.g. `graphify explain "<node>"` or `graphify path "<A>" "<B>"`.

See `docs/graphify.md` for the workflow rules.
