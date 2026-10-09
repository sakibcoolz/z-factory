# TASK-004 — Makefile to Start, Stop and Restart the Local Development Stack

Status: **DONE**
Linear: [ZFA-55](https://linear.app/recruit-verse/issue/ZFA-55)

A follow-up of TASK-003 (development bootstrap specification).

## Request (2026-10-08)
The owner asked for a Makefile to start, stop and restart the project locally, including Docker.

## Owner decisions
- **Scope: everything.** That is PostgreSQL and the process simulation service (compose.yaml), the Web Factory broker, and the Z-Factory and Web Factory dev servers. Each part also has its own targets.
- **`make stop` leaves the factories' PLC runtime containers alone.** "Stop factory" in the app owns them and keeps the stored states right. `make stop-runtimes` stops them all.

## Acceptance criteria
- `make start`, `make stop`, `make restart` and `make status` work from a fresh clone with only `.env` files present.
  - The committed migrations of both databases are applied.
  - The dev servers run in the background, with logs and PID files in a git-ignored directory.
- Secrets the stack needs are generated once into git-ignored files and never printed.
- `npm run db:up` no longer fails when `PROCESS_SIM_TOKEN` is unset.
- Starting twice, or stopping something already stopped, is harmless. A port held by another process is reported, not killed.
- Documented in the README and in `docs/bootstrap.md`.

- **Added 2026-10-08:** forms on the iPad warned "The information that you're about to submit is not secure". The app is opened over the tailnet at `http://100.103.104.50:3000`. **Owner decision:** serve over HTTPS with Tailscale's certificates.

## Implementation
- **`Makefile`:**
  - `help` (the default), `setup`, `start`, `stop`, `restart`, `status`;
  - `start-`, `stop-` and `restart-<part>` for `db`, `sim`, `broker`, `app` and `web`;
  - `migrate`, `seed`, `logs`, `logs-app`, `logs-web`, `stop-runtimes`.
- **`scripts/dev-stack.sh`** does the work.
  - **Dev servers:** each is a detached session leader (`setsid --fork`) that writes its own PID, then becomes `next dev`. Stopping signals the whole session, and only for a server the script started.
  - **Process-sim token:** the environment, then `.env`, then `.run/process-sim-token`. The container and the Z-Factory server get the same one.
  - **Broker:** `web-factory-broker`, from the README's configuration with a named data volume. Its admin password is `apps/web-factory/mqtt-admin-password` (already git-ignored). Web Factory is pointed at it unless its `.env` says otherwise.
- **HTTPS on the tailnet:**
  - `make serve` runs `tailscale serve --bg`: https :443 goes to the app, and :8443 to Web Factory. Until HTTPS is enabled for the tailnet, it gives up after 15 s and prints Tailscale's link to enable it.
  - `make unserve` removes it, and `make status` shows the addresses.
  - Both `next.config.ts` files read `allowedDevOrigins` from `DEV_ALLOWED_ORIGINS`, which the script sets to the tailnet name and IPv4 address. Before, the app log showed "Blocked cross-origin request to Next.js dev resource /_next/hmr from 100.103.104.50", so hot reload did not work from the iPad.
- **`compose.yaml`:** `PROCESS_SIM_TOKEN` is no longer a required interpolation. Compose checked it for every command, so `npm run db:up` failed without it. The service still refuses to start with a token shorter than 16 characters.
- **`.gitignore`:** `/.run/`.
- **Docs:** `README.md` → Development, and `docs/bootstrap.md` → Local stack and Commands.

## Evidence (2026-10-08, on the development machine)
- **Before:** `env -u PROCESS_SIM_TOKEN docker compose up -d --wait postgres` failed with "required variable PROCESS_SIM_TOKEN is missing a value". After the change, `docker compose config --services` works without it.
- **`make start`** from Postgres-only: db, migrations for both apps, sim, broker, app and web came up, and the command returned.
  - `/factories` on :3000 and `/login` on :3200 answered 200.
  - Web Factory logged "broker connected", and Mosquitto showed the `admin` client through Dynamic Security.
  - The process simulation service answered 200 with the generated token and 401 without it, and the Z-Factory server's environment held the same token.
  - Both secret files are mode 600.
- **Starting again** changed nothing: "already running (pid …)".
- **`make restart-app`** stopped the app and started a new process.
- **A foreign process on :3200:**
  - `make start-web` refused, naming the port and `WEB_PORT`;
  - `make stop-web` reported the port as held by another process and left it alive.
- **`make stop-runtimes`** stopped a stand-in container labelled `zfactory.managed=true` (removed afterwards), and said so when there was none.
- **`make restart`** (stop everything, then start everything): both pages answered 200, and Web Factory reconnected to the broker with its kept Dynamic Security state.
- **`make stop`, twice:** everything stopped, then "not running" or "stopped" again, with no `next` process and none of ports 3000, 3200, 1883, 7700 or 5432 left listening.
- **Fresh database:** `prisma migrate deploy` for Web Factory against a database that did not exist created it and applied every migration. The check database was dropped afterwards.
- **Gates:** `npx prettier --check .`, `npm run lint`, `npx tsc --noEmit` and `npm run build` are clean. `TEST_DOCKER=1 npm test`: 97 files, 1044 tests passed.
- **Final gates on the PR branch (2026-10-09, commit 1651ee9).** They ran in a clean worktree with its own `npm ci`, so the owner's running stack was untouched.
  - Root: prettier, lint, `tsc --noEmit` and build are clean. `TEST_DOCKER=1 npm test`: 97 files, 1044 tests passed.
  - Web Factory: lint, `tsc --noEmit` and build are clean. `npm test`: 13 files passed, 3 skipped, 72 tests.
  - In the first run, `test/telemetry.test.ts` ("drops partitions past the retention") failed. A day partition, `d20260908`, was left in the shared test database by an earlier day's run, and today's maintenance dropped it as well. This does not depend on this change: the test passed when re-run alone, and the whole suite passed after that.
- **Left as found:** PostgreSQL running, everything else stopped.
- **Not run:** `make setup`'s `npm ci` (it reinstalls `node_modules`); its other steps are the ones above.

- **Tailnet:**
  - After `make restart-app restart-web`, the app server's environment held `DEV_ALLOWED_ORIGINS=localhost-1.taildb081d.ts.net,100.103.104.50`.
  - `make serve` stopped after 15 s with Tailscale's "Serve is not enabled on your tailnet" and its link, exit 1. `make status` showed "not served".

## Open after this task
- **HTTPS on the tailnet** is ready but not yet switched on. The owner has to enable HTTPS certificates for the tailnet once (the link `make serve` prints, or Admin console → DNS → HTTPS Certificates), then run `make serve`. Until then the apps are reachable over the tailnet by plain HTTP, which Tailscale encrypts.
- **Test isolation:** Web Factory's telemetry retention test depends on partitions earlier runs left in the shared test database. It needs its own clean-up to be repeatable on any day. Not part of this task.

## Notes
- **Running dev server and the typecheck:** while a dev server runs, `npx tsc --noEmit` at the root fails on `.next/dev/types/validator.ts`, with or without this change. That folder is included by `tsconfig.json`, and the running server's route types clash with the build's. Run the gates with the stack stopped.
- `next dev` writes a Next.js block into `AGENTS.md`, and creates `apps/web-factory/AGENTS.md`, when it detects an AI coding agent (`node_modules/next/dist/server/lib/app-info-log.js`, `ensureAgentRulesForDev`). It happened during the agent's verification runs. Both were reverted and are not committed, and `docs/bootstrap.md` says so.
- No shell linter is installed here. The script passed `bash -n` and the runs above.
