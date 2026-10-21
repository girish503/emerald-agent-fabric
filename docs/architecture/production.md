# Emerald Agent Fabric — Production Architecture

**Version**: 1.0.0-prod  
**Status**: Release Candidate (Frozen Research Baseline: Phase 1–99)  
**Governing Principle**:  
$$\boxed{\text{The model proposes. The runtime governs. The sandbox executes. The verifier decides. The evidence proves.}}$$

---

## 1. Architectural Overview

Emerald Agent Fabric is a zero-cost, local-only, governed autonomous software-engineering agent runtime. It transforms open-source local models into dependable, observable, bounded, and recoverable engineering agents.

Emerald strictly separates untrusted model proposals from sovereign verification and execution authority.

```mermaid
flowchart TD
    User([Developer / CLI]) -->|emerald mission / run| CP[Control Plane]
    CP -->|MissionContract| MC[Mission Control]
    CP -->|Run Lifecycle| RC[Run Control]
    CP -->|Operator Approval Gate| AC[Approval Control]
    CP -->|Hermetic Evidence Bundle| EC[Evidence Control]

    RC -->|Execute Run| RE[Production Runtime Engine]
    RE -->|Context Selection| LM[Local Model Adapter (Ollama)]
    LM -->|Unprivileged Proposal| GF[Production Governance Facade]

    subgraph Governance & Boundary Gates
        GF -->|Capability Lattice| CFE[Capability Fence Enforcer (C1-C20, N691-N720)]
        GF -->|Boundary Gateway| CHG[Cross-Harness Gateway (N696)]
        GF -->|High-Risk Gate| AC
    end

    GF -->|Authorized & Sanitized| TG[Production Tool Gateway]
    TG -->|Sandboxed FS & Git| WS[(Hermetic Workspace)]

    WS -->|Candidate Diff| PV[Production Sovereign Verifier]
    PV -->|Multi-stage Verification| Proof[Cryptographic Proof Hash]
    Proof --> EC
    EC -->|Signed Evidence Bundle| RE
    RE -->|Deterministic Inspection| PR[Production Replay Engine]
```

---

## 2. Control Plane Architecture

The Emerald Control Plane orchestrates missions, leases, execution states, approvals, and immutable evidence generation.

### 2.1 Mission Control (`src/control-plane/mission-control.ts`)
- Manages high-level engineering objectives.
- Binds an immutable, cryptographically sealed `MissionContract` (canonical SHA-256 digest) upon creation.
- Enforces declared tool sets, timeout ceilings, and attempt limits.
- Supports mission lifecycle: `CREATED` $\to$ `ACTIVE` $\to$ `COMPLETED` / `REVOKED`.

### 2.2 Run Control (`src/control-plane/run-control.ts`)
- Governs individual execution attempts bound to a mission.
- Implements an explicit finite-state machine (FSM):
  $$\text{CREATED} \to \text{VALIDATING} \to \text{ACTIVE} \to \text{PLANNING} \to \text{EXECUTING} \to \text{VERIFYING} \to \text{COMPLETED} \mid \text{FAILED} \mid \text{CANCELLED}$$
- Invalid state transitions are rejected fail-closed.
- Coordinates worker leases, heartbeats, and recovery flags.

### 2.3 Approval Control (`src/control-plane/approval-control.ts`)
- Human-in-the-loop governance gate for high-risk operations (e.g. destructive commands, branch overwrites, privilege escalations).
- Holds requests in `PENDING` state until operator approval is recorded.
- Rejected requests fail closed and terminate execution safely.

### 2.4 Evidence Control (`src/control-plane/evidence-control.ts`)
- Sequentially logs every run event (`agent.proposal`, `governance.eval`, `tool.exec`, `verification.completed`).
- Computes canonical event digests and provenance roots.
- Produces a tamper-evident, sealed `ProductionEvidenceBundle`.

---

## 3. Agent Runtime Execution Loop

The execution loop guarantees that the model possesses zero direct authority over the host operating system or the repository.

1. **Context Construction**: Distills relevant workspace context, git status, and mission contract specifications without prompt injection leakage.
2. **Model Proposal**: The local model adapter emits typed proposals (`thought`, `toolName`, `toolInput`, optional `isGoalReached`).
3. **Governance Evaluation**: The proposal is intercepted by `ProductionGovernanceFacade`.
   - Capability lattice membership evaluated (`READ_WORKSPACE`, `WRITE_TEMPORARY_OUTPUT`, `EXECUTE_ANALYSIS`, `READ_REPOSITORY`).
   - Path containment checked against allowed workspace boundaries; traversal patterns (`..`) blocked fail-closed.
   - Cross-harness sanitization applied.
   - High-risk operations evaluated against approval gate.
4. **Tool Execution**: Authorized actions are dispatched to `ProductionToolGateway`, executing inside the workspace boundary with strict timeout limits and byte bounds.
5. **Observation**: Structured results or bounded error messages are fed back to the agent for the next step.
6. **Goal Declaration & Sovereign Verification**: When the agent signals goal completion (or exhausts step limits), the runtime transitions to sovereign verification.

---

## 4. Execution Boundary & Tool Gateway

The execution boundary isolates the agent's work within the workspace directory:

- **Stable Tool Primitives**:
  - `read_file`: Line-bounded, byte-bounded reading within workspace.
  - `search_code`: Workspace-contained regular expression and pattern search.
  - `git_status`: Porcelain status within workspace repository.
  - `git_diff`: Candidate working-tree patch inspection.
  - `write_file`: Workspace-contained safe writes; creates intermediate directories.
  - `run_command`: Controlled execution with timeouts, non-zero exit propagation, and output bounding.
- **Fail-Closed Path Containment**: Resolves paths against workspace root. Blocks symbolic link escapes, UNC traversal, and parent directory references (`..`).

---

## 5. Sovereign Verification Pipeline

Verification authority is independent of model judgment:
- **Syntax Check**: Verifies syntactical validity of modified files.
- **Build Stage**: Executes build toolchains (e.g. `npm run build`, `tsc --noEmit`).
- **Test Suite**: Runs authoritative test scripts (e.g. unit and regression suites).
- **Invariant Audit**: Confirms security invariants (no credentials, no secret leakage, no path traversal).
- **Proof Generation**: Generates a SHA-256 cryptographic proof hash binding the candidate git diff, test output, and verifier identity.

---

## 6. Deterministic Replay Engine

The replay engine (`src/evidence/production-replay-engine.ts`) reconstructs historical runs without re-executing non-deterministic side-effects:
- Answers Section 19 questions:
  1. What mission and contract authorized this run?
  2. What tool invocations were proposed, authorized, or denied?
  3. What exact git diff was produced?
  4. Did sovereign verification pass or fail, and what was the proof hash?
  5. What was the timeline and wall-clock duration of each step?
- Validates the bundle's cryptographic provenance root against individual timeline events.

---

## 7. Crash Recovery & Lease Management

The `ProductionRecoveryService` handles process restarts, orphaned locks, and expired worker leases:
- Scans for runs stuck in active states (`ACTIVE`, `PLANNING`, `EXECUTING`, `VERIFYING`).
- Fences expired leases and revokes orphaned capability fences.
- Re-evaluates working-tree state and marks runs as `RECOVERED` or transitions them to safe resume points.
- Guarantees zero double-execution and zero silent state corruption.
