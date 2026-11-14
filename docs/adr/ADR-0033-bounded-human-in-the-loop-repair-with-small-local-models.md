# ADR-0033: Bounded Human-in-the-Loop Repair with Small Local Models

## Document Metadata
- **Status**: Proposed — awaiting maintainer decision (Empirically Validated via Tasks A–D Usability Trial)
- **Date**: 2026-10-23
- **Scope**: Emerald Agent Fabric production runtime, tool execution, and local repair workflows
- **Decision Type**: Architectural operating boundary and human-in-the-loop governance
- **Governing Constitution**: [GEMINI.md](../../GEMINI.md) (Master Engineering Constitution Version 1.0)
- **Related Evidence**:
  - Task A Results & Report: [`scratch/bounded-real-project-task-a-aligned-results.json`](../../scratch/bounded-real-project-task-a-aligned-results.json), [`docs/production/bounded-real-project-task-a-aligned-report.md`](../../docs/production/bounded-real-project-task-a-aligned-report.md)
  - Task B Results & Report: [`scratch/bounded-real-project-task-b-results.json`](../../scratch/bounded-real-project-task-b-results.json), [`docs/production/bounded-real-project-task-b-report.md`](../../docs/production/bounded-real-project-task-b-report.md)
  - Task C Results & Report: [`scratch/bounded-real-project-task-c-results.json`](../../scratch/bounded-real-project-task-c-results.json), [`docs/production/bounded-real-project-task-c-report.md`](../../docs/production/bounded-real-project-task-c-report.md)
  - Task D Results & Report: [`scratch/bounded-real-project-task-d-results.json`](../../scratch/bounded-real-project-task-d-results.json), [`docs/production/bounded-real-project-task-d-report.md`](../../docs/production/bounded-real-project-task-d-report.md)
- **Related ADRs**: ADR-0001 (Engineering Constitution), ADR-0003 (Workspace & Typed Tools), ADR-0004 (Tool Execution Gateway), ADR-0029 (Standardized Model Contracts), ADR-0032 (Local Model Prerequisites)

---

## 1. Context

Emerald Agent Fabric is an experimental research-grade infrastructure for safely executing software engineering agents under strict capability boundaries. The system prioritizes correctness, security, reproducible evidence, and deterministic verification over unconstrained feature velocity.

Previous benchmark campaigns evaluated autonomous multi-step software repair using small local open-weight language models (`qwen2.5-coder:3b`, `qwen2.5-coder:1.5b`, `smollm2:1.7b`, `granite3-dense:2b`) operating on commodity CPU-first developer hardware (approx. 7.63 GiB RAM, 0 VRAM, ₹0 budget). Under fully autonomous execution without human intervention, those evaluations established severe capability ceilings:
1. Small models frequently failed to construct multi-file repair strategies.
2. Inaccurate or non-matching search anchors caused fail-closed execution halts (ADR-0032).
3. Autonomous multi-step loops exhibited high risks of wandering, repetitive malformed edits, or unverified mutations.

To establish whether small local models possess genuine practical utility in real-world software development without compromising system safety, a four-task bounded operational evaluation (Tasks A through D) was conducted on the genuine, production-grade `emerald-agent-fabric` repository.

---

## 2. Evaluation Scope

The four operational trials were executed against genuine production modules under frozen resource constraints (local `qwen2.5-coder:3b` via Ollama HTTP `http://127.0.0.1:11434`, CPU-only, ₹0 operating cost, zero external data transmission, zero automatic Git commits):

- **Task A — Real-Project Read**: Evaluated whether the local model could adhere strictly to the canonical `read_file` contract (`{"path": string}`) and safely inspect genuine production code ([`src/production/diagnostics/source-diagnostic-engine.ts`](../../src/production/diagnostics/source-diagnostic-engine.ts)).
- **Task B — Human-Approved Edit**: Evaluated whether the agent could identify a boundary check omission in [`src/tools/production-tools.ts`](../../src/tools/production-tools.ts) (`toolReadFile`), propose an exact line-anchored edit, submit to human review and explicit approval, and apply the modification under capability fence `WRITE_TEMPORARY_OUTPUT`.
- **Task C — Defect Localization**: Evaluated whether the model could inspect genuine code, identify a candidate runtime failure mode in `toolWriteFile` (unhandled Node.js `EISDIR` crash on existing directory paths), and confirm the defect empirically in an isolated test harness without modifying project source code.
- **Task D — Human-Approved Repair**: Evaluated whether the confirmed `toolWriteFile` directory-path defect could be safely reproduced in an isolated temporary directory, repaired via a local model proposal, reviewed and approved by a human operator, applied via `LineAnchoredEditor`, and verified against automated regression and invariant checks.

---

## 3. Evidence Summary

### 3.1 Operational Task Matrix

| Task | Target Module | Intended Objective | Human Review Gate | Mutation Executed | Independent Verification | Final Classified Outcome | Inference Latency |
| :--- | :--- | :--- | :---: | :---: | :--- | :--- | :---: |
| **Task A** | `source-diagnostic-engine.ts` | Canonical `read_file` inspection | N/A (Read-only) | No (0 bytes) | Sovereign verify + 3-sweep replay | `END_TO_END_READ_SUCCESS` | 27,624 ms |
| **Task B** | `src/tools/production-tools.ts` | Add regular-file check in `toolReadFile` | Yes (`ApprovalControl`) | Yes (+5 lines) | Vitest 20/20 + Sovereign + Replay | `VERIFIED_HUMAN_APPROVED_EDIT` | 96,738 ms |
| **Task C** | `src/tools/production-tools.ts` | Localize `toolWriteFile` `EISDIR` defect | N/A (Read-only) | No (0 bytes) | Isolated empirical reproduction | `DEFECT_CONFIRMED_UNREPAIRED` | 29,708 ms |
| **Task D** | `src/tools/production-tools.ts` | Repair `toolWriteFile` directory defect | Yes (`ApprovalControl`) | Yes (+4 lines) | Direct probe + Full Suite 140/140 | `VERIFIED_HUMAN_APPROVED_REPAIR` | 47,446 ms |

### 3.2 Key Empirical Findings

1. **Structured Proposal Adherence**: When prompts provided a minimal, canonical JSON example matching the strict Zod schema (`.strict()`), local `qwen2.5-coder:3b` achieved 100% schema validity across all four tasks (4/4 valid proposals).
2. **Anchor Uniqueness**: In both editing tasks (B and D), search anchors matched exactly once in the target file (1 occurrence). No fuzzy matching, heuristic fallback, or multi-site ambiguity occurred.
3. **Capability Fencing and Governance**: All mutations were strictly bounded by `CapabilityFenceEnforcer` under capability `WRITE_TEMPORARY_OUTPUT`. Attempted unauthorized tool invocations (such as calling tools omitted from fence scopes) were deterministically denied fail-closed with governance control code `N711`.
4. **Historical Invariant Preservation**: Across all four trials, all historical artifacts from Phases 1–99 and the Phase 10H 36-record diagnostic dataset remained 100% byte-for-byte intact (verified by SHA-256 digests).
5. **Human Approval Reliability**: The `ApprovalControl` gate blocked execution prior to any on-disk mutation. In both mutation tasks, the exact diff was inspected and approved by the human operator before invocation of `LineAnchoredEditor`.

---

## 4. Decision

Emerald Agent Fabric adopts **Bounded Human-in-the-Loop Single-File Repair** as the recommended operating posture for local open-weight models.

The evidence supports a controlled human-in-the-loop pilot for developer-assisted single-file defect repair under strict runtime governance.

**Autonomous multi-file software engineering agents remain explicitly UNSUPPORTED.** The architecture strictly rejects unsupervised, multi-step autonomous mutation loops when operating with small local models.

---

## 5. Operating Boundaries & Governance Policy

The operating policy describes current implemented runtime controls and enforces strict separation between permitted operations and out-of-scope behaviors.

### 5.1 Permitted Operations (Governed Runtime Controls)

1. **Read-Only Source Inspection**: Querying workspace state via typed read-only tools (`read_file`, `search_code`, `git_status`, `git_diff`) under capability `READ_WORKSPACE` or `READ_REPOSITORY`.
2. **Bounded Defect Localization**: Diagnosing code defects and executing non-destructive empirical reproduction inside isolated temporary sandboxes without modifying repository source.
3. **Single-File Line-Anchored Edits**: Applying localized mutations targeting at most one file using `edit_file_anchor`, requiring exact string matching (unique anchor match count = 1).
4. **Explicit Blocking Human Approval**: Demanding mandatory operator review and explicit sign-off in `ApprovalControl` prior to executing any mutation tool.
5. **Independent Automated Verification**: Running targeted regression tests, clean-room sovereign verification (`ProductionVerifier`), and 3-sweep deterministic replay (`ProductionReplayEngine`) on all applied mutations.
6. **Fail-Closed Enforcement**: Deterministically rejecting invalid schemas, ambiguous anchors, unauthorized capabilities, and unsafe paths.

### 5.2 Explicitly Outside Approved Scope

1. **Autonomous Multi-File Repair**: Multi-file refactoring, coordinated cross-module changes, or multi-step autonomous editing loops without human intervention.
2. **Unreviewed Production Mutations**: Bypassing `ApprovalControl` or applying uninspected model proposals directly to disk.
3. **Automated Git Operations**: Executing automated `git commit`, `git push`, `git checkout`, `git reset`, or `git clean` commands.
4. **External or Proprietary Inference**: Routing repository contents or inference requests to external cloud services or proprietary model APIs.
5. **Unsubstantiated Claims**: Claiming general developer productivity gains, autonomous software engineering capabilities, or broad statistical reliability without rigorous comparative baselines.

*Note on Enforcement*: This policy describes actual implemented runtime mechanisms (`CapabilityFenceEnforcer`, `ApprovalControl`, `LineAnchoredEditor`, `ProductionVerifier`). Documentation alone does not enforce controls; runtime enforcement is strictly programmatic.

---

## 6. Technical Review & Invariant Audits

During closeout inspection of the Task D implementation and evidence, two technical limitations were audited:

### 6.1 Error Semantics Classification

- **Reported Claim**: The Task D report characterized the directory-path rejection in `toolWriteFile` as a "controlled domain error" or "typed domain error".
- **Source Inspection**: Inspection of [`src/tools/production-tools.ts`](../../src/tools/production-tools.ts) (line 275) reveals:
  ```typescript
  if (fs.existsSync(safePath) && !fs.statSync(safePath).isFile()) {
    throw new Error(`Target path is not a regular file: ${rawPath}`);
  }
  ```
- **Discrepancy Finding**: The error thrown is a generic JavaScript `Error`, not a subclass of `DomainError` from [`src/domain/errors.ts`](../../src/domain/errors.ts) (such as `ToolExecutionError` or `SecurityConstraintError`). While it successfully prevents an unhandled raw Node.js OS exception (`EISDIR`) and returns a controlled failure payload (`{ success: false, error: "Target path is not a regular file: ..." }`), it lacks a typed domain `.code` property.
- **Architectural Resolution**: Future tool framework refactoring should standardize all tool-level rejections onto formal `DomainError` subclasses. Code modification is deferred to avoid unverified changes during closeout.

### 6.2 Filesystem Concurrency and TOCTOU

- **Inspection**: In `toolWriteFile`, path validation and file writing proceed sequentially:
  ```typescript
  if (fs.existsSync(safePath) && !fs.statSync(safePath).isFile()) {
    throw new Error(`Target path is not a regular file: ${rawPath}`);
  }
  fs.writeFileSync(safePath, content, "utf8");
  ```
- **Limitation Analysis**: There is a theoretical Time-of-Check-to-Time-of-Use (TOCTOU) race condition between `fs.statSync()` and `fs.writeFileSync()`. If a concurrent external operating system process replaces `safePath` with a directory or symlink between the check and the write, `fs.writeFileSync` could encounter an unexpected filesystem state.
- **Containment Assessment**:
  1. `this.resolveSafePath(rawPath, workspacePath)` enforces strict path canonicalization and directory containment, blocking directory traversal attacks (`../`).
  2. `CapabilityFenceEnforcer` restricts execution to bounded single-tenant developer workspaces.
  3. Emerald does not run untrusted concurrent background workers within the same workspace sandbox.
- **Distinction Between Theoretical Race and Demonstrated Exploit**: This is a theoretical concurrency race window on multi-process filesystems, not an empirically demonstrated vulnerability or exploit in Emerald's local execution model.
- **Risk Scope**: Containment, capability fencing, and process sandboxing mitigate internal blast radius, but do NOT eliminate all external filesystem race conditions if an untrusted concurrent OS process modifies files in the same workspace directory.
- **Recommendation**: In a future hardening release, file mutation should transition to atomic file descriptor operations (`fs.openSync` with `O_CREAT | O_WRONLY | O_NOFOLLOW` / `O_EXCL`, followed by `fstatSync(fd)` and `writeSync(fd)`). No code changes are authorized during this closeout review.

---

## 7. Known Limitations

1. **Small Sample Size (N=4)**: The evaluation examined four discrete operational tasks across a single codebase. While qualitative feasibility was demonstrated, this does not constitute a broad statistical reliability proof.
2. **Inference Latency on CPU**: Model inference times ranged from 27.6 seconds to 96.7 seconds per turn on CPU. While acceptable for human-in-the-loop assist workflows, it is poorly suited for rapid interactive conversational programming.
3. **No Longitudinal Productivity Baseline**: The trial demonstrated technical feasibility and safety, but did not measure developer productivity gains against an unassisted baseline.
4. **Single-File Repair Boundary**: Small models cannot reliably reason about cross-module semantic dependencies or coordinate multi-file refactoring.
5. **Absence of Atomic Rollback Across Tool Steps**: If a sequence of multiple tools is executed and a subsequent step fails, earlier modifications remain on disk unless explicitly reverted by the developer.
6. **Interpretation of Verification and Replay**:
   - *Deterministic Replay*: Establishes repeatability of the recorded evidence capture and reconstruction pipeline, not underlying model reasoning correctness.
   - *Sovereign Verification*: Establishes that the configured verification stages passed for the targeted files, not universal functional correctness across untested inputs or edge cases.
7. **Human Approval Dependency**: Operational safety depends strictly on the approval gate remaining mandatory, granular, and unbypassed; an inattentive or automated approval would eliminate this core defense-in-depth layer.

---

## 8. Security and Reliability Considerations

Emerald's multi-layered defense-in-depth model prevented catastrophic failure during the trials:
1. **Capability Fencing**: Restricts tools to explicit whitelist scopes (`allowedCapabilities`, `allowedTools`, `allowedWorkspacePaths`).
2. **Approval Control**: Eliminates unsupervised mutations by demanding human operator authorization for all state-modifying actions.
3. **Line-Anchored Patching**: Eliminates hallucinated file truncation or unintended line deletions common in full-file model rewrites.
4. **Sovereign Verification**: Verifies workspace git clean state and ensures that only the intended target files are modified.
5. **Zero-Trust Token Management**: Zero external credentials or network requests entered the model context or agent sandbox.

---

## 9. Alternatives Considered

1. **Fully Autonomous Multi-Step Repair**: Rejected. Small local models lack the planning depth and state-tracking fidelity required for reliable autonomous software engineering. Autonomous loops incur high risks of drift, anchor mismatch, and regression.
2. **Bounded Human-in-the-Loop Single-File Repair**: **Accepted / Recommended**. Supported by empirical evidence from Tasks A–D. Achieves zero-cost, verifiable defect repair while keeping the human developer authoritative.
3. **Read-Only Diagnostics and Inspection Only**: Rejected as the sole supported mode. While safe, it prematurely discards the verified utility of line-anchored patch generation.
4. **Suspending All Agent Operations Pending Model Upgrades**: Rejected. The empirical results demonstrate that with strict governance and human-in-the-loop gates, 3B parameter models are already effective for localized maintenance tasks.

---

## 10. Consequences

### Positive Consequences
- Developers can safely delegate targeted single-file defect repairs and boundary-check additions to local models at ₹0 cost.
- All code changes are backed by cryptographically verifiable evidence bundles and reproducible replay records.
- Security and governance invariants remain intact with zero risk of unauthorized repository modifications or commits.

### Negative Consequences / Constraints
- Every code modification requires developer attention and manual approval.
- Repairs are strictly restricted to single files.
- Developers must tolerate 30–90 second inference pauses per proposal on commodity CPU hardware.

---

## 11. Revisit Criteria

This architecture decision must be formally revisited if any of the following conditions are met:
1. **Multi-File Rollback Infrastructure**: A transactional workspace snapshot and rollback mechanism is implemented and validated.
2. **Evaluation Scaling**: A benchmark evaluation demonstrates >= 90% sovereign-verified repair success across >= 50 diverse multi-file tasks.
3. **Model Scaling Feasibility**: A hardware-feasible, locally deployable model (e.g. 7B–14B) demonstrates measurable multi-file planning competence without exceeding host memory budgets (ADR-0032).
4. **Atomic File Descriptor I/O**: The tool execution gateway is upgraded to atomic file descriptor operations, formally eliminating the TOCTOU concurrency race.
5. **Formal Domain Error Harmonization**: All tool failure paths are migrated to typed subclasses of `DomainError`.

---

## 12. References

- **Master Engineering Constitution**: [`GEMINI.md`](../../GEMINI.md)
- **ADR-0001**: Master Engineering Constitution Version 1.0
- **ADR-0003**: Workspace and Typed Tools
- **ADR-0004**: Tool Execution Gateway and Adapter Boundary
- **ADR-0029**: RFC Standardized Model-Facing Tool Contracts
- **ADR-0032**: Local Model Scaling and Repair Benchmark Prerequisites
- **Task A Report**: [`docs/production/bounded-real-project-task-a-aligned-report.md`](../../docs/production/bounded-real-project-task-a-aligned-report.md)
- **Task B Report**: [`docs/production/bounded-real-project-task-b-report.md`](../../docs/production/bounded-real-project-task-b-report.md)
- **Task C Report**: [`docs/production/bounded-real-project-task-c-report.md`](../../docs/production/bounded-real-project-task-c-report.md)
- **Task D Report**: [`docs/production/bounded-real-project-task-d-report.md`](../../docs/production/bounded-real-project-task-d-report.md)
