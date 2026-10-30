# Integration Brief: SWE-agent — Real Tool Execution and Multi-Step Agent Loop

**Document ID**: `EAF-OSS-001`  
**Date of Inspection**: 2026-10-16  
**Status**: APPROVED FOR DESIGN (Implementation strictly deferred to Phase 11 & Phase 12)  
**Role**: Senior AI Infrastructure Engineer & Technical Co-Founder  
**Upstream System**: [SWE-agent](https://github.com/SWE-agent/SWE-agent)  
**Inspected Commit SHA**: [`3ea751c087f32b16e039a2233dd6eefecef325d5`](https://github.com/SWE-agent/SWE-agent/commit/3ea751c087f32b16e039a2233dd6eefecef325d5)  

---

## 1. Executive Summary

SWE-agent demonstrates how an autonomous software engineering agent executes tools against a live environment in a closed feedback loop. Its primary contribution is an empirical, resilient agent step loop that turns unconstrained language model completions into discrete commands, handles syntax and formatting faults gracefully without corrupting environment state, truncates massive tool observations before they cause context overflow, and serializes rich step trajectories for offline evaluation and replay.

For Emerald Agent Fabric, SWE-agent provides the architectural pattern for **Phase 11 (Real Tool Execution)** and **Phase 12 (Multi-Step Agent Loop)**. We adopt SWE-agent's observation truncation rules, bounded formatting retry loop, and trajectory serialization structure. Crucially, we **reject** SWE-agent's regex-based text parsing, unvalidated shell script execution, and unauthenticated container operations. In Emerald, every parsed action remains strictly governed by `ProposalValidator`, `Reflex`, `PolicyEvaluator`, and `ToolExecutionGateway`.

---

## 2. Research Question

> How does SWE-agent reliably bridge model generation, tool execution, and multi-step context propagation in software engineering environments, and how can those loop mechanics be integrated into Emerald's frozen governed architecture (`AgentBrain → ActionProposal → ProposalValidator → Reflex → PolicyEvaluator → ToolExecutionGateway`) without weakening capability boundaries or auditability?

---

## 3. Upstream Inspected Source Files

The following files from [`SWE-agent/SWE-agent`](https://github.com/SWE-agent/SWE-agent) at commit `3ea751c087f32b16e039a2233dd6eefecef325d5` were inspected:

1. **[`sweagent/agent/agents.py`](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/sweagent/agent/agents.py)**:
   - Lines 174–235: `TemplateConfig` and prompt template resolution (`system_template`, `instance_template`, `next_step_template`, `next_step_no_output_template`).
   - Lines 420–510: `forward_with_handling` execution method; implementation of `max_requeries = 3` on `FormatError` and `BashIncorrectSyntaxError`.
   - Lines 511–640: `step` execution loop; model invocation, thought/action parsing, environment tool dispatch, observation capture, and trajectory recording.
   - Lines 641–720: `run` entry point and termination conditions (`is_terminated`, step limit exhaustion, cost limit, unrecoverable exception).
   - Lines 721–760: `attempt_autosubmission_after_error` fail-safe diff extraction.
   - Lines 1100–1220: `TrajectoryStep` data model and trajectory JSON serialization.

2. **[`sweagent/tools/parsing.py`](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/sweagent/tools/parsing.py)**:
   - Lines 40–115: `ActionParser` abstract base class and custom exception hierarchy: `FormatError`, `BashIncorrectSyntaxError`, `_BlockedActionError`.
   - Lines 116–230: `ThoughtActionParser` extracting thought paragraphs and command blocks using regex patterns.

3. **[`sweagent/environment/swe_env.py`](https://github.com/SWE-agent/SWE-agent/blob/3ea751c087f32b16e039a2233dd6eefecef325d5/sweagent/environment/swe_env.py)**:
   - Lines 310–365: Execution timeout enforcement, output streaming, and bounded observation truncation with replacement templates.

---

## 4. Verified Upstream Findings

### 4.1 Bounded Requery on Parsing/Syntax Failures
In `sweagent/agent/agents.py` (`forward_with_handling`), SWE-agent distinguishes between **logical execution failure** (a command ran and returned non-zero) and **structural generation failure** (`FormatError`, `BashIncorrectSyntaxError`).
- When a structural failure occurs, the environment state is **not mutated**.
- The model completion is rejected before reaching container execution.
- The agent appends an error message to the conversation describing the syntax error and allows up to `max_requeries = 3` attempts to correct the syntax.
- If all requeries fail, the step aborts cleanly.

### 4.2 Bounded Observation Truncation
In `sweagent/environment/swe_env.py`, tool output is bounded by `max_observation_length` (default 50,000 characters). When exceeded, the middle or tail of the output is truncated with an explicit notice (`[... output truncated due to length ...]`). This prevents token context blowups while alerting the model that it generated excessive stdout.

### 4.3 Trajectory Recording
In `sweagent/agent/agents.py`, every step constructs a typed `TrajectoryStep`:
```python
{
    "action": action,
    "observation": observation,
    "response": model_response,
    "thought": thought,
    "execution_time": step_duration,
    "state": env_state
}
```
Trajectories are written incrementally to `.traj` files, enabling post-hoc inspection of model reasoning, tool commands, and exit statuses.

### 4.4 Autosubmission on Fatal Errors
When an unrecoverable error occurs (such as context length exhaustion or worker interruption), SWE-agent invokes `attempt_autosubmission_after_error`, which issues a `git diff` against the base commit and packages whatever valid modifications exist into a submission patch.

---

## 5. Emerald Integration Design

### 5.1 A. Adopt (What Emerald Adopts)
1. **Multi-Step Feedback Propagation**: The result of physical tool execution (`ToolExecutionResult`) must be formatted into an observation record and fed directly into the subsequent step's context window.
2. **Observation Window Bounding**: Bounding tool output at the adapter/gateway layer before context insertion. If stdout exceeds limit (e.g. 16 KB or 4,000 tokens), apply deterministic head+tail truncation with explicit truncation metadata.
3. **Bounded Proposal Requery**: When `ProposalValidator` rejects a model proposal (e.g. `INVALID_TOOL_INPUT` or malformed argument), permit up to $N=2$ within-step reprompts presenting the exact schema error without mutating domain state or dispatching tools.
4. **Trajectory Archival**: Persist complete multi-step execution traces (`stepIndex`, `modelPromptHash`, `rawCompletion`, `actionProposal`, `reflexDecision`, `policyDecision`, `toolExecutionResult`, `observation`, `durationMs`) into SQLite-backed `execution_evidence`.

### 5.2 B. Adapt (Mapping to Emerald's Frozen Architecture)

Emerald's governance model is strictly superior to SWE-agent because execution cannot bypass typed validation, reflex checks, and capability policies. The mapping is:

```
┌────────────────────────────────────────────────────────┐
│                   AgentBrain (Ollama)                  │
└──────────────────────────┬─────────────────────────────┘
                           │ returns ActionProposal
                           ▼
┌────────────────────────────────────────────────────────┐
│             ProposalValidator (FROZEN)                 │
│  - Rejects INVALID_TOOL_INPUT / UNKNOWN_TOOL           │
│  - If invalid: Requery Prompt (max 2) [SWE-agent pattern]
└──────────────────────────┬─────────────────────────────┘
                           │ valid proposal
                           ▼
┌────────────────────────────────────────────────────────┐
│                  ReflexEngine (FROZEN)                 │
│  - Computes action confidence, risk, verification req  │
└──────────────────────────┬─────────────────────────────┘
                           │ evaluated proposal
                           ▼
┌────────────────────────────────────────────────────────┐
│                PolicyEvaluator (FROZEN)                │
│  - Evaluates MissionContract capabilities & boundaries │
└──────────────────────────┬─────────────────────────────┘
                           │ authorized tool request
                           ▼
┌────────────────────────────────────────────────────────┐
│              ToolExecutionGateway (FROZEN)             │
│  - Creates Action & Attempt in SQLite (lease fenced)   │
│  - Dispatches to ToolAdapter (e.g., DockerProvider)    │
│  - Binds timeout, truncates oversized observation      │
└──────────────────────────┬─────────────────────────────┘
                           │ ToolExecutionResult
                           ▼
┌────────────────────────────────────────────────────────┐
│             AgentStepController (FROZEN)               │
│  - Appends observation to step transcript              │
│  - Updates ContextEngine for step N+1                  │
│  - Persists StepEvidence                               │
└────────────────────────────────────────────────────────┘
```

1. **Step Loop Orchestration**:
   - `AgentStepController` manages the step counter ($1 \le \text{step} \le \text{maxSteps}$).
   - Step starts: `ContextEngine.assembleContext(runId)` compiles system prompt, mission instructions, repository summary, recent trajectory entries, and previous tool observation.
   - Model generates `ActionProposal`.
   - `ProposalValidator.validate(proposal)`:
     - If invalid: record `StepTranscriptEntry` with status `VALIDATION_FAILED`. If requery count $< 2$, re-invoke brain with error payload.
     - If valid: proceed to `ReflexEngine.evaluate()`.
   - `PolicyEvaluator.evaluate(proposal, missionContract)`:
     - If denied: record `POLICY_DENIED`, emit domain event, return denial observation to context.
   - `ToolExecutionGateway.execute(toolRequest)`:
     - Atomic transaction creates `Action` and `Attempt`.
     - Tool adapter runs in Docker sandbox.
     - Captures output, applies truncation if size $> 16\text{ KB}$.
     - Closes `Attempt` and `Action`.
   - Controller records step completion and checks termination:
     - Proposal `isGoalReached === true` $\rightarrow$ transition to `VERIFYING`.
     - Step count $\ge \text{maxSteps}$ $\rightarrow$ transition to `FAILED` (budget exhausted).
     - Otherwise $\rightarrow$ increment step index and loop.

### 5.3 C. Skip (What Emerald Explicitly Rejects)
1. **Regex/Markdown Parsing**: SWE-agent parses markdown backticks and regex command blocks. Emerald uses typed JSON structured outputs enforced by Ollama grammars and validated by Zod (`ProposalValidator`).
2. **Unchecked Bash Execution**: SWE-agent passes raw strings into an interactive bash shell (`docker exec -it ... /bin/bash`). Emerald strictly requires typed tools (`read_file`, `search_code`, `write_file`, `git_status`, `git_diff`, `run_command` with discrete `argv` arrays). Shell injection via metacharacters is fundamentally blocked.
3. **Implicit Container Lifecycle**: SWE-agent relies on long-running stateful Docker sessions that can leak background daemons. Emerald uses explicit workspace mounts, non-root execution, `no-new-privileges`, read-only root filesystems, and lease-fenced execution providers.

---

## 6. Conformance Test Specifications

To verify Phase 11 and Phase 12 without regressions, the following test suite must be implemented during their respective phases:

1. **Test 11.1: Single Tool Execution Reach**:
   - Given a live model generating a valid `read_file` proposal.
   - When proposal passes `ProposalValidator`, `Reflex`, and `PolicyEvaluator`.
   - Then `ToolExecutionGateway` dispatches to `ReadFileToolAdapter`.
   - Assert: SQLite contains 1 `actions` row (`status = COMPLETED`), 1 `attempts` row (`status = SUCCESS`), and the file content is returned in the observation.

2. **Test 12.1: Observation Context Propagation**:
   - Execute Step 1: Model calls `search_code({ query: "calculateTotal" })`.
   - Verify tool returns file path `src/calculator.ts:42`.
   - Execute Step 2: Verify `ContextEngine` context snapshot for Step 2 contains `src/calculator.ts:42` in the previous step observation.
   - Verify model uses that path in Step 2 proposal (`read_file({ path: "src/calculator.ts" })`).

3. **Test 12.2: Bounded Schema Requery**:
   - Model emits malformed argument: `search_code({ pattern: "foo" })`.
   - `ProposalValidator` fails with `INVALID_TOOL_INPUT`.
   - Assert: Zero `actions` or `attempts` created; zero physical tool execution.
   - Assert: Model is reinvoked with the schema correction prompt; second proposal succeeds and executes.

4. **Test 12.3: Safe Loop Termination**:
   - Model emits `isGoalReached: true`.
   - Assert: Agent loop exits cleanly without attempting further tool calls.
   - Assert: Run transitions from `RUNNING` to `VERIFYING`.

5. **Test 12.4: Observation Truncation Invariant**:
   - Tool execution generates 100 KB of stdout.
   - Assert: `ToolExecutionGateway` truncates output to exactly 16 KB with `[TRUNCATED: 84 KB omitted]`.
   - Assert: Total step latency and token context remain within configured bounds.

---

## 7. Productization Lessons from SWE-agent

1. **Terminal and Command Transparency**: SWE-agent displays the exact command executed and the terminal output in the developer UI. Developers do not trust high-level summaries when an agent is editing code; they need the literal command and raw output.
2. **Trajectory Inspectability**: The `.traj` artifact format allows engineers to inspect the exact thought process, step-by-step actions, and environment feedback after a run finishes or fails. Emerald must project SQLite `execution_evidence` into a comparable JSON trajectory format.
3. **Clear Distinctions Between Failure Modes**: SWE-agent's separation of syntax errors, execution errors, and environment crashes prevents engineers from blaming the model when the environment is broken.

---

## 8. Dependencies & Sequencing

- **Pre-requisite**: **Phase 10I (Standardized Tool Projection)**. The model must receive standardized, unambiguous tool contracts before reliable multi-step execution is possible.
- **Direct Target 1**: **Phase 11 (Real Tool Execution)** — Single controlled step reaching physical execution.
- **Direct Target 2**: **Phase 12 (Multi-Step Agent Loop)** — Chaining steps with observation feedback.

---

## 9. Open Questions & Technical Uncertainties

1. **Context Window Growth under CPU Inference**: On CPU inference (`llama3.2:3b`), each additional step in the conversation history adds prompt processing time ($+25\text{--}40\text{s}$ per 1,000 tokens). Will a 5-step loop exceed the 120s timeout ceiling without aggressive context compaction or sliding windows?
2. **Autosubmission Risk**: Should Emerald adopt SWE-agent's `attempt_autosubmission_after_error`? In SWE-agent, partial patches are graded for partial credit; in Emerald, unverified partial patches violate the constitution unless verified by independent test suites. Recommendation: Only extract diffs for diagnostic review, never mark as verified.
