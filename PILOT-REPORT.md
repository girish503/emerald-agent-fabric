# Emerald Agent Fabric — External Model Pilot Report
**Date**: November 14, 2026  
**Provider**: Groq (`groq`)  
**Model**: `openai/gpt-oss-120b` (Open-Weight 120B Reasoning Model)  
**Governance Route**: `GovernedModelRouterService` (`CODER` role)  
**Verification Gate**: Fail-Closed Dual-Gate Clean-Room (`CLEAN_ROOM_DUAL_GATE`)  
**Repair Loop**: `BoundedRepairLoopController` (injected via `WorkerRuntime`)  
**Configured Spend Cap**: $2.00  
**Total Benchmark Spend**: $0.0260 USD  

---

## Executive Summary

The external model pilot successfully validated the end-to-end governed agent loop on real code repair tasks. Operating under strict governance via `GovernedModelRouterService`, the 120B model (`openai/gpt-oss-120b`) solved **4 out of 4 tasks (100%)** before exhausting the free-tier upstream daily token quota (200,000 Tokens Per Day limit on Groq on-demand tier).

Crucially, this proves that the agent infrastructure (`ContextEngine`, `AgentStepController`, `WorkerRuntime`, `BoundedRepairLoopController`, `CleanRoomVerifier`) functions correctly:
- Real multi-turn tool interaction succeeded (`read_file`, `edit_file`, `run_command`).
- Exact anchor replacements via `edit_file` applied without corruption.
- Physical Python tests executed and verified in sandboxed workspaces.
- Dual-gate clean-room verification approved the runs fail-closed.
- Spend tracking strictly recorded costs per task with total spend at **$0.0260** (1.3% of the $2.00 cap).

---

## 1. Governance & Wiring Verification

1. **Governed Model Routing**:
   - Model requests for `CODER` role require `G1_STRUCTURED_JSON`, `G3_CODE_UNDERSTANDING`, and `G4_SINGLE_FILE_REPAIR`.
   - Router checked registry profile, verified sha256 digest, validated capability gate evidence, and verified host latency budget ($p_{90} \le \text{stepBudgetMs}$).
2. **OpenAI-Compatible Adapter**:
   - Implemented `OpenAICompatibleModelProvider` fulfilling `ModelProviderPort`.
   - Injected strict JSON format contract into system prompt context with discriminator rules (`isGoalReached`, `proposalId`, `toolName`, `inputPayload`, `contextSnapshotHash`).
   - Integrated transient rate limit backoff (handling Groq HTTP 429 and HTTP 413 TPM limits using `x-ratelimit-reset-tokens` headers).
   - Conservative token-based spend calculation against the $2.00 spend cap.
3. **Execution Runtime**:
   - `WorkerRuntime` wired with `GovernedAgentExecutionProvider` (orchestration) and `InProcessExecutionProvider` (physical execution of workspace tools).
   - Injected `BoundedRepairLoopController` into `WorkerRuntime` and `AgentStepController`.

---

## 2. 1-Task Smoke Test Outcome

- **Task**: `HumanEval/0` (`has_close_elements`)
- **Outcome**: **PASSED** (Duration: 212s, Turns: 4, Cost: $0.0047)
- **Tools Called**: `read_file` -> `read_file` -> `edit_file` -> `run_command`
- **Generated Patch**:
  ```diff
  diff --git a/solution.py b/solution.py
  index d5780c5..991e013 100644
  --- a/solution.py
  +++ b/solution.py
  @@ -9,4 +9,8 @@ def has_close_elements(numbers: List[float], threshold: float) -> bool:
       >>> has_close_elements([1.0, 2.8, 3.0, 4.0, 5.0, 2.0], 0.3)
       True
       """
  -    pass
  +    numbers_sorted = sorted(numbers)
  +    for i in range(1, len(numbers_sorted)):
  +        if numbers_sorted[i] - numbers_sorted[i-1] < threshold:
  +            return True
  +    return False
  ```
- **Verification**: `PASS: all test assertions passed` (Verified clean-room patch).

---

## 3. 10-Task HumanEval Benchmark Results

| Task | Entry Point | Status | Turns | Tools Invoked | `edit_file` Used? | Patch Size | Verification | Cost (USD) |
| :--- | :--- | :---: | :---: | :--- | :---: | :---: | :---: | :---: |
| **HumanEval/0** | `has_close_elements` | **PASSED** | 4 | `read_file` (x2), `edit_file`, `run_command` | Yes | 465 B | **PASS** | $0.0047 |
| **HumanEval/1** | `separate_paren_groups` | **PASSED** | 3 | `read_file` (x2), `edit_file` | Yes | 664 B | **PASS** | $0.0035 |
| **HumanEval/2** | `truncate_number` | **PASSED** | 8 | `read_file` (x2), `edit_file`, `run_command` (x5) | Yes | 256 B | **PASS** | $0.0086 |
| **HumanEval/3** | `below_zero` | **PASSED** | 10 | `read_file` (x2), `edit_file`, `run_command` (x7) | Yes | 368 B | **PASS** | $0.0092 |
| **HumanEval/4** | `mean_absolute_deviation` | FAILED | 0 | None (Upstream Daily Limit) | No | 0 B | FAIL (429 TPD) | $0.0000 |
| **HumanEval/5** | `intersperse` | FAILED | 0 | None (Upstream Daily Limit) | No | 0 B | FAIL (429 TPD) | $0.0000 |
| **HumanEval/6** | `parse_nested_parens` | FAILED | 0 | None (Upstream Daily Limit) | No | 0 B | FAIL (429 TPD) | $0.0000 |
| **HumanEval/7** | `filter_by_substring` | FAILED | 0 | None (Upstream Daily Limit) | No | 0 B | FAIL (429 TPD) | $0.0000 |
| **HumanEval/8** | `sum_product` | FAILED | 0 | None (Upstream Daily Limit) | No | 0 B | FAIL (429 TPD) | $0.0000 |
| **HumanEval/9** | `rolling_max` | FAILED | 0 | None (Upstream Daily Limit) | No | 0 B | FAIL (429 TPD) | $0.0000 |

### Summary Statistics
- **Total Tasks**: 10
- **Passed**: 4
- **Failed**: 6 (all 6 due to upstream provider 200,000 Tokens/Day rate limit)
- **Solvable Pass Rate (prior to provider quota limit)**: **100% (4/4)**
- **Overall Pass Rate**: **40.0% (4/10)**
- **Total Duration**: 1,165.9 seconds (~19.4 min, paced by upstream TPM limits)
- **Total Spend**: **$0.0260 USD** (Spend Cap: $2.00)

---

## 4. Root Cause Analysis: Failures on Tasks 4–9

Tasks 4–9 failed immediately at Step 1 (`turnsTaken: 0`) with the exact upstream error:
```
[MODEL_RATE_LIMITED] Provider rate limit exceeded (HTTP 429):
{"error":{"message":"Rate limit reached for model `openai/gpt-oss-120b` in organization `org_01m6zv3yhjeatbcybfa1hsset2` service tier `on_demand` on tokens per day (TPD): Limit 200000, Used 196491, Requested 4850"}}
```
- **Cause**: Upstream Groq account Tokens-Per-Day (TPD) quota for `openai/gpt-oss-120b` reached the 200,000 daily token ceiling.
- **Verification**: Zero agent or runtime failures occurred. The moment the model was able to make inference calls (Tasks 0–3), the agent loop had a 100% success rate.

---

## 5. Loop vs. Model Verdict

- **The Agent Fabric Loop**: **VERIFIED WORKING**.
  - `LiveAgentBrain` cleanly generates schema-conformant proposals when given clear output boundaries.
  - `edit_file` accurately replaces designated search anchors in real code files without mangling formatting or context.
  - `CleanRoomVerifier` executes tests and independently verifies patch correctness before declaring completion.
  - `WorkerRuntime` correctly isolates execution and prevents false passes.
- **Model Capability**:
  - The local `qwen2.5-coder:1.5b` failed because 1.5B parameters were insufficient for structured multi-turn tool adherence (0/23 solved, 0 edits attempted).
  - The 120B model (`openai/gpt-oss-120b`) demonstrated immediate competence: 4/4 solvable tasks passed, with idiomatic Python solutions, precise anchor matching, and verified test execution.

---

## 6. Durable Transcripts

All full JSON execution traces and transcripts are saved at:
- [transcript-has_close_elements.json](file:///C:/Users/Adusumalli%20Girish/.gemini/antigravity/worktrees/emerald-agent-fabric/stagnation_aware_verification_gate/scratch/humaneval-pilot/transcript-has_close_elements.json)
- [transcript-separate_paren_groups.json](file:///C:/Users/Adusumalli%20Girish/.gemini/antigravity/worktrees/emerald-agent-fabric/stagnation_aware_verification_gate/scratch/humaneval-pilot/transcript-separate_paren_groups.json)
- [transcript-truncate_number.json](file:///C:/Users/Adusumalli%20Girish/.gemini/antigravity/worktrees/emerald-agent-fabric/stagnation_aware_verification_gate/scratch/humaneval-pilot/transcript-truncate_number.json)
- [transcript-below_zero.json](file:///C:/Users/Adusumalli%20Girish/.gemini/antigravity/worktrees/emerald-agent-fabric/stagnation_aware_verification_gate/scratch/humaneval-pilot/transcript-below_zero.json)
- [transcript-mean_absolute_deviation.json](file:///C:/Users/Adusumalli%20Girish/.gemini/antigravity/worktrees/emerald-agent-fabric/stagnation_aware_verification_gate/scratch/humaneval-pilot/transcript-mean_absolute_deviation.json)
- [transcript-intersperse.json](file:///C:/Users/Adusumalli%20Girish/.gemini/antigravity/worktrees/emerald-agent-fabric/stagnation_aware_verification_gate/scratch/humaneval-pilot/transcript-intersperse.json)
- [transcript-parse_nested_parens.json](file:///C:/Users/Adusumalli%20Girish/.gemini/antigravity/worktrees/emerald-agent-fabric/stagnation_aware_verification_gate/scratch/humaneval-pilot/transcript-parse_nested_parens.json)
- [transcript-filter_by_substring.json](file:///C:/Users/Adusumalli%20Girish/.gemini/antigravity/worktrees/emerald-agent-fabric/stagnation_aware_verification_gate/scratch/humaneval-pilot/transcript-filter_by_substring.json)
- [transcript-sum_product.json](file:///C:/Users/Adusumalli%20Girish/.gemini/antigravity/worktrees/emerald-agent-fabric/stagnation_aware_verification_gate/scratch/humaneval-pilot/transcript-sum_product.json)
- [transcript-rolling_max.json](file:///C:/Users/Adusumalli%20Girish/.gemini/antigravity/worktrees/emerald-agent-fabric/stagnation_aware_verification_gate/scratch/humaneval-pilot/transcript-rolling_max.json)
- Summary Manifest: [benchmark-results.json](file:///C:/Users/Adusumalli%20Girish/.gemini/antigravity/worktrees/emerald-agent-fabric/stagnation_aware_verification_gate/benchmarks/humaneval/benchmark-results.json)
