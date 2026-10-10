# ADR-0001: Adoption of Master Engineering Constitution and Architectural Boundaries

## Context
Autonomous software-engineering agents are complex distributed systems involving untrusted code execution, stochastic model behaviors, latency bottlenecks, and security attack vectors. Building such a system via rapid speculative code generation leads to technical debt, architectural erosion, and unreliable evaluation.

## Decision
We adopt the **Emerald Agent Fabric Master Engineering Constitution Version 1.0** as the binding architectural contract for all development in this repository.
Specifically:
1. Strict Hexagonal Architecture (Domain independent of UI, Transport, DB, and SDKs).
2. Technology baseline: TypeScript, Node.js, Fastify, Zod, SQLite (WAL mode), Docker/OCI, Vitest, OpenTelemetry, Python (uv/pytest for evaluations).
3. Explicit lifecycle state machine (`CREATED`, `QUEUED`, `LEASED`, `RUNNING`, `VERIFYING`, `WAITING_APPROVAL`, `COMPLETED`, `FAILED`, `CANCELLED`, `TIMED_OUT`, `RECOVERING`).
4. Strict defense-in-depth security model with zero permanent credentials inside the sandbox.
5. Strict prompt hierarchy and stop conditions for engineering agents.

## Alternatives Considered
- *Ad-hoc prototyping*: Rapidly building a monolithic agent wrapper using external high-level frameworks (e.g. LangChain, CrewAI). Rejected due to lack of durability, poor sandbox boundaries, and unmeasurable latency models.
- *Microservices from Day 1*: Building separate distributed services for queue, sandbox, state, and UI. Rejected as speculative architecture; violates CPU-first developer workstation requirement.

## Consequences
- Every new feature must begin with PRD and Architecture ADR before code implementation.
- All code must be tested, typed, and accompanied by metrics and security reviews.
- Changes must proceed in small verifiable slices.

## Revisit Condition
Revisit if hardware constraints, distributed worker workloads, or alternative runtime environments (e.g. Rust/Go for container sandboxing) demonstrate measured performance advantages.
