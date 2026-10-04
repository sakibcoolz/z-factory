# ADR-0001 — Single Next.js Application for MVP

Status: Accepted

## Context
Z-Factory needs SSR UI, persistence, Docker orchestration, runtime control and live events. The MVP should minimize distributed-system overhead.

## Decision
Use one Next.js TypeScript application. Docker/runtime/database integration stays in server-only modules. Do not create an independent backend service for MVP.

## Consequences
Simpler deployment and shared types. Strong server/client boundaries are mandatory because Docker access is privileged. A later service split requires a new ADR.
