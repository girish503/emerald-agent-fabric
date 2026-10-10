# Emerald Agent Fabric: Research Questions

## Primary Research Question
Can an AI agent operate on real software systems while remaining observable, bounded, recoverable, verifiable, and progressively more efficient?

## Secondary Questions

### 1. Agent Decision & Reasoning Architecture
- **Adaptive Reflex vs Static Prompting**: Does a lightweight, observable Reflex decision layer reduce total latency and token cost compared to asking a frontier model to plan all checks upfront?
- **Harness Evolution Dynamics**: Can prompt and tool harness changes be evolved and promoted monotonically using strict benchmark suites without regression?

### 2. Runtime Integrity & State Machine Durability
- **Durable State Overhead vs In-Memory Execution**: What is the latency and resource overhead of transactional SQLite persistence and append-only event streams compared to unmanaged in-memory execution loops, and does durability measurably improve task completion rates during transient faults?
- **Lease Expiry & Recovery Bounds**: What worker lease TTL and heartbeat intervals minimize orphaned worker duration without triggering false-positive crash recoveries during CPU-intensive developer workloads?
- **Deterministic Replay Fidelity**: What is the minimal state and event capture required to guarantee 100% reproducible execution of agent runs across environments?
- **Interrupted Operation Replay Safety**: How can Emerald determine whether an interrupted operation is safely replayable? What contract or boundary declarations must an operation provide so the runtime can distinguish pure replayable computations (\(f(\text{input}) = \text{output}\)) from operations that may have produced external side effects before worker failure?
- **Idempotency Token Boundaries**: In at-least-once execution delivery, how far can an idempotency token propagate across execution providers before requiring provider-level deduplication or compensation mechanisms?

### 3. Capability Boundaries & Sandboxing
- **Capability Boundary Tightening**: What is the minimal set of OS capabilities and tool primitives required for software engineering agents to solve complex SWE-bench issues without exposing the host?
