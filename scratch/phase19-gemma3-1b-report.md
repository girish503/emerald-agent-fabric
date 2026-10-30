# EMERALD AGENT FABRIC
## PHASE 19 — GEMMA3:1B LOCAL CAPABILITY LOWER-BOUND REPORT

### 1. Objective
Establish a lower-bound empirical data point for Emerald's local CPU model capability curve using the pre-installed `gemma3:1b` (815 MB, ~1B parameters) running under the completely frozen Phase 16 Condition A production interface at ₹0 cost.

### 2. Frozen Baseline
- **HEAD Commit**: `70979cf4bcbf4a237b79af3a23449a4b932104d5`
- **Tracked Tree**: 0 modifications (`git diff --check` clean)
- **Production Architecture**: Byte-for-byte frozen across `src/domain/`, `src/application/`, `src/adapters/`, and `src/ports/`.

### 3. Hardware
- **CPU**: Intel(R) Core(TM) i3-N305 (8 physical/logical Gracemont E-cores, base 1.80 GHz)
- **RAM**: 8.0 GB total (7,813 MiB visible, ~1.4 GB free)
- **GPU**: Intel(R) UHD Graphics (integrated, shared system memory, no dedicated VRAM)
- **Accelerator**: None (no CUDA, no ROCm, no Metal; Ollama 0.40.6 running 100% CPU-only)
- **OS**: Microsoft Windows 11 Home (Version 10.0.26200, 64-bit)

### 4. Model Metadata
- **Identifier**: `gemma3:1b`
- **Ollama Digest**: `83be9dbf9dd6`
- **Reported Parameters**: 999.89M (~1B)
- **Quantization**: Q4_K_M
- **Disk Footprint**: 815 MB
- **Context Length**: 32,768
- **Runner**: llamacpp (CPU)

### 5. Gate A — Inference Feasibility
- **Timeout Budget**: 120,000 ms (120s)
- **Wall-Clock Latency**: 57,100 ms (57.1s)
- **Response Status**: `RECEIVED`
- **Raw Output**: `{"isGoalReached": true, "proposalId": "action-12345678-9012-3456-7890-123456789012","contextSnapshotHash": "60086905e911784d8de0588e5cd675b2ab959f77cd061c52ea4b3543f89a4f86"}`
- **Parsed Proposal**: `null` (Output matched `anyOf[0]` goal-reached schema rather than `anyOf[1]` tool-action proposal schema)
- **Proposal Validity**: `false` (`NO_PROPOSAL_PARSED`)
- **Classification**: `MODEL_SCHEMA_FAILURE`

### 6. Gate B — Full Governed Run
- **Status**: `NOT_RUN` (Halted per Section 5 stop conditions: Gate A failed to produce a valid action proposal).

### 7. Step-by-Step Trace
- **Step 1**: Dispatched task directive and full tool catalog to `gemma3:1b`.
  - Input Prompt: 6,975 bytes.
  - Context Snapshot: 3,297 bytes (Hash: `60086905e911784d8de0588e5cd675b2ab959f77cd061c52ea4b3543f89a4f86`).
  - Output Generation: Completed in 57.1s.
  - Decision: Model bypassed file inspection (`read_file`) and emitted a premature completion claim (`isGoalReached: true`) with synthetic `proposalId`.
  - Termination: Gate A failed; execution stopped.

### 8. Proposal Validation
- The model generated syntactically valid JSON conforming to the first branch of the `action_proposal` union schema (`isGoalReached: true`).
- However, on Step 1, with zero tool executions and a pending task, claiming goal completion without proposing an action fails the prerequisite for tool execution.
- In `LiveAgentBrain`, an `isGoalReached: true` signal produces `finishReason: "GOAL_REACHED"` with `proposal: undefined`.
- `ProposalValidator` requires an `ActionProposal` containing `toolName` and `inputPayload`. Because none was provided, proposal validation failed (`NO_PROPOSAL_PARSED`).

### 9. Tool Execution
- **Physical Tools Executed**: 0.
- `gemma3:1b` did not request `read_file`, `git_status`, or any other registered tool.

### 10. Observation Following
- **Status**: Not tested. The model failed prior to receiving any tool execution observations.

### 11. Coding Correctness
- **Status**: Not tested. The model produced zero lines of code, placeholder, or diff.

### 12. Schema Behavior
- Conformed to strict JSON structure.
- Selected `isGoalReached: true` (union branch 0) rather than `isGoalReached: false` with tool arguments (union branch 1).
- Correctly mirrored the exact `contextSnapshotHash` from prompt context (`60086905e911784d8de0588e5cd675b2ab959f77cd061c52ea4b3543f89a4f86`).
- Hallucinated a synthetic RFC-like UUID (`action-12345678-9012-3456-7890-123456789012`).

### 13. Recovery
- **Status**: Not tested (Gate A single-step boundary).

### 14. Physical Mutation
- **Mutations Observed**: 0 (workspace untouched).

### 15. Capability Depth
- **Maximum Depth**: **DEPTH 0** (Model responded).
- Did not reach Depth 1 (Valid action proposal).

### 16. Clean-Room Verification
- **Status**: Not reached.

### 17. Governance
- Zero authority leakage.
- Emerald's fail-closed governance prevented invalid completion claims from modifying state or advancing to execution.

### 18. Latency
- **Step 1 Latency**: 57.1 seconds (57,100 ms).
- Confirms CPU inference feasibility (<120s ceiling).

### 19. Cross-Phase Model Capability Comparison

| Dimension | `gemma3:1b` (Phase 19) | `qwen2.5:1.5b` (Phase 15E/16) | `llama3.2:3b` (Phase 14) | `deepseek-r1:8b` (Phase 17) |
|---|---|---|---|---|
| **Parameters** | 1.0B | 1.5B | 3.2B | 8.2B |
| **Disk Footprint** | 815 MB | 986 MB | 2.0 GB | 5.2 GB |
| **Step 1 CPU Latency** | 57.1s | 49.8s – 69.4s | ~120s | >600s (Timeout) |
| **Step 1 Decision** | Premature `isGoalReached: true` | Valid `read_file` proposal | Valid `read_file` proposal | No tokens emitted |
| **Physical Mutations** | 0 | 1 (`write_file`) | 1 (`write_file`) | 0 |
| **Max Capability Depth** | **Depth 0** | **Depth 5** | **Depth 5** | **Depth 0** |
| **Primary Failure Mode** | Schema/Premature Completion | `contentHash` Hallucination Loop | Planning/Placeholder Code | CPU Timeout |

### 20. Primary Classification
```
PRIMARY CLASSIFICATION: MODEL_SCHEMA_FAILURE
```

### 21. Regression Audit
- `npx tsc --noEmit`: 0 errors.
- Phase 14 clean-room integration tests: 11/11 passed.
- Full integration test suite: 83 passed, 1 skipped (84 total).
- Phase 10H artifact verification: 36/36 records, 9/9 SHA-256 hashes byte-for-byte intact.
- Git working tree: Clean (0 tracked modifications).

### 22. Evidence Paths
- JSON Report: `scratch/phase19-gemma3-1b-report.json`
- Markdown Report: `scratch/phase19-gemma3-1b-report.md`
- Benchmark Runner: `scripts/run-phase19-benchmark.ts`

### 23. What This Proves
1. Sub-1B models (`gemma3:1b`) are CPU-inference feasible on an Intel i3-N305 (57.1s latency).
2. However, `gemma3:1b` lacks the task-understanding and schema-following capacity to propose tool actions, immediately taking the trivial `isGoalReached: true` escape path.
3. Therefore, the lower capability bound for tool-governed execution in Emerald lies strictly above 1.0B parameters on CPU.

### 24. What This Does Not Prove
1. Does not prove fine-tuned 1B models or coding-specialized 1B models cannot follow tool schemas.
2. Does not evaluate multi-step recovery if prompted interactively.

### 25. Recommended Phase 20
Conclude the local sub-3B CPU model capability benchmarking series (Phases 14–19) and convene an Architectural Decision Record (ADR) on enabling external reference model inference (e.g., Anthropic Claude / OpenAI / Google Gemini) to definitively validate Emerald's clean-room verification and end-to-end completion loop.
