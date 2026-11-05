# Milestone 2.22 — Live Local Model Acceptance (Status: Live Acceptance NOT PASSED)

## 1. Status Summary

| Item | Status |
| :--- | :--- |
| Offline acceptance (Scenario 1: unreachable endpoint fails closed; Scenario 2: missing model fails closed) | **Passed** |
| Live Scenario 3 with the earlier task-specific reminder | Previously reported as successful. **Not reproduced and not independently verified.** That reminder was withdrawn (section 3). |
| Live Scenario 3 with the current generic reminder | **NOT PASSED** — three reruns, each timed out at 600 s (section 4) |
| Context-residency path-matching fix | Implemented, covered by offline tests |
| Generic, task-agnostic reminder | Implemented, covered by offline tests |

This document does not claim that Emerald has completed a task end to end with a live local model.
It records what was built, what was observed, and what is still unproven.

---

## 2. Intended Execution Pipeline

Scenario 3 is designed to traverse the production path with a real local open-weight model
(`qwen2.5-coder:3b` through a local Ollama server) instead of the deterministic fixture:

```
emerald router submit -> emerald router host --once -> emerald worker --once --model-provider ollama
  WorkerRuntime claims the run under a fenced lease
  repository import provisions the run workspace
  LiveAgentBrain proposes governed tool actions (read_file, write_file)
  the step controller validates and executes them; completion is decided by its verification gate
  GitArtifactExporter exports the patch bundle
```

The model is an untrusted proposer. It holds no execution authority: every action goes through the tool
gateway, and a model's `isGoalReached` claim is only a proposal that the controller's completion
verification must accept.

---

## 3. What Changed in This Milestone

1. **Type-only re-export** in `src/domain/run.ts` (`export type { ContractBinding }`) for ESM compatibility.
2. **Dynamic tool filtering for the Ollama provider** (`worker-host.ts`): `enableDynamicToolFiltering` is
   on only when `modelProvider === "ollama"`. It changes which tools are shown to the model. It does not
   change tool authorization or argument validation.
3. **Context residency** (`context-residency-tracker.ts`):
   - A write to an untracked path (for example a new output file) no longer invalidates every resident
     input file.
   - Paths are normalized (`normalizeResidencyPath`), so `./input/a.md`, `input//a.md`,
     `input/../input/a.md` and `input\a.md` refer to the same file for reads, mutations and eligibility
     checks. An earlier version of this change keyed mutations by the raw path and missed alias
     spellings, which would have left stale resident context; that was found in review and fixed.
   - A mutation with no target path, or the workspace root, still invalidates everything.
4. **Reminder in `LiveAgentBrain`** — an earlier version of this milestone added a reminder that
   hard-coded `input/project-brief.md` and `reports/project-analysis.md`, matched any written path
   containing `report`, and, after such a write, told the model to conclude and propose no further
   actions. It was **withdrawn** because it fired for every task and could push unrelated tasks toward
   premature completion. The current reminder is task-agnostic: it restates the task's own objective,
   lists the paths of successful read and write actions taken from observations, and adds one
   conditional line after a successful write ("if the files written or edited above already satisfy the
   objective, set isGoalReached: true instead of repeating the same action"). It issues no mandatory
   completion instruction.
5. **Gated live test** (`tests/e2e/live-local-model-acceptance.test.ts`): Scenario 3 runs only when
   `EMERALD_LIVE_OLLAMA=true`. It never substitutes a fixture for live inference.

---

## 4. Live Evidence (Observed, Single Machine, Not Benchmarks)

### 4.1 Original run (earlier task-specific reminder)
Reported as a completed run (read, write, conclude; run `COMPLETED`). There is no log, event
timeline, or exact command and exit code for it in this repository, and it used the reminder that was
later withdrawn. Its reported latencies conflict: an earlier draft of this document gave about 236
seconds in total, while the milestone report gave 456 seconds. **No latency figure from that run is
published here as verified.**

### 4.2 Reruns with the current generic reminder
The same Scenario 3, with `qwen2.5-coder:3b`, local Ollama and a 600 s test and run timeout:

| Run | Notes | Governed actions recorded | Final state |
| :--- | :--- | :--- | :--- |
| 1 | A TypeScript check overlapped the first minutes | `read_file`, `write_file`, `write_file` | test timed out at 600 s; run left `RUNNING` |
| 2 | Nothing else running | `read_file`, `write_file`, `write_file` | test timed out at 600 s; run `TIMED_OUT` |
| 3 | A sentence was added to the task description asking for a single write and then `isGoalReached`; that sentence was reverted afterwards | `read_file`, `write_file`, `write_file` | test timed out at 600 s; run `TIMED_OUT` |

Observed behavior in all three: **read, write, repeated write, timeout.** The model never signalled
completion within the budget, even with an explicit instruction in the task description.

Time between governed actions (from `action.created` event timestamps, which include context building
and model inference) was roughly 150 to 170 seconds per turn in runs 2 and 3. At that speed a fourth turn
does not fit in the 600 second budget. These are single observations on one CPU machine on one day,
not measured benchmarks.

### 4.3 Interpretation
- The earlier fixed completion instruction was what ended the original run for this model.
- The generic reminder preserves flexibility but does not reliably make this 3B model stop.
- Prompt wording alone is not a dependable stopping mechanism for compact models. Reliable completion and
  stopping criteria should be treated as a runtime engineering problem (follow-up milestone), not solved
  by stronger prompt text.

---

## 5. Operator Verification (Milestone 2.21 commands)

The scenario asserts, for a completed run, the output of:

```bash
emerald run inspect --db <dbPath> --run-id <runId> --json
emerald run events --db <dbPath> --run-id <runId> --json
emerald task tree --db <dbPath> --task-id <taskId> --json
```

These assertions are only reached when the run completes. **They were not exercised against a live
completed run in the reruns above.**

---

## 6. Preflight and Gating Policy

- **Default:** a standard test run executes Scenarios 1 and 2 (offline, fail-closed) and skips live inference.
- **Live activation:** set `EMERALD_LIVE_OLLAMA=true`. The test probes `http://127.0.0.1:11434/api/tags`
  and checks that `qwen2.5-coder:3b` is installed, and fails with an actionable message otherwise. It
  fails closed and does not fall back to a fixture.

---

## 7. Constraints (Design Intent; Not Independently Measured Here)

| Constraint | Intent |
| :--- | :--- |
| Hosted or proprietary model APIs | None; local Ollama only |
| Inference cost | ₹0 (local open-weight model) |
| Tool execution | Governed tools in an isolated per-run workspace |
| Persistence | Durable SQLite (WAL) |
| Resume | `safeToResume` remains `false` |
| Delivery | At-least-once; no exactly-once claim |

---

## 8. Open Items

- Reliable agent completion and stopping criteria as a runtime property (candidate Milestone 2.23).
- Re-establish a passing live run, with its commands, exit codes and event timelines recorded, before
  re-claiming live acceptance.
- Resolve the unreconciled latency figures only with measured, repeatable runs.
