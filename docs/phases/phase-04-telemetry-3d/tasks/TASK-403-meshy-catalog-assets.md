# TASK-403 — Meshy MCP Catalog 3D Asset Generation

Status: **IN PROGRESS**
Linear: [ZFA-21](https://linear.app/recruit-verse/issue/ZFA-21)

## Objective
Use the connected Meshy MCP service during development/authoring to generate reusable UI-compatible GLB assets for Z-Factory catalog devices and peripherals.

## Already in place (TASK-402, ADR-0012)
The asset contract below exists: `Catalog3dAsset` records per catalog model with versions and an active version, files in `ASSET_STORAGE_DIR`, served at `/assets/models/<asset id>/model.glb`, and `registerCatalogAsset` in `lib/services/asset-service.ts`, which checks a GLB (self-contained glTF 2.0, no Draco/Meshopt/Basis, at most 25 MB), stores it as the next version and makes it active. The 3D view fits any registered model into the space of its category.

What remains for this task: generating the files with Meshy, normalizing them (scale, origin, up-axis, orientation), recording provider status for jobs that are pending or failed, retiring versions, and the authoring workflow. Assets must be generic shapes; none may imitate a manufacturer's housing.

## Scope
The same pipeline must work for all generic catalog categories, including PLCs, VFDs/drives, servo drives, soft starters, controllers, motors, pumps, fans/blowers, conveyors, valves, sensors, switches, relays/contactors, encoders, remote I/O, gateways and future peripherals.

## Flow
```text
Catalog metadata / engineering description / optional reference
        |
        v
Meshy MCP generation
        |
        v
Generated model
        |
        v
Validate + normalize
        |
        v
Store versioned GLB in Z-Factory-controlled asset structure
        |
        v
Bind asset metadata to reusable catalog model
```

## Asset contract
Each catalog model may reference:
- asset id
- GLB path/URL
- asset version
- generation source/provider
- Meshy task/job id when available
- generated/updated timestamp
- model scale and default orientation
- optional bounding-box/anchor metadata
- generation status and validation result
- fallback asset/category

## Acceptance criteria
- Meshy MCP credentials remain server/developer-side and are never exposed to the browser.
- Generation is explicit authoring work; opening the 3D view must never trigger Meshy generation.
- Resulting GLB is copied into Z-Factory-controlled storage/file structure so runtime rendering does not depend on Meshy availability.
- Normalize scale, origin/up-axis and orientation so catalog assets are compatible in the same factory scene.
- Validate that the stored artifact can be loaded as GLB before assigning it to a catalog model.
- Regeneration creates a new asset version; existing factories continue to resolve a valid asset.
- A failed/missing generation leaves the catalog functional through a generic category fallback.
- Asset metadata is associated with the catalog model, not a single factory device instance.
- No module/process-specific 3D generation UX is introduced in Phase 04.

## Why the task stays open (owner's decision, 2026-10-05)
The authoring path is built and every model the catalog holds today has an asset, but the task is **kept IN PROGRESS**: further devices and models are still to be added to the catalog, and each needs its asset made through this path. The first pull request delivers the pipeline and its documentation; the task is closed by the owner once the catalog and its assets are complete.

## Evidence (2026-10-05)
- **Credentials stay server/developer-side.** The key is read from `MESHY_API_KEY` by `scripts/catalog-assets.ts` only and sent to Meshy's API host only. A test scans `app/`, `components/`, `lib/` and `scripts/` and finds the variable in `lib/env.ts` and the script alone, no `NEXT_PUBLIC_` form and no key-shaped string; another checks that no error of the Meshy client repeats the key. In this task the key never entered the repository at all: generation ran through the Meshy tools of the coding session.
- **Generation is explicit authoring.** A test walks the import graph: only `lib/services/asset-authoring-service.ts` imports the provider, and only the script imports that service. In the browser the 3D view of a factory with eight assets requested eight GLB files from Z-Factory's own route and nothing from another host.
- **Files are in Z-Factory's storage.** 33 files under `ASSET_STORAGE_DIR` (`models/<model id>/v<version>/model.glb`), served by `GET /assets/models/<asset id>/model.glb`; the provider's signed download address is used once and stored nowhere (tested).
- **Normalized.** Every stored file is in metres, Y up, front to +Z, fitted to its category's space, standing on its origin; its record has `scale` 1, `rotationYDeg` 0 and the normalization report. Tests cover scale, origin, up-axis, quarter turn, the author's own angle, node transforms and that geometry and materials are untouched. In the browser a source in millimetres and off its origin stood at motor size on the floor.
- **Checked before it is assigned.** The file is checked as it comes and again after normalization, before the version becomes ready and active. Tests: a file that is no GLB, one that needs Draco and one without size each end as a failed version with the reason, with no file stored and the active asset unchanged.
- **Regeneration is a new version.** CPU 1214C DC/DC/DC went from version 1 to 3 and the on/off valve from 1 to 2 in this installation; earlier ready versions stay and can be made active again (`activate`). Tested against PostgreSQL, including a factory scene that keeps resolving an asset through retiring.
- **Failure leaves the catalog working.** A failed or interrupted job changes nothing that is rendered; a model without a ready asset is drawn as its category's generic shape (tested; seen in the browser for a failed version and for a model without an asset). The real run was interrupted once by the key's credit limit and continued later without paying twice.
- **Metadata belongs to the catalog model.** `Catalog3dAsset` rows hang on `DeviceModel`; two motors of one model draw the same asset (TASK-402), and models of one shape get their own version and file through `share`.
- **No module-specific generation UX.** No screen generates anything; the catalog screen shows state and names the command.
- **Catalog:** 30 of 30 models have a ready asset from 27 generated shapes (Meshy 6, mesh and texture, 3.2 to 5.3 MB, 24,000 to 31,000 triangles). 820 Meshy credits used.
- **Tests added:** 40 (23 unit: normalization, prompts, Meshy client, boundaries; 14 against PostgreSQL: generation with a stand-in provider, failures, resume, import, share, retire, activate, catalog state; 3 for the catalog screen).

## Decisions made in this task
- **One Linear issue.** ZFA-21 existed in the backlog; it was given the full body and used, not duplicated.
- **Authoring is a command, not a screen.** `npm run assets` (`scripts/catalog-assets.ts`) is the only caller of the authoring service. The catalog screen shows asset status and offers no control that generates anything.
- **Two ways to the provider, one way into the catalog.** The script calls Meshy's REST API with `MESHY_API_KEY` from the environment. A coding session with the Meshy tools can generate instead and hand the file to `import`. Both go through the same check, normalization and registration.
- **Normalization is one matrix.** A root node is added to the file; geometry and textures are not rewritten. The stored file is in metres, upright, front to +Z, fitted to its category's space, standing on its origin; its record has `scale` 1.
- **Generic prompts by construction.** A vendor record contributes its category and compact/modular only. Words an author adds are refused when they name a manufacturer or a catalog product.
- **Shapes are shared.** Models with the same prompt share one generated file (26 generations for 30 models); each model keeps its own version and file.
- **A job is a version.** `PENDING` while it runs, `FAILED` with the reason, `READY` with its file. An interrupted job is resumed from its stored job ids; a model has one pending job at a time.
- **Schema:** forward migration `catalog_asset_generation` adds `providerStatus`, `statusMessage` and `generationJson` to `Catalog3dAsset`.
- **New variable:** `MESHY_API_KEY` (optional; authoring script only). No new dependency.

## Progress (2026-10-05)
- Built and tested: prompt, Meshy client, normalization, job states, import, share, retire, activate, the `npm run assets` command, asset status on the catalog screen.
- Checked in a browser with temporary rows (removed afterwards): the catalog screen for a model with a rendered, a pending, a retired and a failed version; the 3D view drawing a normalized file (source in millimetres, off its origin) at the size of its category, standing on the floor, and a shared copy on another model.
- Pilot (owner's go-ahead, 180 credits: six meshes at 20, six textures at 10, Meshy 6): control cabinet (CPU 1214C DC/DC/DC), three-phase motor, centrifugal pump, on/off valve, pressure transmitter, belt conveyor. Generated through the Meshy tools of the coding session and registered with `npm run assets -- import … --job <task id>`. Each file is 3.2 to 4.7 MB with 26,000 to 30,500 triangles; all six passed the check, were normalized and are rendered in the 3D view (browser, temporary factory, removed afterwards). No texture carries a logo or text.
- Found in the pilot and fixed: a cabinet about as deep as it is wide was turned a quarter because it fitted 6 % better that way. A quarter turn now needs a gain of a quarter; the cabinet was imported again as version 2 and version 1 retired.
- Rest of the catalog (owner's second go-ahead, with the request for realistic, accurate shapes): the prompt forms were rewritten to describe each kind of device as it is really built (heat sink and keypad of a drive, diaphragm actuator and positioner of a control valve, connection head and thermowell of a temperature transmitter, and so on), still without any manufacturer's features. Reference pictures could not be fetched (the Firecrawl account had no credits; Wikimedia refused automated requests), so the forms come from knowledge of the device types.
- 20 mesh jobs were started (400 credits). Two were textured and registered (20 credits): the modular control cabinet (5069-L306ER, shared with CPU 1511-1 PN) and the drive (Generic VFD, hardwired control, shared with the Modbus TCP one). The compact PLC cabinet was shared with TM241CE24T and the pressure transmitter with its 0–10 V twin. 12 of 30 models have an asset.
- The key's credit limit stopped generation once ("API key credit limit reached" at 600 credits through the key); the owner raised it and the waiting jobs were continued, none requested twice.
- **Catalog complete (2026-10-05):** the 18 waiting meshes were textured (180 credits) and the on/off valve repainted lighter on its pilot mesh (10; version 2). On the owner's request and from a picture the owner supplied as a reference for the form, the compact PLC became a controller module instead of a cabinet (30 credits; version 3 on CPU 1214C DC/DC/DC, shared with TM241CE24T): described from the picture's layout, without the name, lettering or logo of the product shown. All 30 catalog models have a ready asset from 27 generated shapes; every file is 3.2 to 5.3 MB with 24,000 to 31,000 triangles. Meshy credits used by this task: 820 of 1140.
- Checked in the 3D view (browser, temporary factories, removed afterwards): every shape loads from Z-Factory's own asset route, stands on the floor and is sized to its category.
- Known weak shapes, left for the owner to judge: the stack light (squat, dark), the proximity sensor (lying flat, very small), the pressure transmitter (a dial gauge from the pilot prompt; the prompt now asks for no dial), the agitator (dark tank where stainless steel was asked for). Each can be regenerated as a new version for 30 credits.
- The script's own call to Meshy's REST API has run against a stand-in only: generation went through the Meshy tools of the coding session and `import`.

