# TASK-206 — Remove a Factory's Docker Network and PLC Containers When It Is Deleted

Status: **DONE**
Linear: [ZFA-51](https://linear.app/recruit-verse/issue/ZFA-51)

A follow-up of TASK-201 (Docker engine integration) and TASK-202 (the OpenPLC adapter).

## Finding (2026-10-07)
`deleteFactory` (`lib/services/factory-service.ts`) requires a stopped factory, then deletes only its database record. The factory's Docker network (`zfactory_<factoryId>`, labelled `zfactory.factory-id`) and its stopped PLC runtime containers (`zf-<factoryId>-plc-NN`) stay on the host. The network keeps its subnet, so the next factory given that subnet cannot start (TASK-207).

It was found with a factory the owner deleted, and reproduced by deleting a pump station demo factory through the UI.

## Objective
Deleting a factory leaves nothing of it in Docker.

## Acceptance criteria
- Deleting a factory removes every Docker resource Z-Factory created for it (containers and networks labelled with its factory id) after checking that none is running.
- If Docker cannot be reached, or a resource cannot be removed, the factory is not deleted, and the user is told why; no record is left pointing at nothing.
- Resources of other factories, and anything Z-Factory does not manage, are never touched.
- Tests prove a deleted factory leaves nothing on the host, including with a real Docker engine.

## Implementation
- `lib/docker/factory-resources.ts`: `removeFactoryResources(docker, factoryId)` lists the containers and networks labelled `zfactory.managed=true` and `zfactory.factory-id=<factoryId>`. It refuses (CONFLICT, `factory-runtime-active`) while any container is running, restarting or paused, then removes the containers through `removeRuntimeContainer` and the networks through `removeFactoryNetwork`, the existing managed-only primitives.
- `lib/services/factory-service.ts`: `deleteFactory` takes the remover as a dependency. The order is: check the factory is stopped, remove its Docker resources, then recheck and delete the record in one transaction. A Docker error keeps the factory and says so ("The factory was not deleted, so none of its containers or its network is left behind."), with rule `delete-runtime-cleanup` unless Docker gave a more specific one.
- `app/factories/actions.ts`: the delete action passes `removeFactoryResources` with the server's Docker client.
- Docs: `docs/docker-runtime.md` (deleting a factory), `docs/demo-runbook.md` (removing the demo).

## Evidence (2026-10-07)
- **Real Docker** (`test/integration/docker-runtime.test.ts`, "deleting a factory removes its Docker resources, and only its own"): two factories, each with a network and a running runtime container, plus an unmanaged container labelled with the first factory's id.
  - Removal is refused while factory A runs.
  - After A's container is stopped, it removes exactly A's container and network.
  - B's running container, B's network and the unmanaged container are untouched.
  - A second run finds nothing.
- **Service** (`test/integration/factory-crud.test.ts`):
  - the remover is not called for a running factory, and is called with the factory id when stopped;
  - when the remover fails, the factory and its devices are kept, and the error is RUNTIME_FAILURE with rule `delete-runtime-cleanup` and the message "The factory was not deleted…";
  - the server action passes the factory id to `removeFactoryResources`.
- **Browser** (production build on 127.0.0.1:3111, headless Chromium, dev database):
  - created a pump station demo factory and started it: PLC-01 RUNNING, container `zf-<id>-plc-01` healthy, network `zfactory_<id>` present;
  - Delete while running: refused, "Stop the factory before deleting it.";
  - Stop factory, then Delete → Confirm delete: redirected to /factories;
  - `docker ps -a` and `docker network ls` filtered by the factory id were empty, there were 0 managed containers and networks on the host, and 0 factories in the dev database.
  - The temporary factory is gone; the preview and the browser were closed.
- **Gates:**
  - `npx prettier --check .`, `npm run lint`, `npx tsc --noEmit`, `npm run build`: all clean.
  - `TEST_DOCKER=1 npm test` with `.env`, `PROCESS_SIM_BIN` and `AGENT_BIN`: 97 files, 1037 tests passed.
  - No managed Docker resources were left after the run.

## Limitations
- Resources left by factories deleted before this change (none on this host now) are not swept automatically. Each is labelled with its factory id, and can be removed with `docker rm` and `docker network rm`.
