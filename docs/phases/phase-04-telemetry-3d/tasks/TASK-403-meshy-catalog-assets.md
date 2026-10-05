# TASK-403 — Meshy MCP Catalog 3D Asset Generation

Status: **PLANNED**

## Objective
Use the connected Meshy MCP service during development/authoring to generate reusable UI-compatible GLB assets for Z-Factory catalog devices and peripherals.

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