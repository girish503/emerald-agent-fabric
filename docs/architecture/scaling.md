# Emerald Agent Fabric: Scaling & Evolution Architecture

## 1. Local-First / CPU-First Philosophy
- Initial targets: Single developer machine running on CPU-only or standard developer laptop.
- No premature Kubernetes clusters, distributed queues, or multi-region replication.
- High-efficiency local execution via Node.js, Fastify, SQLite WAL, and local Docker/OCI runtime.

## 2. Horizontal Scaling Pathway
When measured bottlenecks justify distributed deployment:
- SQLite -> Distributed Postgres / FoundationDB.
- In-process lease manager -> Raft / Redis leased worker coordinator.
- Local Docker daemon -> Nomad / Kubernetes ephemeral worker pods.

Every distributed migration step requires an ADR with measured performance data.
