# Emerald Agent Fabric: Data Architecture

## 1. Data Segregation
The system strictly decouples the following data domains:
1. **Operational State**: SQLite (WAL mode) tracking runs, leases, workers, and tasks.
2. **Event Log**: Append-only event store capturing run lifecycle, tool calls, and policy audits.
3. **Artifacts & Evidence**: Filesystem-backed storage for diffs, evidence bundles, and execution outputs.
4. **Research & Benchmarks**: Decoupled datasets, experiment configs, evaluation scores, and traces.
5. **Model Metadata**: Token counts, prompt cache hits, latency metrics, and provider costs.

## 2. Event Store Schema Standard
Every event emitted must conform to:
```typescript
interface FabricEvent<T = unknown> {
  eventId: string;
  runId: string;
  sequence: number;
  timestamp: string; // ISO 8601 UTC
  eventType: string; // e.g. "tool.requested"
  schemaVersion: number;
  producer: string;  // e.g. "runtime.worker-1"
  payload: T;
}
```

## 3. Durability Guarantees
- SQLite in `WAL` mode (`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;`).
- All state updates and event appends occur within ACID transactions.
- Idempotency keys prevent double execution on worker crash/recovery.
