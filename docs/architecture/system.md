# Emerald Agent Fabric: System Architecture

## 1. Architectural Boundaries and Dependency Inversion

```
Transport (Fastify HTTP / IPC / CLI / Test Harness)
        │
        ▼
Application (RunCoordinator, LeaseManager, SweeperService)
        │
        ▼
Domain (RunAggregate, RunStateMachine, Invariants, Events, Errors)
        │
        ▼
Ports (StateStorePort, EventStorePort, OperationPort, ClockPort, IdGeneratorPort)
        │
        ▲
Adapters (SqliteStateStore, SqliteEventStore, PureOperationAdapter, SystemClock)
        │
        ▼
Infrastructure (SQLite WAL Database, OS FileSystem, Node.js Runtime)
```

### Invariants:
1. **Dependencies Point Inward**: The Domain layer depends only on language primitives and domain-defined ports. It contains zero imports from SQLite, Fastify, Docker, or external SDKs.
2. **Ports as Abstractions**: Infrastructure and database drivers are adapters implementing domain ports.
3. **Pluggable Execution Engine**: The execution boundary (`OperationPort`) allows swapping deterministic test operations for Docker sandboxes or tool runners without modifying the state machine.

---

## 2. Core Subsystems

### 2.1 Durable State Machine
- Manages explicit lifecycle states: `CREATED`, `QUEUED`, `LEASED`, `RUNNING`, `COMPLETED`, `FAILED`, `CANCELLED`, `TIMED_OUT`, `RECOVERING`.
- Pure domain validation via `canTransition(from, command)` and `applyTransition(state, command)`.
- Enforces Optimistic Concurrency Control (`version`) and lease fencing.

### 2.2 Append-Only Event Store
- Captures fine-grained lifecycle transitions and operational milestones.
- Strictly ordered, gapless integer sequence ($1, 2, 3, \dots, N$) per `run_id`.
- Committed in the exact same ACID transaction as the state mutation.

### 2.3 Lease Coordination & Sweeper
- Provides time-bounded exclusive ownership of runs by active workers.
- Leases are fenced via unique `lease_id` tokens, preventing stale workers from corrupting recovered runs.
- Background sweeper detects lapsed heartbeats (`lease_expires_at < now`) and transitions runs to `RECOVERING` for retry or terminal failure.

### 2.4 Execution Boundary & Ports
- `DeterministicOperationPort` provides a clean abstraction for unit and integration testing without invoking shell processes or containers.
- Enforces logical timeouts via cooperative abort signals.

---

## 3. Module Layout (Single Package Modularity)
To satisfy the **Minimal Complexity** and **No Speculative Architecture** principles, Capability 1 avoids premature monorepo tooling in favor of a strictly modular single-package structure:
```
src/
├── domain/            # Pure entities, state machine, invariants, events, errors
│   ├── models/
│   ├── state-machine/
│   └── events/
├── application/       # Use cases, coordination, lease management, sweeper
├── ports/             # Domain port interfaces (storage, operations, clock)
├── adapters/          # SQLite storage adapters, operation adapters, clock
│   ├── persistence/
│   └── operations/
└── infrastructure/    # Database initialization, SQLite PRAGMA configuration
```
