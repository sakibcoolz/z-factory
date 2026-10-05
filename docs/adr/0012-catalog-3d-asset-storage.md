# ADR 0012 — Catalog 3D Assets: Record in PostgreSQL, File in a Server Directory

Status: Accepted — 2026-10-05 (implemented in TASK-402; accepted by the owner)

## Context
Phase 04 gives every catalog model a reusable 3D asset: a GLB that is generated or curated once (TASK-403, with Meshy as the provider) and then rendered by every factory instance of that model. `docs/architecture.md` requires that the file is copied into Z-Factory-controlled storage, so that rendering never depends on the provider, but does not say where that storage is.

Three places were possible:

- **In the repository** (`public/`). Every clone has the assets and Next.js serves them. But assets are several megabytes each and binary, they change when a model is regenerated, and they are data produced with a paid account, not source. Git history would carry every version for good.
- **Object storage.** The usual answer for a hosted product. It adds a service, credentials and configuration to an application that today needs only PostgreSQL and Docker.
- **A directory on the server.** No new service; the files sit next to the database they belong to.

## Decision
1. **Record.** Each asset version is a `Catalog3dAsset` row: catalog model, version, status, provider and provider job, checksum, size, the scale and orientation that fit it into a scene, and what validation found. `DeviceModel.active3dAssetId` names the version that is rendered. An asset belongs to a catalog model, never to a device instance.
2. **File.** The GLB is stored in a directory on the server, `ASSET_STORAGE_DIR` (default `./data/assets`, ignored by Git), at `models/<model id>/v<version>/model.glb`. A file is written once and never changed. Keys are made by the server; no path comes from a request.
3. **Serving.** `GET /assets/models/<asset id>/model.glb` reads the row, then the file. Only a version with status `READY` is served. Because a version never changes, the response is cacheable for good (`immutable`, ETag from the checksum).
4. **Versions.** Registering a file creates the next version and makes it active in one transaction. Earlier versions and their files stay. A file that fails validation creates nothing, so a model keeps the asset it had.
5. **Validation at the door.** A file is accepted only if it is a complete, self-contained glTF 2.0 binary with something to draw, at most 25 MB, and needs no decoder the view does not carry (Draco, Meshopt, Basis). The view loads no decoder or font from another host.
6. **Fallback.** A model without an active, ready asset, and a device whose asset fails to load, is drawn as the generic shape of its category. A missing asset never blocks the catalog or a factory.
7. **Storage interface.** Code reaches files only through `AssetStorage` (`put`, `read`, `remove`). Object storage can replace the directory behind that interface without touching the record or the renderer.

## Consequences
- **Assets are part of an installation, like its database.** A fresh clone has none and draws placeholders until assets are generated or copied in. A backup of an installation is the database plus this directory; restoring one without the other leaves records without files (served as not found, drawn as placeholders) or files without records (unused).
- **One server, one directory.** Several server instances would need a shared directory or object storage.
- **Nothing is deleted yet.** Earlier versions accumulate. Retiring and removing versions belongs to the authoring task (TASK-403).
- **Licensing stays with the author.** Only generic shapes and assets the owner may store belong here. An asset that imitates a manufacturer's housing, or a vendor's CAD file, does not (`docs/references/plc-source-policy.md`).
- **Generation is not part of this decision.** How assets are produced, normalized and approved is TASK-403; it writes through the same registration.
