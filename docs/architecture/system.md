# Emerald Agent Fabric: System Architecture

## 1. Architectural Boundaries and Dependency Inversion

```
UI (Next.js / Web Console)
        │
        ▼
Transport (Fastify HTTP / WebSocket / IPC)
        │
        ▼
Application (Run Orchestration, Lease Management, Workflow Engine)
        │
        ▼
Domain (Agent Loop, State Machine, Reflex Engine, Policies, Event Schema)
        │
        ▼
Ports (ModelProvider, SandboxProvider, EventStore, StateStore, ToolRegistry)
        │
        ▼
Adapters (OpenAI, Anthropic, Gemini, Docker/OCI, SQLite-WAL, OpenTelemetry)
        │
        ▼
Infrastructure (OS, CPU, Network, FileSystem)
```

**Key Invariant**: Domain logic depends ONLY on ports. Adapters implement ports. No external framework or provider leaks into the domain.

## 2. Core Subsystems
1. **Durable State Machine**: Enforces valid run lifecycle transitions (`CREATED` through `COMPLETED`/`FAILED`).
2. **Event Fabric**: Append-only typed event streams with schema versions.
3. **Execution Runtime**: Coordinates the agent observe-plan-execute loop with timeout bounds and failure recovery.
4. **Policy & Reflex Layer**: Decoupled gatekeeper evaluating safety, confidence, action necessity, and capability permissions.
5. **Sandbox Isolation Layer**: CPU-first containerized environment running non-root with dropped capabilities and restricted network.
6. **Telemetry & Latency Engine**: OpenTelemetry integration measuring every phase of the task latency decomposition.
