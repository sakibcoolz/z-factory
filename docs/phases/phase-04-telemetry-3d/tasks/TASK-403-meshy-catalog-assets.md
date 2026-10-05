# TASK-403 — Meshy MCP Catalog 3D Asset Generation

Status: **PLANNED**

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