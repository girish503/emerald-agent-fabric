# Emerald Agent Fabric — Production V1.4
## Deterministic Minimal Test Evidence Selection: Research Report

**Milestone**: Production V1.4  
**Date**: October 2026  
**Status**: COMPLETE / FROZEN  
**Empirical Decision**: `MINIMAL_TEST_EVIDENCE_NEUTRAL`  
**Baseline Commit**: `7109911fa4488c5759000fe08c3a77895ed214f4` (Production V1.3)  

---

### 1. Research Question & Hypothesis

#### Central Question
> Does filtering and prioritizing raw test-failure feedback down to a strictly bounded ($\le 4,096$ bytes), deduplicated, and prioritized subset improve autonomous repair completion in local open-weight models compared to the raw localized test output baseline?

#### Hypothesis
Local open-weight models (such as `qwen2.5-coder:3b`) operating on CPU hardware experience context saturation and distraction when presented with large raw test runner outputs containing repetitive framework traces, internal runtime stack frames, and unformatted error messages. By deterministically extracting only the highest-signal failure assertions directly tied to modified source files, we hypothesized that repair completion rates would improve and token overhead would drop.

---

### 2. Architectural Design & Security Boundaries

#### The 5 Prioritization Signals
The `MinimalTestEvidenceSelector` evaluates candidate failure records using five strictly ordered, observable signals:
1. **Concrete Failing Assertion**: Expected-versus-actual mismatches (e.g. `AssertionError`, `must equal`, `expected X to equal Y`) receive highest priority (+1000).
2. **Modified File Association**: Failures occurring in or pointing to files modified during the repair session receive secondary priority (+500).
3. **Valid Source Location**: Explicit file paths and line numbers pointing to concrete source lines receive tertiary priority (+200 with line, +100 without line).
4. **Explanatory Error Message**: Concise error messages (between 5 and 256 characters) that directly describe the observed failure receive priority (+50).
5. **Stable Lexical Tie-Breaking**: When priority scores match, candidates are ordered lexically by test name and assertion message, ensuring 100% deterministic ordering across runs.

#### Non-Authoritative Boundary
- The evidence selector operates as an advisory component.
- Output metadata explicitly asserts:
  - `authoritative: false`
  - `verificationAuthority: false`
  - `terminalAuthority: false`
- The sovereign clean-room verifier (`ProductionVerifier`) remains the sole authority for certifying run completion or failure.

#### Security Invariant: Path Traversal Immunity
- Untrusted stack traces often contain relative or absolute paths (e.g. `../../../../etc/passwd` or `C:\Windows\System32\...`).
- The selector **never** opens, reads, or stats filesystem paths extracted from test outputs. Paths are treated strictly as opaque string tokens.

#### Replay and Cryptographic Integrity
- Each selection produces two cryptographic SHA-256 digests:
  - `originalEvidenceDigest`: Hash of the complete raw summary.
  - `selectedEvidenceDigest`: Hash of the minimized model-facing text.
- Historical runs can be reconstructed deterministically by the `ProductionReplayEngine` without test execution across multiple independent sweeps.

---

### 3. Empirical Results & Measurement Gate

#### A. Mandatory Measurement Gate (Baseline vs Minimized)
Measured across all 15 SWE-bench pilot tasks (`swe-easy-001` through `swe-hard-015`):

| Metric | Condition B2 (Raw Localized) | Condition B3 (Minimal Evidence) | Delta / Improvement |
| :--- | :--- | :--- | :--- |
| **Mean Raw Test Output** | 1,921 bytes | 1,921 bytes | 0 bytes (Baseline input) |
| **Mean Model-Facing Payload** | 1,253 bytes | 507 bytes | **-746 bytes (-59.13%)** |
| **Max Model-Facing Payload** | 1,775 bytes | 530 bytes | **-1,245 bytes (-70.14%)** |
| **Feedback Truncation Rate** | 100.0% (15/15) | 0.0% (0/15) | **-100.0% (Zero truncation)** |
| **Serialized Feedback Limit** | Unbounded (up to 8KB) | Strictly $\le 4,096$ bytes | **Guaranteed context bound** |

#### B. SWE-Bench Task Outcome Comparison

| Task ID | Difficulty | Raw Bytes | B2 Bytes (Truncated) | B3 Bytes (Selected) | Reduction | B2 Outcome | B3 Outcome |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `swe-easy-001` | EASY | 1,840 B | 1,211 B (Yes) | 513 B (No) | 57.6% | PATCH_FAILURE | PATCH_FAILURE |
| `swe-easy-002` | EASY | 1,826 B | 1,198 B (Yes) | 501 B (No) | 58.2% | PATCH_FAILURE | PATCH_FAILURE |
| `swe-easy-003` | EASY | 1,921 B | 1,237 B (Yes) | 485 B (No) | 60.8% | PATCH_FAILURE | PATCH_FAILURE |
| `swe-easy-004` | EASY | 1,820 B | 1,193 B (Yes) | 496 B (No) | 58.4% | PATCH_FAILURE | PATCH_FAILURE |
| `swe-easy-005` | EASY | 1,956 B | 1,267 B (Yes) | 502 B (No) | 60.4% | PATCH_FAILURE | PATCH_FAILURE |
| `swe-medium-006` | MEDIUM | 1,824 B | 1,196 B (Yes) | 499 B (No) | 58.3% | PATCH_FAILURE | PATCH_FAILURE |
| `swe-medium-007` | MEDIUM | 1,935 B | 1,269 B (Yes) | 530 B (No) | 58.2% | PATCH_FAILURE | PATCH_FAILURE |
| `swe-medium-008` | MEDIUM | 1,848 B | 1,221 B (Yes) | 524 B (No) | 57.1% | PATCH_FAILURE | PATCH_FAILURE |
| `swe-medium-009` | MEDIUM | 1,905 B | 1,246 B (Yes) | 513 B (No) | 58.8% | PATCH_FAILURE | PATCH_FAILURE |
| `swe-medium-010` | MEDIUM | 1,850 B | 1,216 B (Yes) | 515 B (No) | 57.6% | PATCH_FAILURE | PATCH_FAILURE |
| `swe-hard-011` | HARD | 1,738 B | 1,154 B (Yes) | 501 B (No) | 56.6% | PATCH_FAILURE | PATCH_FAILURE |
| `swe-hard-012` | HARD | 1,814 B | 1,186 B (Yes) | 489 B (No) | 58.8% | PATCH_FAILURE | PATCH_FAILURE |
| `swe-hard-013` | HARD | 1,833 B | 1,210 B (Yes) | 517 B (No) | 57.3% | PATCH_FAILURE | PATCH_FAILURE |
| `swe-hard-014` | HARD | 1,852 B | 1,222 B (Yes) | 521 B (No) | 57.4% | PATCH_FAILURE | PATCH_FAILURE |
| `swe-hard-015` | HARD | 2,853 B | 1,775 B (Yes) | 505 B (No) | 71.5% | PATCH_FAILURE | PATCH_FAILURE |

---

### 4. Analysis & Decision

#### Empirical Decision: `MINIMAL_TEST_EVIDENCE_NEUTRAL`

1. **Efficiency and Noise Reduction**:
   - The selector achieved a **59.13% mean reduction** in context payload delivered to the model, eliminating extraneous vitest/jest runner noise, internal Node stack frames, and terminal escape codes.
   - Truncation frequency dropped from **100% to 0%**, ensuring that all provided failure information was structurally complete and cleanly bounded.

2. **Task Completion Invariant**:
   - Despite cleaner feedback, task completion remained at **0/15 (0.0%)** for local open-weight inference (`qwen2.5-coder:3b`).
   - Qualitative inspection of model proposals reveals that the small model's failure modes are driven by syntax errors in complex logic and incorrect semantic assumptions, rather than an inability to locate the failing assertion.
   - Minimizing evidence is beneficial for context efficiency, cost, and predictability, but is insufficient on its own to resolve semantic repair tasks without higher-capacity reasoning or targeted syntax guidance.

3. **Production Safety & Invariant Status**:
   - Zero security regressions: no path traversals, zero auto-commits, no capability authority leaks.
   - Clean-room sovereign verification preserved intact.
