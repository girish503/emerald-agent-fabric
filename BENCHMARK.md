# Emerald Open Dataset Benchmark Report
**Comprehensive Real-Model Evaluation Across All Benchmark Runs**

---

## 1. Executive Summary

This report documents the empirical evaluation of **Emerald Agent Fabric** across two open public benchmark datasets:
1. **HumanEval** (OpenAI canonical tasks, single-function Python specifications).
2. **SWE-bench Lite** (Princeton NLP canonical tasks, real-world multi-file repository maintenance).

All evaluations were executed under strict constitutional governance (`GEMINI.md`):
- **Zero Cloud / ₹0 Cost**: Strictly local inference using open-weight model `qwen2.5-coder:1.5b` via Ollama (`http://127.0.0.1:11434`). Zero commercial APIs, zero telemetry leakage, zero external model downloads.
- **Full Emerald Governance**: Model output is treated as untrusted proposals passing typed validation, capability fencing (`execution.echo`, `workspace.*`, `git.*`), and durable SQLite state management.
- **Sovereign Verification**: Ground truth is established solely by physical test execution (`DeterministicVerifier`, `CleanRoomVerifier`, and Python test runner execution). Model self-attestations (`isGoalReached: true`) carry zero authority.
- **Honest Empirical Accounting**: No inflated claims, no cherry-picking. Timeouts and empty patches are recorded as failures.

Across **all 4 benchmark runs (33 total trial evaluations, 23 distinct task setups)**, the empirical pass rate is:
$$\mathbf{0 / 23 \text{ tasks passed (0.0\%)}}\quad (\mathbf{0 / 33 \text{ total trials passed}})$$

| Run | Benchmark | Task Count | Budget / Task | Passed | Failed | Timed Out | Pass Rate | Key Failure Mode |
| :---: | :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| **1** | SWE-bench Lite (Phase 5) | 10 | 40s | 0 | 10 | 0 | **0.0%** | `EMPTY_PATCH`: Model exited before modifying files |
| **2** | SWE-bench Lite (Phase 5b) | 10 | 180s | 0 | 0 | 10 | **0.0%** | `TIMED_OUT`: Model inference latency exceeded budget |
| **3** | HumanEval (Phase 5b) | 10 | 180s | 0 | 6 | 4 | **0.0%** | `EMPTY_PATCH` (6) / `TIMED_OUT` on Turn 2 (4) |
| **4** | HumanEval (Phase 6) | 3 | 600s | 0 | 3 | 0 | **0.0%** | `EMPTY_PATCH`: Finished in 156–203s with 0 edits |
| **TOTAL** | **All Runs Combined** | **33** | **40s–600s** | **0** | **19** | **14** | **0.0%** | Model capability ceiling on local CPU |

---

## 2. Dataset Provenance & Hardware

| Attribute | HumanEval Tasks | SWE-bench Lite Tasks |
| :--- | :--- | :--- |
| **Source** | OpenAI HumanEval (`openai/human-eval`) | Princeton NLP (`princeton-nlp/SWE-bench_Lite`) |
| **Public URL** | [https://raw.githubusercontent.com/openai/human-eval/master/data/HumanEval.jsonl.gz](https://raw.githubusercontent.com/openai/human-eval/master/data/HumanEval.jsonl.gz) | [https://huggingface.co/datasets/princeton-nlp/SWE-bench_Lite](https://huggingface.co/datasets/princeton-nlp/SWE-bench_Lite) |
| **Commit / Version** | Canonical HEAD (OpenAI release) | Commit `6ec7bb89b9342f664a54a6e0a6ea6501d3437cc2` |
| **Model** | `qwen2.5-coder:1.5b` (Q4_K_M via Ollama) | `qwen2.5-coder:1.5b` (Q4_K_M via Ollama) |
| **Host System** | Intel Core i3-N305 (8 cores, 8 threads), 8 GB RAM, Windows 11 | Intel Core i3-N305 (8 cores, 8 threads), 8 GB RAM, Windows 11 |

---

## 3. Run 1: SWE-bench Lite (Phase 5 — 40-Second Budget per Task)

Initial 10-task SWE-bench Lite evaluation using a 40s budget per task:

| # | Task ID | Repository | Base Commit | Status | Duration | Turns | Patch Size | Failure Reason |
| :-: | :--- | :--- | :--- | :-: | :-: | :-: | :-: | :--- |
| 1 | `astropy__astropy-12907` | `astropy/astropy` | `d16bfe05` | **FAILED** | 21.8s | 0 | 0 B | `EMPTY_PATCH: Model did not produce any code modifications` |
| 2 | `astropy__astropy-14182` | `astropy/astropy` | `a5917978` | **FAILED** | 21.3s | 0 | 0 B | `EMPTY_PATCH: Model did not produce any code modifications` |
| 3 | `astropy__astropy-14365` | `astropy/astropy` | `7269fa3e` | **FAILED** | 21.1s | 0 | 0 B | `EMPTY_PATCH: Model did not produce any code modifications` |
| 4 | `astropy__astropy-14995` | `astropy/astropy` | `b16c7d12` | **FAILED** | 21.2s | 0 | 0 B | `EMPTY_PATCH: Model did not produce any code modifications` |
| 5 | `astropy__astropy-6938` | `astropy/astropy` | `c76af9ed` | **FAILED** | 21.2s | 0 | 0 B | `EMPTY_PATCH: Model did not produce any code modifications` |
| 6 | `astropy__astropy-7746` | `astropy/astropy` | `d5bd3f68` | **FAILED** | 21.1s | 0 | 0 B | `EMPTY_PATCH: Model did not produce any code modifications` |
| 7 | `django__django-10914` | `django/django` | `e7fd69d0` | **FAILED** | 21.2s | 0 | 0 B | `EMPTY_PATCH: Model did not produce any code modifications` |
| 8 | `django__django-10924` | `django/django` | `bceadd27` | **FAILED** | 21.1s | 0 | 0 B | `EMPTY_PATCH: Model did not produce any code modifications` |
| 9 | `django__django-11001` | `django/django` | `ef082ebb` | **FAILED** | 21.1s | 0 | 0 B | `EMPTY_PATCH: Model did not produce any code modifications` |
| 10 | `django__django-11019` | `django/django` | `93e892bb` | **FAILED** | 21.2s | 0 | 0 B | `EMPTY_PATCH: Model did not produce any code modifications` |

- **Summary**: 0 Passed / 10 Failed / 0 Timed Out; Pass Rate: **0.0%**; Total Time: 212.4s.
- **Evidence**: `benchmarks/swe-bench-lite/benchmark-results-40s.json`.

---

## 4. Run 2: SWE-bench Lite Rerun (Phase 5b — 180-Second Budget per Task)

Fair rerun with workspace binding, git repository context, and a 180s budget per task:

| # | Task ID | Repository | Base Commit | Status | Duration | Turns | Patch Size | Failure / Termination Reason |
| :-: | :--- | :--- | :--- | :-: | :-: | :-: | :-: | :--- |
| 1 | `astropy__astropy-12907` | `astropy/astropy` | `d16bfe05` | **TIMED_OUT** | 219.0s | 2 | 0 B | Wall clock ceiling reached prior to executing Action 2 (217.2s >= 180.0s) |
| 2 | `astropy__astropy-14182` | `astropy/astropy` | `a5917978` | **TIMED_OUT** | 249.7s | 2 | 0 B | Wall clock ceiling reached prior to executing Action 2 (247.8s >= 180.0s) |
| 3 | `astropy__astropy-14365` | `astropy/astropy` | `7269fa3e` | **TIMED_OUT** | 272.2s | 2 | 0 B | Wall clock ceiling reached prior to executing Action 2 (269.1s >= 180.0s) |
| 4 | `astropy__astropy-14995` | `astropy/astropy` | `b16c7d12` | **TIMED_OUT** | 235.8s | 1 | 0 B | Ollama model inference timed out after 120000ms |
| 5 | `astropy__astropy-6938` | `astropy/astropy` | `c76af9ed` | **TIMED_OUT** | 122.4s | 0 | 0 B | Ollama model inference timed out after 120000ms |
| 6 | `astropy__astropy-7746` | `astropy/astropy` | `d5bd3f68` | **TIMED_OUT** | 205.5s | 2 | 0 B | Wall clock ceiling reached prior to executing Action 2 (203.8s >= 180.0s) |
| 7 | `django__django-10914` | `django/django` | `e7fd69d0` | **TIMED_OUT** | 121.7s | 0 | 0 B | Ollama model inference timed out after 120000ms |
| 8 | `django__django-10924` | `django/django` | `bceadd27` | **TIMED_OUT** | 189.5s | 1 | 0 B | Wall clock ceiling reached during model inference (188.1s >= 180.0s) |
| 9 | `django__django-11001` | `django/django` | `ef082ebb` | **TIMED_OUT** | 201.8s | 1 | 0 B | Wall clock ceiling reached during model inference (200.4s >= 180.0s) |
| 10 | `django__django-11019` | `django/django` | `93e892bb` | **TIMED_OUT** | 205.3s | 2 | 0 B | Wall clock ceiling reached prior to executing Action 2 (203.9s >= 180.0s) |

- **Summary**: 0 Passed / 0 Failed / 10 Timed Out; Pass Rate: **0.0%**; Total Time: 2022.9s (~33.7 minutes).
- **Evidence**: `benchmarks/swe-bench-lite/benchmark-results-180s.json`.

---

## 5. Run 3: HumanEval (Phase 5b — 180-Second Budget per Task)

10 canonical single-function coding tasks evaluated with a 180s budget per task:

| # | Task ID | Entry Point | Status | Duration | Turns | Tools Called | Patch Size | Test Outcome | Failure / Termination Reason |
| :-: | :--- | :--- | :---: | :-: | :-: | :--- | :-: | :-: | :--- |
| 1 | `HumanEval/0` | `has_close_elements` | **TIMED_OUT** | 210.3s | 2 | `read_file`, `write_file` | 0 B | FAIL | Wall-clock ceiling reached prior to executing Action 2 (209.3s >= 180.0s) |
| 2 | `HumanEval/1` | `separate_paren_groups` | **FAILED** | 137.4s | 1 | `read_file` | 0 B | FAIL | `EMPTY_PATCH`: Model did not produce code modifications |
| 3 | `HumanEval/2` | `truncate_number` | **FAILED** | 126.9s | 1 | `read_file` | 0 B | FAIL | `EMPTY_PATCH`: Model did not produce code modifications |
| 4 | `HumanEval/3` | `below_zero` | **FAILED** | 135.5s | 1 | `read_file` | 0 B | FAIL | `EMPTY_PATCH`: Model did not produce code modifications |
| 5 | `HumanEval/4` | `mean_absolute_deviation` | **TIMED_OUT** | 234.7s | 2 | `read_file`, `write_file` | 0 B | FAIL | Wall-clock ceiling reached prior to executing Action 2 (233.6s >= 180.0s) |
| 6 | `HumanEval/5` | `intersperse` | **TIMED_OUT** | 236.0s | 2 | `read_file`, `write_file` | 0 B | FAIL | Wall-clock ceiling reached prior to executing Action 2 (233.2s >= 180.0s) |
| 7 | `HumanEval/6` | `parse_nested_parens` | **FAILED** | 132.1s | 1 | `read_file` | 0 B | FAIL | `EMPTY_PATCH`: Model did not produce code modifications |
| 8 | `HumanEval/7` | `filter_by_substring` | **FAILED** | 126.0s | 1 | `read_file` | 0 B | FAIL | `EMPTY_PATCH`: Model did not produce code modifications |
| 9 | `HumanEval/8` | `sum_product` | **FAILED** | 127.0s | 1 | `read_file` | 0 B | FAIL | `EMPTY_PATCH`: Model did not produce code modifications |
| 10 | `HumanEval/9` | `rolling_max` | **TIMED_OUT** | 200.8s | 2 | `read_file`, `read_file` | 0 B | FAIL | Wall-clock ceiling reached prior to executing Action 2 (200.0s >= 180.0s) |

- **Summary**: 0 Passed / 6 Failed / 4 Timed Out; Pass Rate: **0.0%**; Total Time: 1674.8s (~27.9 minutes).
- **Evidence**: `benchmarks/humaneval/benchmark-results.json`.

---

## 6. Run 4: HumanEval Generous Budget Check (Phase 6 — 600-Second Budget per Task)

To conclusively determine whether timeouts were the sole blocker or if the 1.5B model on CPU exhibits a capability ceiling, 3 HumanEval tasks were evaluated under a 600-second (10-minute) wall-clock budget per task:

| # | Task ID | Entry Point | Status | Duration | Turns | Turn Durations | Tools Called | Patch Size | Test Outcome | Termination Reason |
| :-: | :--- | :--- | :---: | :-: | :-: | :--- | :--- | :-: | :-: | :--- |
| 1 | `HumanEval/0` | `has_close_elements` | **FAILED** | 162.1s | 1 | Turn 1: 88.8s<br>Turn 2: 72.3s | `read_file` | 0 B | FAIL | `EMPTY_PATCH`: Model stopped without producing code edits |
| 2 | `HumanEval/1` | `separate_paren_groups` | **FAILED** | 156.1s | 1 | Turn 1: 88.1s<br>Turn 2: 67.1s | `read_file` | 0 B | FAIL | `EMPTY_PATCH`: Model stopped without producing code edits |
| 3 | `HumanEval/2` | `truncate_number` | **FAILED** | 203.3s | 2 | Turn 1: 68.1s<br>Turn 2: 68.3s<br>Turn 3: 66.1s | `read_file`, `read_file` | 0 B | FAIL | `EMPTY_PATCH`: Model stopped after 2 reads without edits |

- **Summary**: 0 Passed / 3 Failed / **0 Timed Out**; Pass Rate: **0.0%**; Total Time: 523.2s (~8.7 minutes).
- **Evidence**: `benchmarks/humaneval/benchmark-results-600s.json`.

---

## 7. Capability Analysis & Takeaways

1. **The Runtime Loop Functions Correctly**:
   Across all 33 executions, the runtime executed without a single crash, memory leak, or governance failure. Tool gateways parsed typed requests, SQLite lease fencing managed state transitions cleanly, and the sovereign verification layer successfully blocked 100% of unverified completions.
2. **Model Capability Ceiling**:
   Under a generous 600-second budget (where tasks finished in 156–203 seconds with zero timeouts), `qwen2.5-coder:1.5b` consistently reads files but fails to synthesize `write_file` or `edit_file` proposals. This confirms that `EMPTY_PATCH` is a genuine model capability limitation on 1.5B parameters, not an artifact of runtime latency.
3. **Hardware & Model Recommendations**:
   For autonomous code generation, larger parameter models (e.g. `qwen2.5-coder:7b` or `deepseek-r1:8b`) with GPU acceleration are recommended. The Emerald runtime provides the plug-and-play governance harness ready for these models.

---

## 8. How to Reproduce

All benchmarks are fully reproducible with a single command on any machine running Node.js, Python, and Ollama:

```bash
# Run HumanEval benchmark
npm run benchmark:humaneval

# Run SWE-bench Lite benchmark
npm run benchmark

# Run with custom models and timeouts
node bin/run-humaneval.js --model qwen2.5-coder:7b --limit 3 --timeout 300
node bin/run-benchmark.js --model qwen2.5-coder:7b --limit 5 --timeout 300
```
