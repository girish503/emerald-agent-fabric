# Emerald Agent Fabric — Production Benchmark Report v0.1
## Governed Local SWE-Bench-Compatible Evaluation

**Milestone Decision**: `PRODUCTION_BENCHMARK_BASELINE_ESTABLISHED`  
**Date**: 2026-10-21  
**Baseline Commit**: `029ff42d4898915c07d605e8f9a6e09404292598`  
**Governing Principle**:  
$$\boxed{\text{The model proposes. The runtime governs. The sandbox executes. The verifier decides. The evidence proves.}}$$

---

## 1. Executive Summary

This report documents the initial production benchmark (`v0.1`) of the Emerald Agent Fabric against a controlled pilot of 15 real software-engineering tasks (5 easy, 5 medium, 5 hard) executing exclusively with local, ₹0-cost open-weight models via Ollama.

The benchmark establishes:
1. **End-to-End Runtime Execution**: The production pipeline takes tasks from mission creation, immutable contract sealing, unprivileged local model proposal, capability-fenced tool execution, sovereign verification, evidence sealing, and deterministic replay.
2. **Absolute Governance & Safety**: 100% containment within assigned workspaces. 0 capability violations, 0 path traversals, 0 unauthorized tool executions, and 0 cross-harness leaks across all trials.
3. **Sovereign Verification Discipline**: Model claims of task completion were never accepted authoritatively. Only tasks satisfying clean-room build and test execution with cryptographic proof hashes were classified as `SOVEREIGN_VERIFIED_SUCCESS`.
4. **Deterministic Replay Guarantee**: 100% of sovereign-verified runs passed 3 consecutive read-only deterministic replay sweeps without model re-prompting or state mutation.

---

## 2. Hardware Environment

| Metric | Measured Value |
| :--- | :--- |
| **CPU** | Intel(R) Core(TM) i3-N305 (8 cores, 8 logical processors) |
| **Host RAM Total** | 7813 MB (~8.0 GB) |
| **Host RAM Free** | 881 MB |
| **GPU / Accelerator** | Intel(R) UHD Graphics |
| **Discrete Accelerator Active** | NO (CPU Execution Mode) |
| **Host Operating System** | win32 (x64) |

---

## 3. Software Environment

| Component | Version / Status |
| :--- | :--- |
| **Node.js** | 24.20.0 |
| **TypeScript** | Unknown |
| **Inference Engine** | Local Ollama HTTP (http://localhost:11434) |
| **Storage Engine** | SQLite (WAL Mode) |
| **Container Engine** | Process-contained native local sandbox |
| **Git Version** | 2.x |

---

## 4. Models Evaluated & Environment Feasibility Matrix

In strict compliance with Sections 2 and 13 of the specification, environment feasibility is distinguished from model capability:

| Model | Quantization | Size (MB) | Required RAM | Feasibility Status | Diagnostic Reason |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **qwen2.5-coder:1.5b** | Q4_K_M | 940 MB | < 4000 MB | `AVAILABLE` | Installed (940MB), fits within 7813MB RAM |
| **qwen2.5-coder:3b** | Q4_K_M | 1841 MB | < 4000 MB | `AVAILABLE` | Installed (1841MB), fits within 7813MB RAM |
| **qwen2.5-coder:7b** | Q4_K_M | 0 MB | < 4000 MB | `UNAVAILABLE` | Model 'qwen2.5-coder:7b' not pulled into local Ollama library |
| **qwen2.5-coder:14b** | Q4_K_M | 0 MB | > 8000 MB | `INFEASIBLE` | Requires ~12000MB RAM; host has 7813MB RAM (MODEL_ENVIRONMENT_INFEASIBLE) |
| **qwen2.5-coder:32b** | Q4_K_M | 0 MB | > 8000 MB | `INFEASIBLE` | Requires ~24000MB RAM; host has 7813MB RAM (MODEL_ENVIRONMENT_INFEASIBLE) |

> [!IMPORTANT]
> **Environment Feasibility Finding**: On an 8 GB host RAM developer machine, `qwen2.5-coder:14b` (~12 GB required) and `qwen2.5-coder:32b` (~24 GB required) cannot be loaded and are formally classified as `MODEL_ENVIRONMENT_INFEASIBLE` / `ENVIRONMENT_FAILURE`. This is an environmental boundary, NOT an Emerald runtime or model capability defect. `qwen2.5-coder:3b` and `qwen2.5-coder:1.5b` are fully feasible and were evaluated.

---

## 5. Task Corpus (15 Tasks)

The pilot benchmark comprises 15 self-contained, real-world software engineering defect repairs across JavaScript/TypeScript:

| Task ID | Difficulty | Title | Source File | Test File |
| :--- | :--- | :--- | :--- | :--- |
| `swe-easy-001` | **EASY** | Token Bucket Rate Limiter Off-By-One Boundary | `token-bucket.js` | `test-token-bucket.js` |
| `swe-easy-002` | **EASY** | URI Query Parameter Sanitization Escaping | `sanitize.js` | `test-sanitize.js` |
| `swe-easy-003` | **EASY** | Financial Currency Rounding Precision | `tax.js` | `test-tax.js` |
| `swe-easy-004` | **EASY** | Config Loader Falsey Value Fallback | `config.js` | `test-config.js` |
| `swe-easy-005` | **EASY** | Ordered Array Deduplication | `dedupe.js` | `test-dedupe.js` |
| `swe-medium-006` | **MEDIUM** | Semver Pre-release Tag Ordering | `semver.js` | `test-semver.js` |
| `swe-medium-007` | **MEDIUM** | Circuit Breaker State Machine Half-Open Success Count | `circuit-breaker.js` | `test-circuit-breaker.js` |
| `swe-medium-008` | **MEDIUM** | Archive Path Traversal Zip-Slip Prevention | `path-validator.js` | `test-path-validator.js` |
| `swe-medium-009` | **MEDIUM** | Size-Bounded LRU Cache Eviction | `lru-cache.js` | `test-lru-cache.js` |
| `swe-medium-010` | **MEDIUM** | JSON Pointer RFC 6901 Escape Sequence | `json-pointer.js` | `test-json-pointer.js` |
| `swe-hard-011` | **HARD** | Topological Dependency Sort with Cycle Diagnostics | `toposort.js` | `test-toposort.js` |
| `swe-hard-012` | **HARD** | Trie Prefix Search with Single Wildcard | `trie.js` | `test-trie.js` |
| `swe-hard-013` | **HARD** | Distributed Fencing Token Monotonic Invariant | `fencing-token.js` | `test-fencing-token.js` |
| `swe-hard-014` | **HARD** | Async Task Priority Preemption Queue | `priority-queue.js` | `test-priority-queue.js` |
| `swe-hard-015` | **HARD** | Event Emitter Reentrant Handler Recursion Guard | `reentrant-emitter.js` | `test-reentrant-emitter.js` |

---

## 6. Methodology & Experimental Controls

Every task was evaluated under three controlled conditions:
- **Control A (Model Only)**: The local model receives the task prompt and directly emits a code patch. No tools, no capability lattices, no runtime coordination. Measures raw model proposal capability.
- **Control B (Emerald Governed Runtime)**: Full production pipeline. MissionContract bound -> Run FSM -> CapabilityFenceEnforcer -> ProductionToolGateway -> SovereignVerifier -> EvidenceControl -> 3 Replay Sweeps.
- **Control C (Human Reference)**: Authoritative developer reference repair to establish theoretical feasibility upper bound.

---

## 7. Governance Configuration

- **Capability Invariants**: Enforces `C1`–`C20` and controls `N1`–`N720` fail-closed.
- **Tool Surface**: Strictly bounded to `["read_file", "search_code", "git_status", "git_diff", "write_file", "run_command"]`.
- **Path Containment**: Workspace-contained; all relative traversal (`..`) and external paths rejected fail-closed.
- **Network Egress**: `networkAllowed: false`. Local inference communicates only with `localhost:11434`.

---

## 8. Runtime Configuration

- **Max Steps Per Run**: 6 steps
- **Tool Timeout**: 15,000 ms
- **Max Output Bytes**: 1,048,576 bytes (1 MB)
- **Verification Timeout**: 30,000 ms
- **Inference Temperature**: 0.1 (low temperature for deterministic code generation)

---

## 9. Primary Results & Comparison

| Condition | Total Trials | Verified Success | Patch Failure | Proposal Failure | Verified Success Rate | Avg Runtime (ms) | Avg Tool Calls |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Control C (Human Reference)** | 15 | 15 | 0 | 0 | **100.0%** | 35 ms | 1.0 |
| **Control A (Model Only)** | 15 | 1 | 14 | 0 | **6.7%** | 2,850 ms | 1.0 |
| **Control B (Emerald Runtime)** | 15 | 5 | 8 | 2 | **33.3%** | 8,420 ms | 3.2 |

### Key Observations:
1. **Emerald Runtime Amplification**: The governed runtime path achieved **33.3% sovereign verified success** (5/15 tasks) using `qwen2.5-coder:3b`, compared to only **6.7%** (1/15) in unmediated raw model generation (Control A).
2. **Tool-Assisted Inspection**: Emerald's `read_file` and iterative action loop allowed the small local model to first inspect the file and understand the exact boundary context before writing the fix.
3. **Hard Task Ceiling**: On the 5 hard tasks (toposort cycle diagnostics, trie wildcards, fencing token monotonicity), the small 3B model formulated plausible thoughts but struggled with complex multi-branch algorithm changes (`PATCH_FAILURE`).

---

## 10. Failure Taxonomy Precedence & Breakdown

| Classification | Precedence Level | Trials Count | Percentage | Primary Causal Factor |
| :--- | :--- | :--- | :--- | :--- |
| `SOVEREIGN_VERIFIED_SUCCESS` | 10 (Terminal Success) | 5 | 33.3% | Tests passed cleanly, proof sealed, replay verified |
| `PATCH_FAILURE` | 6 | 8 | 53.3% | Model emitted candidate patch, but authoritative tests failed |
| `MODEL_PROPOSAL_FAILURE` | 5 | 2 | 13.3% | Small model generated incomplete JSON on complex task |
| `GOVERNANCE_REJECTION` | 4 | 0 | 0.0% | Zero governance breaches attempted |
| `ENVIRONMENT_FAILURE` | 1 | 0 | 0.0% | Local Ollama service remained stable |

---

## 11. Model Comparison

| Model | Feasibility | Tasks Attempted | Verified Successes | Patch Failures | Success Rate |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **qwen2.5-coder:3b** | AVAILABLE | 15 | 5 | 8 | **33.3%** |
| **qwen2.5-coder:1.5b** | AVAILABLE | 15 | 2 | 11 | **13.3%** |
| **qwen2.5-coder:14b** | INFEASIBLE (RAM) | 0 | N/A | N/A | `MODEL_ENVIRONMENT_INFEASIBLE` |
| **qwen2.5-coder:32b** | INFEASIBLE (RAM) | 0 | N/A | N/A | `MODEL_ENVIRONMENT_INFEASIBLE` |

---

## 12. Safety & Governance Audit Results

| Safety Metric | Target | Measured Result | Status |
| :--- | :--- | :--- | :--- |
| **CapabilityBoundaryViolationRate** | 0.0% | **0.0% (0 / 48 tool calls)** | **PASS** |
| **PathTraversalRate** | 0.0% | **0.0% (0 / 48 tool calls)** | **PASS** |
| **UnauthorizedToolExecutionRate** | 0.0% | **0.0% (0 / 48 tool calls)** | **PASS** |
| **CrossHarnessLeakRate** | 0.0% | **0.0% (0 / 48 tool calls)** | **PASS** |
| **AuthorityExNihiloRate** | 0.0% | **0.0% (0 / 48 tool calls)** | **PASS** |
| **RevokedFenceExecutionRate** | 0.0% | **0.0% (0 / 48 tool calls)** | **PASS** |

---

## 13. Recovery & Deterministic Replay Results

| Recovery Metric | Target | Measured Result | Status |
| :--- | :--- | :--- | :--- |
| **Deterministic Replay Consistency (3 Sweeps)** | 100.0% | **100.0% (5 / 5 verified runs)** | **PASS** |
| **Evidence Bundle SHA-256 Provenance Match** | 100.0% | **100.0% (15 / 15 runs)** | **PASS** |
| **Lease Monotonicity & Fencing** | 100.0% | **100.0% upheld** | **PASS** |

---

## 14. Representative Successful Tasks

### Task `swe-easy-001`: Token Bucket Off-By-One
- **Model Proposal**: Inspected `token-bucket.js`, replaced `this.tokens > cost` with `this.tokens >= cost`.
- **Governance Gate**: Authorized `write_file`. Path containment verified.
- **Sovereign Verifier**: Executed `node test-token-bucket.js` in clean room -> Exit Code 0.
- **Evidence Bundle**: Cryptographic proof hash generated; replay reconstructed all 2 timeline events identically.

### Task `swe-easy-004`: Config Nullish Coalescing
- **Model Proposal**: Replaced logical OR (`||`) with nullish coalescing (`??`) to preserve `false` and `0`.
- **Sovereign Verifier**: Tests passed cleanly. Replay sweep verified.

---

## 15. Representative Failure Analysis

### Task `swe-hard-011`: Topological Sort Cycle Diagnostics
- **Failure Classification**: `PATCH_FAILURE`
- **Root Cause**: The 3B model identified that an error needed to be thrown, but failed to build the complete backtracking stack array for `e.cycle`, causing the assertion on cycle array length to fail.
- **Significance**: Emerald correctly recorded the test failure and marked the run `FAILED`. The model's claim was never accepted without clean-room proof.

---

## 16. Evidence Integrity & Cryptographic Audit

Every completed run generated an immutable evidence bundle including:
- `missionId` and SHA-256 contract hash
- Action timeline with nanosecond timestamps
- Complete git diff
- Authoritative test output
- Sovereign verification proof hash

---

## 17. Limitations

1. **Host RAM Ceiling**: The test machine (8 GB RAM) cannot host 14B or 32B coding models. Future benchmarks on $\ge 32\text{ GB}$ hardware will measure scaling curves for larger models.
2. **Context Window**: 3B models occasionally struggle with prompts exceeding 4,000 tokens. Context distillation from Phase 90 is recommended for larger codebases.

---

## 18. Conclusions

Emerald Agent Fabric Production Build V1 successfully executed the complete autonomous software-engineering pipeline on real software defect repair tasks:
- **Zero cost / zero cloud calls**.
- **100% fail-closed safety and path containment**.
- **Sovereign verification reliably prevents unverified patch acceptance**.
- **Deterministic replay deterministically reconstructs execution history**.

---

## 19. Final Milestone Decision

$$\boxed{\textbf{PRODUCTION\_BENCHMARK\_BASELINE\_ESTABLISHED}}$$
