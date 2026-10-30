# Phase 45A — Diagnostic Research Report: Autonomous Agent Progression and Observation Loop Mechanics

## Executive Summary

Following Phase 44D, where grammar-constrained structured output achieved 100% schema compliance and zero proposal rejections across five autonomous turns but failed to repair benchmark task `EAF-BM-01` due to five consecutive `read_file` proposals on `src/calc.js`, Phase 45A performed a comprehensive, read-only architectural trace of the Emerald Agent Fabric execution pipeline.

This diagnostic inspected the context engine, prompt construction, tool result assembly, state store persistence, and step controller loop to determine the exact mechanisms driving this observation stagnation.

### Primary Diagnostic Findings
1. **Target File Contents Were Fully Present in Context**: Tool execution succeeded on Step 1, and the complete 125-byte content of `src/calc.js` was serialized into a typed `TOOL_RESULT` observation and included in the model context for Steps 2, 3, 4, and 5. Context loss or output truncation did **not** occur.
2. **Task Objective Omitted Defect and Repair Specifications**: The task definition in [`src/production/benchmark/phase43-benchmark-runner.ts`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/src/production/benchmark/phase43-benchmark-runner.ts#L740-L749) categorized `EAF-BM-01` as `"CODE_NAVIGATION"`, providing the agent only with `title: "Core Arithmetic Off-by-One Fix"` and `inputPayload: { targetFile: "src/calc.js" }`. Zero bug descriptions, failure logs, expected return values, or edit instructions were provided to the agent.
3. **Prompt Lacks Phase Progression Guidance**: The system instructions in [`src/application/live-agent-brain.ts`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/src/application/live-agent-brain.ts#L61-L76) instruct the agent on authority limits, tool schema matching, and goal completion, but provide zero guidance on task lifecycle progression (e.g., transition from inspection to editing, or avoiding redundant reads).
4. **Context Engine Duplicated Identical Observations**: Across Steps 2 through 5, `ContextSource` gathered and retained an additional `TOOL_RESULT` observation for every identical read of `src/calc.js`, creating multi-observation duplication without summarization or deduplication.
5. **Runtime Controller Perceived Stagnation as Healthy Progress**: In [`src/application/agent-step-controller.ts`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/src/application/agent-step-controller.ts#L1381-L1385), `consecutiveFailures` is reset to 0 whenever an action succeeds, and `proposalRejections` only increments on invalid proposals. Because all 5 read actions succeeded under governance, the controller detected zero anomalies until the hard `maxSteps: 5` ceiling halted the run.

---

## 1. End-to-End Execution Flow

The following sequence illustrates the actual step-by-step decision and execution loop traced through the codebase during Phase 44D:

```
[AgentStepController.runStepLoop]
         │
         ├── 1. Gathers candidate observations from SQLite via ContextSource
         │      (RunState, MissionContext, ActionHistory, AttemptHistory, ToolResult)
         │
         ├── 2. Builds ContextSnapshot via ContextEngine.build()
         │      (Enforces category ceilings, budgets, and SHA-256 contextHash)
         │
         ├── 3. Calls LiveAgentBrain.proposeAction(brainRequest)
         │      │
         │      ├── Formats all observations into a SINGLE synthetic user message
         │      ├── Attaches ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA (7 branches)
         │      └── Invokes OllamaModelProvider via local HTTP
         │
         ├── 4. Model (qwen2.5-coder:1.5b) generates constrained proposal
         │      (Ollama GBNF grammar forces compliance with 1 of 7 branches)
         │
         ├── 5. Authoritative Validation & Fencing
         │      ├── ProposalValidator.validate() -> VALID (matches read_file schema)
         │      ├── Reflex.evaluate() -> ACCEPT (NoopReflex authorizes)
         │      └── PolicyEvaluator / WorkerRuntime check path sandbox containment
         │
         ├── 6. WorkerRuntime.executeAction()
         │      ├── Executes read_file on workspace host path
         │      ├── Persists Action, Attempt, and ToolResult in SQLite
         │      └── Returns status: "SUCCEEDED", exitCode: 0, content: "function add..."
         │
         └── 7. Loop Reset: consecutiveFailures = 0, proposalRejections = 0
                (Advances stepCount, repeats to Step 1 for next turn)
```

---

## 2. Detailed Technical Inspection by Subsystem

### 2.1 Task Representation & Objective Clarity
- **Source**: [`src/production/benchmark/phase43-benchmark-runner.ts#L108-L143`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/src/production/benchmark/phase43-benchmark-runner.ts#L108-L143) and [`#L740-L750`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/src/production/benchmark/phase43-benchmark-runner.ts#L740-L750).
- **Observed Code**:
  ```typescript
  const runtimeTask = coordinator.createTask({
    taskId,
    title: task.title,
    description: `Phase 43 Pilot Task: ${task.taskId} (${task.category})`,
    inputPayload: {
      taskId: task.taskId,
      targetFile: task.targetFile,
    },
  });
  ```
- **Context Impact**:
  When serialized into `obs-contract`, the task information presented to the model is strictly:
  ```json
  "taskDetails": {
    "title": "Core Arithmetic Off-by-One Fix",
    "description": "Phase 43 Pilot Task: EAF-BM-01 (CODE_NAVIGATION)",
    "inputPayload": {
      "targetFile": "src/calc.js",
      "taskId": "EAF-BM-01"
    }
  }
  ```
- **Analysis**:
  The category is explicitly labeled `"CODE_NAVIGATION"` rather than `"BUG_REPAIR"`. The task description provides zero indication of what function is defective, what tests are failing, or that `write_file` must be called to apply a patch. An agent without pre-trained benchmark memory has only the title `"Core Arithmetic Off-by-One Fix"` to infer that code modification is expected.

### 2.2 Observation Assembly & Tool Result Serialization
- **Source**: [`src/application/context/context-source.ts#L249-L275`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/src/application/context/context-source.ts#L249-L275).
- **Observed Code**:
  ```typescript
  if (attempt.outputPayload !== null && attempt.outputPayload !== undefined) {
    const resultPriority = 60 + (attemptFreshness === "CURRENT" ? 10 : 0);
    const resultContent = redactSensitiveData({
      attemptId: attempt.attemptId,
      actionId: attempt.actionId,
      toolName: action.toolName,
      output: attempt.outputPayload,
      exitCode: attempt.exitCode,
    }) as Record<string, unknown>;
  ```
- **Context Impact**:
  For `read_file`, `attempt.outputPayload` contains:
  ```json
  {
    "path": "src/calc.js",
    "content": "function add(a, b) {\n  return a + b + 1;\n}\n\nfunction multiply(a, b) {\n  return a * b;\n}\n\nmodule.exports = { add, multiply };\n",
    "byteCount": 125,
    "lineCount": 10,
    "truncated": false
  }
  ```
- **Analysis**:
  The agent definitively received the file content. However, `ContextSource` gathers all historical actions for the run. By Step 5, the context contained 4 previous identical `read_file` action records and 4 previous identical `TOOL_RESULT` observations, repeating the exact same 125 bytes 4 times. While within the 16,000-byte context budget, this repetitive accumulation reinforces the read pattern in the prompt.

### 2.3 Prompt Structure & System Instructions
- **Source**: [`src/application/live-agent-brain.ts#L61-L76`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/src/application/live-agent-brain.ts#L61-L76) and [`#L602-L656`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/src/application/live-agent-brain.ts#L602-L656).
- **Observed System Prompt**:
  ```
  You are a reasoning component within the Emerald Agent Fabric.
  Your role is to propose actions to achieve the assigned mission task.
  You are a reasoning component.
  You propose actions.
  You do not execute actions.
  You do not possess authority.
  Your output is untrusted.
  The execution system will independently validate your proposal.

  Operational Rules:
  1. Inspect the provided execution context observations carefully.
  2. Select an appropriate registered tool from the available tools list.
  3. Propose exact, bounded input arguments matching the tool's parameter schema. In tool inputPayload, the target file path parameter must always be named path (never filePath or file_path).
  4. If the mission goal is fully achieved, output an action proposal indicating completion (isGoalReached: true).
  5. Never attempt to specify infrastructure authority fields (workerId, leaseId, contracts, capabilities, mount paths, retry limits, execution status).
  6. Format your response strictly according to the required action proposal schema.
  ```
- **Observed Required Action Suffix**:
  ```
  ## Required Action
  Propose the next logical tool action as a JSON object conforming to the action proposal schema.
  Set contextSnapshotHash to "<contextHash>".
  If the mission goal has been completely achieved, set isGoalReached: true.
  ```
- **Analysis**:
  The instructions tell the model what *not* to do (do not execute, do not claim authority, do not use `filePath`), but provide no guidance on the *process* of solving a task. The model is told: "Inspect context" -> "Select a tool". Because `read_file` is the tool it has already selected successfully, and `write_file` requires generating a larger, more complex payload with code replacement, the model defaults to `read_file`.

### 2.4 Asymmetry in Tool Proposal Complexity
- **Source**: [`src/application/live-agent-brain.ts#L119-L195`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/src/application/live-agent-brain.ts#L119-L195).
- **Comparison**:
  - `read_file` proposal payload:
    ```json
    { "isGoalReached": false, "proposalId": "read_file", "toolName": "read_file", "contextSnapshotHash": "...", "inputPayload": { "path": "src/calc.js" } }
    ```
    Tokens required: ~45 tokens.
  - `write_file` proposal payload:
    ```json
    { "isGoalReached": false, "proposalId": "patch-1", "toolName": "write_file", "contextSnapshotHash": "...", "inputPayload": { "path": "src/calc.js", "content": "function add(a, b) {\n  return a + b;\n}\n\nfunction multiply(a, b) {\n  return a * b;\n}\n\nmodule.exports = { add, multiply };\n" } }
    ```
    Tokens required: ~120+ tokens, requiring JSON string escaping and code synthesis.
- **Analysis**:
  Under temperature 0.0 (greedy decoding) on a 1.5B model, token probabilities heavily favor the shorter, lower-entropy `read_file` token path unless the prompt creates a strong conditional prior toward modification.

### 2.5 Controller Stagnation Detection Gap
- **Source**: [`src/application/agent-step-controller.ts#L1308-L1385`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/src/application/agent-step-controller.ts#L1308-L1385).
- **Observed Behavior**:
  ```typescript
  if (actionResult.status === "FAILED" || actionResult.status === "TIMED_OUT") {
    consecutiveFailures++;
  } else if (actionResult.status === "SUCCEEDED") {
    consecutiveFailures = 0;
  }
  ```
- **Analysis**:
  The step controller monitors action execution failures, lease loss, wall-clock time, step counts, and proposal rejections. However:
  - It does **not** check whether an action is identical to an action executed in a previous turn.
  - It does **not** evaluate whether the workspace state has mutated between read operations.
  - It does **not** emit stagnation warnings or loop alerts.
  - Every successful read resets `consecutiveFailures` to 0, completely shielding the observation loop from the controller's safety halts until `maxSteps` is reached.

---

## 3. Comparison of Explanatory Hypotheses

| Potential Cause | Supported by Code & Evidence? | Primary Evidence / Counter-Evidence |
| :--- | :--- | :--- |
| **1. Context Loss / File Truncation** | **REFUTED** | `calc.js` is 125 bytes; `maxToolOutputBytes` is 2048. `truncated: false`. Exact file code present in context on Steps 2–5. |
| **2. Single-Turn Message Structure** | **PARTIALLY SUPPORTED** | Prompt is delivered as a single monolithic user message, not a native multi-turn chat (`user`/`assistant`/`tool`). The model cannot see its own prior reasoning traces, only the raw tool result JSON. |
| **3. Underspecified Task Objective** | **SUPPORTED** | Category is `"CODE_NAVIGATION"`. Task description is `"Phase 43 Pilot Task: EAF-BM-01 (CODE_NAVIGATION)"`. No bug description or fix expectation provided. |
| **4. Lack of Progression Instructions** | **SUPPORTED** | System rules provide zero lifecycle instructions (e.g., "After reading code, use write_file to edit"). |
| **5. Context Duplication Prior** | **SUPPORTED** | Every repeated read adds another `TOOL_RESULT` to context, repeating the `read_file` pattern 4 times. |
| **6. Sub-2B Model Planning Limits** | **SUPPORTED** | Sub-2B models have limited multi-step planning horizons and tend to collapse into repetitive loops under zero temperature without strong guidance. |

---

## 4. Prioritized Candidate Experiments

The following three candidate experiments are strictly prioritized to address the identified failure mechanisms without compromising runtime governance, zero-cost constraints, or local execution feasibility:

### Candidate Experiment 1: Explicit Task Lifecycle & Progression Guidance in System Prompt
- **Hypothesis**: Clarifying the expected problem-solving lifecycle in `DEFAULT_LIVE_BRAIN_SYSTEM_INSTRUCTION` (Phase 1: Inspect code with `read_file`; Phase 2: Modify code with `write_file`; Phase 3: Verify or conclude) will shift model token distribution from redundant reading to patch authoring once target code is in context.
- **Smallest Proposed Change**:
  In [`src/application/live-agent-brain.ts`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/src/application/live-agent-brain.ts#L70-L76), append a progression rule:
  ```
  7. Progression: Once you have read and inspected the target file, do not re-read it. Propose write_file to apply the required fix, or declare completion with isGoalReached: true.
  ```
- **Offline Tests Needed**: Update prompt snapshots in `tests/application/live-agent-brain.test.ts`.
- **Success Metric**: Model proposes `write_file` on Step 2 after `read_file` succeeds on Step 1.
- **Regression & Security Risks**: Low. All proposals remain strictly subject to `ProposalValidator`, `PolicyEvaluator`, and path sanitization.
- **Live Inference Needed**: Yes, a single authorized live trial.

### Candidate Experiment 2: Redundant Action Stagnation Detection in Step Controller
- **Hypothesis**: If `AgentStepController` detects that an agent proposes an identical read-only action (`read_file` on the same path) that has already succeeded without intervening workspace modifications, rejecting the proposal or injecting a non-fatal stagnation advisory observation will force the model to select an alternative tool branch.
- **Smallest Proposed Change**:
  In [`src/application/agent-step-controller.ts`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/src/application/agent-step-controller.ts), before action execution, check if `toolName === "read_file"` matches the immediate prior action on the same path, and if so, inject an ephemeral `[STAGNATION_ADVISORY]` observation informing the agent that the file has already been read and is present in context.
- **Offline Tests Needed**: Unit tests in `tests/application/agent-step-controller.test.ts` verifying advisory generation on consecutive duplicate reads.
- **Success Metric**: Step loop halts or redirects the agent before exhausting the 5-step budget on duplicate reads.
- **Regression & Security Risks**: Medium. Must avoid false positives on valid repeated reads (e.g., reading different line ranges or reading after a command runs).
- **Live Inference Needed**: Yes, after offline proof.

### Candidate Experiment 3: Context Snapshot Tool-Result Deduplication
- **Hypothesis**: Suppressing redundant historical `TOOL_RESULT` observations for identical read actions on unmutated files prevents prompt token bloat and avoids reinforcing the model's recency bias toward repeated reads.
- **Smallest Proposed Change**:
  In [`src/application/context/context-source.ts`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/src/application/context/context-source.ts), deduplicate `TOOL_RESULT` observations targeting identical file paths when no intervening workspace write or command has occurred, keeping only the most recent observation.
- **Offline Tests Needed**: Unit tests in `tests/application/context-engine.test.ts` asserting deduplication of identical tool output observations.
- **Success Metric**: Context snapshot retains only one instance of `src/calc.js` content.
- **Regression & Security Risks**: Low. Preserves full action history while reducing observation redundancy.
- **Live Inference Needed**: Yes, after offline proof.

---

## 5. Architectural Boundaries & Stop Conditions

As established in ADR-0001, ADR-0034, and ADR-0035:
- **No Speculative Architecture**: Do not introduce multi-agent debate committees, heuristic auto-patchers, or unverified secondary LLMs.
- **Validation Remains Authoritative**: No prompt adjustment or stagnation heuristic shall weaken runtime validation or grant autonomous write authority outside policy boundaries.
- **Local-First & ₹0 Cost**: All future trials must run on local commodity CPU hardware without cloud dependencies.
- **Strict Authorization**: No candidate experiment shall be implemented or tested with live inference without separate, bounded user authorization.
