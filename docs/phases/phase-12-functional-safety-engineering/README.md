# Phase 12 — Functional Safety Engineering & Verification

Status: **PLANNED**

## Goal
Extend existing Z-Factory engineering and simulation features with traceable safety requirements, hazard analysis, device-specific safety profiles, validation evidence, and assessment-ready documentation. **No claim of SIL 2, PL, functional safety certification, or suitability as a sole protective layer for real machines.**

## Scope and boundaries
- IEC 61131-3: analyze existing ST compiler and plan LD/editor interoperability with version-specific OpenPLC export validation.
- IEC 61508: apply functional safety lifecycle practices and traceability. SIL 2 is an **aspirational simulator default-to-safe design objective only**, not an achieved rating.
- ISO 13849: record safety function context, risk-derived required PL and assumptions for applicable machinery; do not imply equivalence between PL and SIL.
- ISA-5.1: document instrument tagging rules, keeping tag identifiers distinct from typed machine metadata.
- ISA-18.2: compare existing alarm implementation to lifecycle requirements, priorities, shelving, suppression, audit and alarm philosophy.
- ISA-TR88.00.02: apply machine mode/state design where relevant; **not** a generic Modbus register-map standard.
- Modbus TCP: retain validated, versioned register maps and explicit writable command/setpoint authority. Modbus TCP is not authenticated and cannot itself carry safety-rated guarantees.
- Simulation-only safety logic is separated from UI/application/infrastructure. Any physical safety function needs independent, suitable hardware engineering and assessment.

## Reuse before building
- TASK-205 and ADR-0015 program-authoritative I/O.
- TASK-804 Phase 08 scenario and closed-loop testing.
- TASK-1014 Phase 10 fault and degraded-quality models.
- Phase 09 cloud/edge command expiry, validation and alarm foundations.
Do not duplicate these; first map existing behavior and evidence to new safety requirements.

## Prerequisites
- Review `AGENTS.md`, `docs/README.md`, `docs/status.md`, `docs/rules.md`, architecture, security and testing docs.
- Resolve phase-status inconsistencies in the roadmap, notably Phases 06 and 08, before marking safety tasks Ready.
- Review relevant existing tasks and identify integration boundaries. Do not change PLC output authority.
- Synchronize approved task status/scope with Linear according to `docs/linear-workflow.md`; query Graphify before cross-cutting implementation.

## Execution tasks
| Task | Status | Scope |
|---|---|---|
| TASK-1201 | PLANNED | Existing Safety Capability and Standards Gap Assessment |
| TASK-1202 | PLANNED | Safety Lifecycle Scope and Hazard Register |
| TASK-1203 | PLANNED | Safety Requirement Domain and Traceability |
| TASK-1204 | PLANNED | Catalog Device Safety Profile Templates |
| TASK-1205 | PLANNED | Persistence, API and Review Workflow |
| TASK-1206 | PLANNED | Safety Engineering UI and Reports |
| TASK-1207 | PLANNED | Safety Function Simulation Contracts |
| TASK-1208 | PLANNED | Alarm Lifecycle Alignment |
| TASK-1209 | PLANNED | IEC 61131-3 Editing and OpenPLC Export Assessment |
| TASK-1210 | PLANNED | Safety Verification and Assessment Evidence Package |

## Acceptance and independent assessment boundary
Each safety function must reference a hazard, versioned requirement, designed behavior, explicit safe-state assumptions, test case and reproducible evidence identifying code/configuration versions. Missing tests and unverifiable assumptions remain OPEN. Tests demonstrate the simulator's specified behavior—not certified safety integrity. Changes to physical equipment control require a separate risk assessment and approved engineering process.
