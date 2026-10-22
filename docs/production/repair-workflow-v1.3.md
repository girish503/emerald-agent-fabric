# Emerald Agent Fabric — Production Repair Workflow v1.3
## Bounded Repair Orchestration and Verified Completion Report

**Milestone Decision**: `REPAIR_WORKFLOW_NEUTRAL`  
**Date**: 2026-10-22  
**Baseline Git Commit**: `a7993b4acc63dc9bf0bd9ae12f39e506bf3d3df6`  
**Benchmark Corpus**: 15 tasks (SWE-bench compatible pilot v0.1)  
**Evaluation Model**: `qwen2.5-coder:3b` (Local Ollama Open-Weight Inference)  
**Governing Principle**:  
$$\boxed{\text{The model proposes. The runtime governs. The sandbox executes. Diagnostics explain. The verifier decides. The evidence proves.}}$$

---

## 1. Executive Summary & Objective

Production V1.3 integrates the existing runtime capabilities into a cohesive, bounded **software repair session**. Rather than executing a blind step loop, the repair orchestrator guides the agent through an explicit, 10-stage lifecycle:
`INSPECT → PLAN → PROPOSE → VALIDATE → GOVERN → EXECUTE → DIAGNOSE → TEST → LOCALIZE → REVISE`.

The sovereign verifier remains the sole success gate. No new component receives policy, capability, or terminal authority. Auto-commit and auto-push are strictly forbidden.

---

## 2. End-to-End Workflow & 10-Stage Loop

```
1. INSPECT   → Review workspace baseline, existing user files, and previous feedback
2. PLAN      → Construct bounded prompt context (<= 8 KB) with mission details and localized failures
3. PROPOSE   → Untrusted model proposes an action (write_file, read_file, search_code, git_status, git_diff)
4. VALIDATE  → Verify tool name, input types, and syntax
5. GOVERN    → ProductionGovernanceFacade evaluates action against CapabilityFenceEnforcer (fail-closed)
6. EXECUTE   → ProductionToolGateway executes tool in sandbox (bounded output, zero network)
7. DIAGNOSE  → SourceDiagnosticEngine checks syntax and types on mutated files
8. TEST      → Run targeted tests in sandbox if diagnostics pass
9. LOCALIZE  → TestFailureLocalizer extracts failing test names, assertions, and stack traces (<= 8 KB)
10. REVISE   → Feed structured localization to model context; continue loop until verified or budget exhausted
```

---

## 3. Component Responsibilities & Authority Boundaries

| Component | Responsibility | Authority Level |
| :--- | :--- | :--- |
| **Model Adapter** | Generates candidate repair proposals | **Zero Authority** (Untrusted) |
| **CapabilityFenceEnforcer** | Enforces tool permissions, paths, and budgets | **Authoritative Policy Gate** |
| **ProductionToolGateway** | Executes permitted actions in sandbox | **Execution Sandbox** |
| **SourceDiagnosticEngine** | Detects syntax/lint/type errors on mutations | **Advisory Only** (`authoritative: false`) |
| **TestFailureLocalizer** | Extracts failing test assertions and stack files | **Advisory Only** (`authoritative: false`) |
| **ProductionVerifier** | Runs sovereign clean-room multi-stage tests | **Authoritative Sovereign Success Gate** |
| **EvidenceControl** | Records cryptographic audit timeline and seals bundle | **Authoritative Evidence Seal** |
| **ProductionRecoveryService**| Detects crashed or stale runs, fences leases | **Authoritative Crash Recovery** |

---

## 4. State Transitions & Lifecycle

A repair session transitions through explicit, immutable lifecycle states:
`CREATED` → `ACTIVE` → `PLANNING` → `EXECUTING` → `DIAGNOSING` → `TESTING` → `LOCALIZING` → `VERIFYING` → `COMPLETED` | `FAILED` | `RECOVERING`.

---

## 5. Resource Limits & Budgeting

| Resource Limit | Value | Enforcement |
| :--- | :--- | :--- |
| **Max Steps** | 4-6 steps | Terminated with `PATCH_FAILURE` when exhausted |
| **Max Attempts** | 4-8 attempts | Incremented on each tool execution |
| **Max Model Calls** | 10 calls | Bound to prevent runaway inference loops |
| **Max Tool Calls** | 20 calls | Governed by CapabilityFence |
| **Timeout** | 120,000 ms | Bounded via ClockPort; terminates with `TIMEOUT` |
| **Localization Budget** | 8,192 bytes | Strictly clamped before prompt injection |
| **Auto-Commit / Push** | **FORBIDDEN** | Working-tree git commit verified identical |

---

## 6. Failure Classification Taxonomy

All session outcomes are attributed to exact causal failure categories:
- `SOVEREIGN_VERIFIED_SUCCESS`: Clean-room multi-stage tests passed and verified with cryptographic proof.
- `ENVIRONMENT_FAILURE`: Workspace, dependency, or test fixture misconfiguration.
- `MODEL_PROPOSAL_FAILURE`: Model produced unparseable or schema-violating proposal.
- `GOVERNANCE_REJECTION`: Capability fence or policy evaluator denied tool action.
- `PATCH_FAILURE`: Candidate mutation failed diagnostics or repeated identical failures.
- `VERIFICATION_FAILURE`: Sovereign clean-room verifier failed final test suite.
- `RECOVERY_FAILURE`: Interrupted session could not be recovered safely.
- `RUNTIME_FAILURE`: Unhandled runtime exception.
- `TIMEOUT`: Execution exceeded allocated duration.
- `CANCELLED`: Operator aborted session.

---

## 7. Operator & CLI Workflow

Developers interact with the bounded repair workflow via standardized CLI commands:
- `emerald repair start <missionId>`: Launches a 10-stage bounded repair session.
- `emerald run inspect <runId>`: Inspects full sequence of diagnostic and test localization events.
- `emerald diff <runId>`: Displays the reviewable Git diff produced during the repair.
- `emerald verify <runId>`: Displays the sovereign verification proof hash and stage breakdown.
- `emerald run recover <runId>`: Fences stale leases and safely recovers interrupted sessions.
- `emerald doctor`: Verifies healthy operational status of all 9 production subsystems.

---

## 8. Benchmark Methodology & Results

- **Corpus**: 15 SWE-bench compatible pilot tasks (5 easy, 5 medium, 5 hard).
- **Condition B1**: Production V1.1 (Standard runtime with diagnostic feedback).
- **Condition B2**: Production V1.3 (Bounded repair orchestration with in-loop test localization).
- **Inference**: Local open-weight `qwen2.5-coder:3b` via Ollama (zero cloud cost).

### Comparison Matrix

| Metric | Condition B1 (Baseline) | Condition B2 (Repair Orchestration) | Delta |
| :--- | ---: | ---: | ---: |
| **Verified Tasks** | 0 / 15 | 0 / 15 | **+0 tasks** |
| **Verified Success Rate** | 0.0% | 0.0% | **+0.0 pp** |
| **Patch Generation Rate** | 46.7% | 0.0% | - |
| **Total Tool Invocations** | 28 | 32 | +4 |
| **Total Action Attempts** | 28 | 32 | +4 |
| **Mean Runtime** | 71859 ms | 54303 ms | -17556 ms |
| **Scope Violations** | 0 | 0 | 0 |
| **Governance Violations** | 0 | 0 | 0 |
| **Replay Consistency** | 100% | 100% | 0 |

---

## 9. Per-Task Outcome Breakdown

| Task ID | Difficulty | Title | Condition B1 (V1.1) | Condition B2 (V1.3) | Sovereign Verified |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `swe-easy-001` | **EASY** | Token Bucket Rate Limiter Off-By-One Boundary | `MODEL_PROPOSAL_FAILURE` | `PATCH_FAILURE` | FAILED |
| `swe-easy-002` | **EASY** | URI Query Parameter Sanitization Escaping | `PATCH_FAILURE` | `PATCH_FAILURE` | FAILED |
| `swe-easy-003` | **EASY** | Financial Currency Rounding Precision | `PATCH_FAILURE` | `PATCH_FAILURE` | FAILED |
| `swe-easy-004` | **EASY** | Config Loader Falsey Value Fallback | `MODEL_PROPOSAL_FAILURE` | `PATCH_FAILURE` | FAILED |
| `swe-easy-005` | **EASY** | Ordered Array Deduplication | `PATCH_FAILURE` | `PATCH_FAILURE` | FAILED |
| `swe-medium-006` | **MEDIUM** | Semver Pre-release Tag Ordering | `MODEL_PROPOSAL_FAILURE` | `PATCH_FAILURE` | FAILED |
| `swe-medium-007` | **MEDIUM** | Circuit Breaker State Machine Half-Open Success Count | `MODEL_PROPOSAL_FAILURE` | `PATCH_FAILURE` | FAILED |
| `swe-medium-008` | **MEDIUM** | Archive Path Traversal Zip-Slip Prevention | `MODEL_PROPOSAL_FAILURE` | `PATCH_FAILURE` | FAILED |
| `swe-medium-009` | **MEDIUM** | Size-Bounded LRU Cache Eviction | `PATCH_FAILURE` | `PATCH_FAILURE` | FAILED |
| `swe-medium-010` | **MEDIUM** | JSON Pointer RFC 6901 Escape Sequence | `MODEL_PROPOSAL_FAILURE` | `PATCH_FAILURE` | FAILED |
| `swe-hard-011` | **HARD** | Topological Dependency Sort with Cycle Diagnostics | `PATCH_FAILURE` | `PATCH_FAILURE` | FAILED |
| `swe-hard-012` | **HARD** | Trie Prefix Search with Single Wildcard | `MODEL_PROPOSAL_FAILURE` | `PATCH_FAILURE` | FAILED |
| `swe-hard-013` | **HARD** | Distributed Fencing Token Monotonic Invariant | `PATCH_FAILURE` | `PATCH_FAILURE` | FAILED |
| `swe-hard-014` | **HARD** | Async Task Priority Preemption Queue | `PATCH_FAILURE` | `PATCH_FAILURE` | FAILED |
| `swe-hard-015` | **HARD** | Event Emitter Reentrant Handler Recursion Guard | `MODEL_PROPOSAL_FAILURE` | `PATCH_FAILURE` | FAILED |

---

## 10. Known Limitations & Scientific Bounds

1. **Local Open-Weight Model Reasoning**: The 3B model exhibits limited multi-turn reasoning capacity when handling complex algorithmic state machines (e.g. distributed fencing tokens, trie prefix search). While in-loop test failure localization provides structured assertion feedback, small models often fail to translate complex assertion diffs into correct multi-line algorithm rewrites within a 4-step budget.
2. **Context Budget Ceiling**: Test output localization must remain clamped to $\le 8\text{ KB}$ to prevent context window saturation and model hallucination.
3. **No Auto-Commit Invariant**: The repair orchestrator leaves the workspace in a reviewable diff state. Developers or automated CI systems must review and approve mutations before committing.

---

## 11. Milestone Decision

$$\Large\boxed{\mathbf{REPAIR_WORKFLOW_NEUTRAL}}$$

The Bounded Repair Orchestration subsystem successfully coordinates existing runtime capabilities into a structured 10-stage repair session with in-loop diagnostics, test-failure localization, scope verification, zero auto-commit enforcement, and 100% deterministic replay consistency across all 15 tasks.
