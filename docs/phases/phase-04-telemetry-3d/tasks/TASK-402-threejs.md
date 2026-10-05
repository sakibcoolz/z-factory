# TASK-402 — Three.js Factory View

Status: **DONE**
Linear: [ZFA-17](https://linear.app/recruit-verse/issue/ZFA-17)

## Objective
Implement the React Three Fiber factory visualization driven by canonical Z-Factory state and reusable catalog GLB assets.

## Scope change (2026-10-05, agreed with the owner)
The catalog asset reference moved into this task from TASK-403: the `Catalog3dAsset` record, where the files are stored and how they are served, and the registration of a file. The view could not "load the asset referenced by each catalog model" without it, and with it the view does not wait for Meshy. TASK-403 keeps generation, normalization and the authoring workflow.

## Acceptance criteria
- Load the 3D asset referenced by each catalog model instead of hard-coding one-off meshes in the scene.
- Support PLC, VFD/drive, servo drive, soft starter, controller, motor, pump, fan/blower, conveyor, valve, sensor, switch, relay/contactor, encoder, remote I/O, gateway and future catalog categories through the same asset contract.
- Factory device instances reuse the catalog model GLB while applying their own position, rotation, scale, instance name and runtime state.
- Render connections from the same canonical relationship graph used by the 2D topology.
- Simple motion/rotation may be driven by live tags for applicable equipment without introducing a second business-state model.
- Gracefully fall back to a generic placeholder when a catalog model has no usable GLB or asset loading fails.
- 3D is visualization only and cannot become the authority for runtime/device state.
- Runtime coloring, outlines and connection-state rules are implemented by TASK-404.

## Evidence (2026-10-05)
- **Loads the asset referenced by the catalog model.** `DeviceModel.active3dAssetId` → `Catalog3dAsset` → `GET /assets/models/<id>/model.glb`. In a browser with WebGL, a factory of twelve devices requested exactly two GLB files for the two models that had an asset; nothing was requested from another host.
- **One contract for every category.** An asset belongs to a catalog model whatever its category. Every one of the 35 catalog categories has a generic shape and footprint; a category added later is drawn as a box until it gets one (tested).
- **Instances reuse the model's GLB with their own placing.** Two motors of one model shared one asset and one request, each at its own position; an instance was turned by 45° and made larger from the inspector, and the other instance did not change (browser and tests). Name and stored state are shown above each device.
- **Connections from the same graph as the 2D topology.** The scene is built from `getTopology`; a test compares device ids, states and connection ids of both.
- **Fallback.** With the asset files removed, the scene drew the affected valve and motors as their generic shapes and everything else unchanged. A model without an asset, an asset that is not ready, and a browser without WebGL are covered by tests.
- **Visualization only.** The scene reads; the only thing stored for it is an instance's rotation and size, and a test checks that setting them changes nothing else about the device. Positions are the designer's.
- **Runtime colouring** is left to TASK-404, as the task says.
- Tests added: 30 (14 layout, shape, GLB check and storage; 7 scene view; 9 assets, scene, route and action against PostgreSQL). 643 tests pass with database and Docker tests enabled; format check, lint, typecheck and build pass.

## Decisions made in this task
- **ADR-0012 (accepted):** asset records in PostgreSQL, files in a directory on the server (`ASSET_STORAGE_DIR`), served by the application; nothing in Git.
- **One layout.** A device stands in 3D where the designer has it. Only rotation and size are set in the 3D view.
- **Any GLB fits.** A model is centred, put on the floor and scaled into the space of its category when it is rendered, so assets in millimetres or with an odd origin stand correctly before TASK-403 normalizes them. An explicit scale on the asset overrides the fit.
- **Labels are page elements** positioned by the scene, not text drawn in WebGL: no font is fetched and they use the design tokens.
- **New dependencies:** `three`, `@react-three/fiber`, `@react-three/drei`. They are loaded only on the 3D screen.

## Not in this task
- Motion driven by live tags (the criterion says "may"): it belongs with the live state mapping of TASK-404.
- Generating assets, normalizing them, retiring versions and showing asset status in the catalog screen: TASK-403. No catalog model has an asset yet, so a real factory shows generic shapes today.
- Editing positions in 3D, saved camera positions, external-device styling.
