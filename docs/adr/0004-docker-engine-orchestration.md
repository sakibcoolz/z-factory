# ADR-0004 — Docker Engine API Orchestration

Status: Accepted

## Decision
Z-Factory orchestrates runtime containers through the Docker Engine API from server-only TypeScript. Prefer reusable images + generated configuration over generating a unique Dockerfile per virtual device.

Docker Compose can be generated/exported for reproducibility but is not the sole runtime control mechanism.

## Consequences
Production requires a hardened least-privilege Docker boundary and strict option allow-lists.
