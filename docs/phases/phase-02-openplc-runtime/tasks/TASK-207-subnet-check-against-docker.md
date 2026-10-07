# TASK-207 — Check a Factory's Subnet Against Existing Docker Networks

Status: **DONE**
Linear: [ZFA-52](https://linear.app/recruit-verse/issue/ZFA-52)

## Finding (2026-10-07)
A pump station demo factory was given 172.20.1.0/24, free in the database but held by an orphan Docker network (TASK-206). "Start factory" then faulted its PLC with "This subnet overlaps a network that already exists on the Docker host". Creating or editing a factory (and the demo's choice of subnet) checks only the factories in the database.

## Acceptance criteria
- Creating or editing a factory refuses a subnet that overlaps an existing Docker network, saying so, before anything is started.
- The demo factory picks a subnet that is free both in the database and on the Docker host.
- When Docker cannot be reached, the check says so instead of passing silently.
- Tests cover a subnet that is free in the database but taken in Docker.

## Implementation
- `lib/docker/networks.ts`: `listHostNetworks(docker)` lists every network on the host with its IPv4 subnets. It is the listing `ensureFactoryNetwork` already used, now exported.
- `lib/services/factory-service.ts`:
  - `createFactory` and `updateFactory` take a `HostNetworkReader`. They ask Docker before the transaction (on update, only when the subnet changes), then check the subnet against the other factories first and then against the host networks, leaving out the factory's own network (managed and labelled with its id).
  - A clash is CONFLICT `docker-subnet-overlap` on the subnet field.
  - If Docker cannot be asked, the call fails with the Docker error, its message followed by "The subnet could not be checked against the networks on the Docker host, so the factory was not saved." (rule `subnet-check-unavailable`). Nothing is stored.
  - `suggestFactorySubnet` also leaves out host subnets. Without Docker it falls back to the database, and saving then says why.
  - The reader is optional: the app always passes it, and tests and harnesses without Docker omit it.
- Callers:
  - the create and update actions (`app/factories/actions.ts`);
  - the create page's suggested subnet (`app/factories/new/page.tsx`);
  - the pump station demo (`lib/services/demo-service.ts`), which picks and checks with its runtime's Docker client.
- The form's hint now says the subnet must not overlap a network already on the Docker host (`components/factories/factory-form.tsx`).
- Docs: `docs/docker-runtime.md` → Networks.

## Evidence (2026-10-07)
- **Service and actions** (`test/integration/factory-crud.test.ts`, stubbed host):
  - a subnet free in the database but held by a host network, or inside a larger one, is refused with `docker-subnet-overlap`, and nothing is stored;
  - a clash with another factory still reads `subnet-overlap`;
  - on update, the factory's own network is not a clash, a host network is, and Docker is not asked when the subnet is unchanged;
  - with Docker unreachable, create and update fail with `subnet-check-unavailable`, and nothing changes;
  - the suggestion skips host subnets (172.20.1.0/24 and 172.20.2.0/23 taken gives 172.20.4.0/24) and falls back without Docker;
  - the create and update actions show the clash on the subnet field.
- **Demo** (`test/integration/demo-factory.test.ts`): with 172.20.1.0/24 held on the host, the demo takes 172.20.2.0/24. With Docker unreachable, it is refused with `subnet-check-unavailable` and no factory is made.
- **Real Docker** (`test/integration/plc-runtime.test.ts`):
  - a network created outside Z-Factory makes `createFactory` refuse its subnet, and the suggestion avoids every host subnet;
  - the factory's own network, which is still on the host, is no clash for a rename;
  - moving onto the stray subnet is refused.
- **Browser** (production build on 127.0.0.1:3111, headless Chromium, dev database), with a stray network created on 172.20.1.0/24:
  - the create form offered 172.20.2.0/24;
  - submitting 172.20.1.0/24 showed "This subnet overlaps a network that already exists on the Docker host." under the subnet field, and nothing was created;
  - 172.20.2.0/24 was created;
  - "Create pump station demo" took 172.20.3.0/24 and started RUNNING;
  - after Stop factory, editing its subnet to 172.20.1.0/24 was refused the same way.
  - Everything was removed afterwards: both factories, the stray network, the preview and the browser. The host had 0 managed containers and networks, and the dev database had 0 factories.
- **Gates:**
  - `npx prettier --check .`, `npm run lint`, `npx tsc --noEmit` and `npm run build` are clean;
  - `TEST_DOCKER=1 npm test` with `.env`, `PROCESS_SIM_BIN` and `AGENT_BIN`: 97 files, 1044 tests passed.

## Found while verifying (not in this task's scope)
Stopping a factory leaves its own network on the host, on the subnet it was created with. Changing the subnet of a stopped factory that has run before is accepted. Its next start then fails with "A different Docker network already uses this factory's network name." (`network-name-taken`), and the factory is left DEGRADED, which is the state TASK-208 is about.

This was reproduced in the browser by moving the demo from 172.20.3.0/24 to 172.20.9.0/24. Recorded for the owner to decide whether it becomes a task of its own.

## Limitations
- A network created on the host after the check, and before the factory starts, is still caught only at start, by `ensureFactoryNetwork`.
