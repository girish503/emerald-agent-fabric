# Integration Brief: Langfuse & OpenHands — Control Plane Architecture, Trace Projections, and Runtime Transparency

**Document ID**: `EAF-OSS-005`  
**Date of Inspection**: 2026-10-16  
**Status**: APPROVED FOR DESIGN (Implementation strictly deferred to Phase 18)  
**Role**: Senior AI Infrastructure Engineer & Technical Co-Founder  
**Upstream Systems**:
1. [Langfuse](https://github.com/langfuse/langfuse) — Commit [`88c02eae5d0087422343e0f8d96998d9d98cb992`](https://github.com/langfuse/langfuse/commit/88c02eae5d0087422343e0f8d96998d9d98cb992)
2. [OpenHands](https://github.com/OpenHands/OpenHands) — Commit [`9d02893bc96aa256a4c0ece316bdb992247bc918`](https://github.com/OpenHands/OpenHands/commit/9d02893bc96aa256a4c0ece316bdb992247bc918)

---

## 1. Executive Summary

Building developer trust in autonomous software engineering agents requires radical runtime transparency. If an agent fails or behaves unexpectedly, engineers must be able to inspect every causal link: the raw prompt, model output, schema validation result, Reflex risk assessment, policy authorization check, physical tool invocation, stdout/stderr streams, container sandbox boundary, and verification hash.

Inspecting **Langfuse** and **OpenHands** reveals the two dominant industry patterns for agent observability:
1. **Langfuse's Trace-Observation Hierarchy**: Hierarchical execution modeling (`Trace → Observation [Spans, Generations, Tools] → Score`) backed by immutable event streams, where UI screens are pure read-only projections over append-only storage.
2. **OpenHands's Decoupled Envelope Protocol**: Strict separation between the durable runtime event log and the real-time transport envelope (`SyncFrame`, `DurableFrame(seq)`, `TransientFrame`, `ItemStartedFrame`, `DeltaFrame`), ensuring the frontend UI never acts as an authoritative state store.

For Emerald Agent Fabric, these patterns govern **Phase 18 (Control Plane UI)**. Emerald's core UI principle is: **The UI exposes the runtime; it never hides it, and it never becomes a second source of truth**. All UI views will be thin, read-only projections over Emerald's durable SQLite database, lease-fenced `WorkerRuntime`, and cryptographic evidence records.

---

## 2. Research Question

> How do Langfuse and OpenHands model, stream, and render complex agent execution traces without creating duplicate state stores or compromising backend authority, and how can Emerald project its durable SQLite run, action, attempt, policy, and evidence records into an inspectable control plane without altering runtime persistence?

---

## 3. Upstream Inspected Source Files

### 3.1 Langfuse Inspected Files (Commit `88c02eae5d0087422343e0f8d96998d9d98cb992`)
1. **[`packages/shared/src/server/clickhouse/schema.ts`](https://github.com/langfuse/langfuse/blob/88c02eae5d0087422343e0f8d96998d9d98cb992/packages/shared/src/server/clickhouse/schema.ts)**:
   - Lines 1–40: Core entity table registry: `traces`, `observations`, `scores`, `dataset_run_items_rmt`, and events projections (`events_core`, `events_full`).
2. **[`packages/shared/src/server/clickhouse/schemaUtils.ts`](https://github.com/langfuse/langfuse/blob/88c02eae5d0087422343e0f8d96998d9d98cb992/packages/shared/src/server/clickhouse/schemaUtils.ts)**:
   - Lines 10–45: `getClickhouseEntityType` mapping incoming telemetry events into first-class entities:
     - `TRACE_CREATE` $\rightarrow$ root trace (`trace`).
     - `OBSERVATION_CREATE`, `SPAN_CREATE`, `GENERATION_CREATE`, `TOOL_CREATE` $\rightarrow$ nested child observations (`observation`).
     - `SCORE_CREATE` $\rightarrow$ evaluation scores and verifications (`score`).

### 3.2 OpenHands Inspected Files (Commit `9d02893bc96aa256a4c0ece316bdb992247bc918`)
1. **[`docs/architecture.md`](https://github.com/OpenHands/OpenHands/blob/9d02893bc96aa256a4c0ece316bdb992247bc918/docs/architecture.md)**:
   - Lines 5–20: System boundary definition: UI is strictly responsible for rendering conversation, terminal, files, and settings; UI is *never* responsible for executing actions or isolating workspaces.
2. **[`src/types/agent-server/session-frames.ts`](https://github.com/OpenHands/OpenHands/blob/9d02893bc96aa256a4c0ece316bdb992247bc918/src/types/agent-server/session-frames.ts)**:
   - Lines 1–60: Session websocket protocol frames:
     - `SyncFrame`: Sent before replay (`from_seq`, `through_seq`).
     - `DurableFrame`: An event safely persisted on disk, carrying monotonic log index `seq` and immutable payload.
     - `TransientFrame`: Ephemeral broadcast (e.g. typing indicator, progress).
     - `ItemStartedFrame` & `DeltaFrame`: Streaming chunks tied to monotonic `(item_id, attempt, order)`.
3. **[`src/types/action-type.tsx`](https://github.com/OpenHands/OpenHands/blob/9d02893bc96aa256a4c0ece316bdb992247bc918/src/types/action-type.tsx)** & **[`src/types/agent-state.tsx`](https://github.com/OpenHands/OpenHands/blob/9d02893bc96aa256a4c0ece316bdb992247bc918/src/types/agent-state.tsx)**:
   - Typed action enum (`initialize`, `read`, `write`, `run`, `finish`, `think`) and explicit agent states (`init`, `running`, `awaiting_user_input`, `paused`, `stopped`, `finished`, `error`).

---

## 4. Verified Upstream Findings

### 4.1 Langfuse: Read Projections Over Append-Only Events
In Langfuse:
- Ingestion is decoupled from query rendering.
- Telemetry events stream into an append-only store (`events_core` / `events_full`).
- Materialized views project events into three core UI tables:
  1. `Traces`: The root execution context (run ID, user ID, status, latency, total cost).
  2. `Observations`: The tree of steps (generations, spans, tool calls, inputs, outputs, errors).
  3. `Scores`: External evaluations and verifications.
- UI queries read directly from these projections. There is **zero dual-write state**; if a trace view is corrupted, it can be re-projected from the underlying events.

### 4.2 OpenHands: Protocol Envelopes vs Domain Events
In OpenHands `src/types/agent-server/session-frames.ts`:
- The streaming websocket frame is explicitly *not* a domain event:
  > *"The envelope is deliberately not an `Event`: the durable record rides inside it untouched, and protocol fields live on the envelope."*
- `DurableFrame` encapsulates an event already committed to disk, indexed by monotonic sequence number `seq`.
- Streaming increments use `ItemStartedFrame` and `DeltaFrame` tagged by `(item_id, attempt, order)`.
- Replay begins with a `SyncFrame(from_seq, through_seq)`, ensuring the client and server agree on exact sequence boundaries before replaying history.

---

## 5. Emerald UI Architecture: Mapping Existing Durable State

Emerald's Constitution strictly forbids creating speculative databases or secondary state stores for the UI. The UI is a pure query projection layer over Emerald's existing SQLite database and evidence store.

### The 9 Mandatory UI Capabilities and Their Authoritative Data Sources

| Capability | UI Screen / View | Authoritative Emerald Source of Truth |
|---|---|---|
| **1. Run List** | Tabular dashboard showing all active, completed, and failed agent runs. | `runs` table in SQLite (`run_id`, `task_id`, `status`, `created_at`, `completed_at`, `current_lease_id`, `worker_id`). |
| **2. Run Detail & Trajectory** | Sequential timeline of agent thought, proposed actions, observations, and tool outcomes. | `step_transcripts` in SQLite and serialized `execution_evidence` JSON files. |
| **3. Action / Attempt Model** | Visualizing logical actions and their physical attempt trials (including retries and `UNKNOWN` states). | `actions` table (`action_id`, `logical_sequence`, `status`, `tool_name`) joined with `attempts` table (`attempt_id`, `attempt_number`, `status`, `idempotency_token`, `error_payload`). |
| **4. Tool Inputs & Outputs** | Detailed JSON inspector showing exact arguments passed and stdout/stderr returned. | `attempts.input_payload` and `tool_execution_records` in `execution_evidence`. |
| **5. Policy & Reflex Decisions** | Badge/drawer showing action confidence, risk score, verification requirements, and policy authorization outcomes. | `ReflexDecision` records and `PolicyEvaluationResult` stored in `step_transcripts`. |
| **6. Verification Results** | Clean-room verification status: F2P tests, P2P tests, `SUITE_RAN` match, diff application. | `verification_results` table / `VerificationReport` in SQLite evidence bundle. |
| **7. Evidence & Artifact Hashes** | Cryptographic verification drawer: contract content hash, patch SHA-256, evidence bundle digest. | `mission_contracts.content_hash`, `evidence_bundles.bundle_hash`. |
| **8. Failure & Recovery History** | Audit log of lease expirations, worker heartbeats, crash recoveries, and `AttemptUnknownReason` events. | SQLite `domain_events` table filtered by `event_type IN ('run.recovered', 'action.recovery.reconciled', 'attempt.unknown.marked')`. |
| **9. Resource Use & Timings** | Latency breakdown chart: queue wait, sandbox start, model inference, tool execution, verification, and memory footprint. | `RunLatencyModel` decomposition recorded in `runs.metadata` and OpenTelemetry span exports. |

---

## 6. Real-Time Streaming Architecture (OpenHands Envelope Pattern)

To stream real-time updates to the browser without polling SQLite in a tight loop, Emerald adopts OpenHands's decoupled frame protocol over Server-Sent Events (SSE) or WebSockets:

```
┌────────────────────────────────────────────────────────┐
│               WorkerRuntime / StateStore               │
├────────────────────────────────────────────────────────┤
│ 1. Transaction commits Action/Attempt/Event in SQLite  │
│ 2. Emits DomainEvent to in-memory EventBus             │
└──────────────────────────┬─────────────────────────────┘
                           │ DomainEvent (committed)
                           ▼
┌────────────────────────────────────────────────────────┐
│             EventStreamingAdapter (Transport)          │
├────────────────────────────────────────────────────────┤
│ Maps DomainEvent to Envelope Protocol:                 │
│ - SyncFrame(fromSeq, throughSeq)                       │
│ - DurableFrame(seq, event)                             │
│ - ItemStartedFrame(actionId, attemptNumber)            │
│ - DeltaFrame(actionId, attemptNumber, chunk)           │
└──────────────────────────┬─────────────────────────────┘
                           │ SSE / WebSocket stream
                           ▼
┌────────────────────────────────────────────────────────┐
│           Next.js / React Frontend (Phase 18)          │
├────────────────────────────────────────────────────────┤
│ Read-only Zustand store updates UI components          │
│ Zero persistence authority                             │
└────────────────────────────────────────────────────────┘
```

---

## 7. A. Adopt, B. Adapt, C. Skip

### 7.1 A. Adopt (What Emerald Adopts)
1. **Trace-to-Observation Hierarchy**: Model execution visually as a root `Run` containing sequential `Steps`, where each step contains `ModelInference`, `ProposalValidation`, `ReflexAssessment`, `PolicyCheck`, and `ToolAttempt` observations.
2. **Decoupled Transport Frames**: Use explicit envelopes (`SyncFrame`, `DurableFrame(seq)`) for real-time frontend streaming to ensure UI state is strictly monotonic and resilient to network reconnects.
3. **Artifact Hash Inspection**: Display SHA-256 cryptographic hashes for every evaluated diff, mission contract, and evidence bundle directly in the header of each run view.

### 7.2 B. Adapt (Mapping to Emerald Interfaces)
- **Fastify Transport Layer**: Add read-only Fastify HTTP routes (`GET /api/v1/runs`, `GET /api/v1/runs/:runId/trajectory`, `GET /api/v1/runs/:runId/evidence`) querying `StateStorePort`.
- **Event Projection Service**: Implement a lightweight SQLite query service that aggregates `runs`, `actions`, `attempts`, and `step_transcripts` into typed view models (`RunSummaryView`, `RunTrajectoryView`).

### 7.3 C. Skip (What Emerald Explicitly Rejects)
1. **ClickHouse Cluster Requirement**: Langfuse uses ClickHouse for massive enterprise telemetry. Emerald is a research-grade, CPU-first infrastructure system; SQLite with WAL mode and proper indexes easily handles local runs and small clusters without adding external distributed database daemons.
2. **Interactive Terminal Hijacking**: OpenHands permits users to type arbitrary bash commands in the UI terminal during execution. In Emerald, interactive terminal execution bypassing `ToolExecutionGateway` violates capability governance and destroys deterministic replay.
3. **Premature Dashboard Widgets**: Complex metrics dashboards, team billing modules, and multi-tenant user authentication are rejected for v1.

---

## 8. Conformance Test Specifications

For Phase 18 control plane certification:

1. **Test 18.1: Exact State Store Reflection**:
   - Execute a 3-step agent task in `WorkerRuntime`.
   - Query `GET /api/v1/runs/:runId/trajectory`.
   - Assert: The API returns exactly 3 steps matching the SQLite `step_transcripts` table byte-for-byte.
   - Assert: Action and Attempt IDs in the response match the `actions` and `attempts` relational records.

2. **Test 18.2: Incomplete and Failed Run Rendering**:
   - Ingest a run that crashed mid-execution with an `UNKNOWN` attempt.
   - Assert: UI projection reflects `status = RECOVERING` or `FAILED`, displays the specific `AttemptUnknownReason`, and renders the last valid observation without throwing UI runtime exceptions.

3. **Test 18.3: Monotonic SSE Reconnect Sync**:
   - Establish SSE connection to `/api/v1/runs/:runId/stream`.
   - Disconnect after frame `seq = 5`.
   - Reconnect with `Last-Event-ID: 5`.
   - Assert: Server emits `SyncFrame(from_seq: 6)` and resumes streaming without duplicate or dropped events.

---

## 9. Productization Lessons from Langfuse & OpenHands

1. **Inspectability Creates Trust**: Engineers will not allow autonomous agents to operate on mission-critical software if the system is a black box. Showing the exact prompt, token counts, tool arguments, and sandbox logs turns skepticism into confidence.
2. **Never Conflate Presentation with State**: Keeping the UI strictly read-only prevents subtle desynchronization bugs where the UI believes an agent is running while the backend has already leased or terminated it.

---

## 10. Dependencies & Sequencing

- **Strict Deferral**: **Phase 18 (Control Plane UI) is strictly deferred** until after Phase 10I, 11, 12, 13, 14, and 17 are completely finished and verified.
- **Rationale**: Building a UI before the underlying tool execution, multi-step loop, and independent verification engines are stable creates massive technical debt and invites speculative UI-driven architectural churn.
