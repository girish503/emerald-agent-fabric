# Phase 45 — Design & Contract Specification: Dynamic Context-Aware Tool Filtering

## Executive Summary

Phases 44D and 45C demonstrated that local open-weights language models (`qwen2.5-coder:1.5b`) exhibit a persistent passive-reading bias. When provided with an open tool palette containing `read_file`, `write_file`, `search_code`, `git_status`, `git_diff`, and `run_command`, the model repeatedly proposes `read_file` for the same target file, even when:
1. The target file's full content is demonstrably resident in context memory (`TOOL_RESULT`).
2. The model prompt explicitly details the grounded defect and test acceptance criteria (`## Task Execution Context`).
3. The runtime controller injects an actionable `SYSTEM_EVENT` advisory informing the agent that the information is already available and requesting a justified next action.

In Phase 45C, runtime progression control successfully recognized this failure mode and halted redundant execution at 3 steps (`terminalReason: "STAGNATION"`). However, runtime stagnation control is a graceful halt mechanism; it bounds wasted compute, but does not alone cause the agent to transition to code modification.

This document specifies an offline architectural design for **Dynamic Context-Aware Tool Filtering**. The mechanism tracks file observation residency in context memory and dynamically filters redundant tools (such as `read_file` for resident, unmodified target files) from both the model-facing catalog and the outbound structured-output schema, while establishing strict invalidation rules that restore tool eligibility upon any workspace change, partial read, or context displacement.

---

## 1. Architectural Audit: Existing Execution and Projection Flow

### 1.1 The Current Projection Pipeline
In the current implementation:
1. **Tool Catalog Source**: In [`src/application/agent-step-controller.ts#L622`](../../src/application/agent-step-controller.ts#L622), `AgentStepController` constructs `brainRequest` with:
   ```ts
   availableTools: this.toolRegistry.listTools()
   ```
   This passes all registered tools from the static registry on every turn, regardless of what has already been executed or observed.
2. **Prompt Markdown Projection**: In [`src/application/live-agent-brain.ts#L628-L629`](../../src/application/live-agent-brain.ts#L628-L629), `buildModelRequest()` renders:
   ```ts
   sections.push("\n## Available Tools");
   sections.push(formatModelFacingToolCatalog(availableTools));
   ```
3. **Structured-Output Schema Projection**: In [`src/application/live-agent-brain.ts#L680`](../../src/application/live-agent-brain.ts#L680), `generation.structuredOutput` is bound to the static constant:
   ```ts
   structuredOutput: ACTION_PROPOSAL_STRUCTURED_OUTPUT_SCHEMA
   ```
   This schema hardcodes seven branches (`isGoalReached: true` + 6 tools). Even if an advisory suggests choosing an edit, the local Ollama GBNF grammar engine permits token generation for `read_file` with equal structural probability.
4. **Validation Separation**: In [`src/application/proposal-validator.ts#L302`](../../src/application/proposal-validator.ts#L302), `ProposalValidator` independently resolves tool definitions against `this.toolRegistry` and validates capability policies.

### 1.2 The Root Cause of Repetitive Selection
The root cause is an asymmetry between model capability and grammar projection:
- Sub-2B models follow the path of highest pre-training likelihood. In standard coding datasets, reading a file is far more frequent than generating an in-place multi-line `write_file` payload.
- As long as `read_file` remains a valid branch in the grammar schema, the model samples `toolName: "read_file"`.
- Because runtime governance and safety are strictly fail-closed, the controller must not force a write or fabricate an edit. However, the runtime *does* have authoritative authority over **what tools it offers to the model** on any given turn.

---

## 2. Design Comparison: Three Architectural Options

| Architectural Option | Mechanism | Autonomy & Governance Impact | Operational Overhead | Recommendation |
| :--- | :--- | :--- | :--- | :--- |
| **Option A: Advisory-Only Tool Ranking / Guidance** | Annotate markdown prompt with tool preferences (e.g. *"read_file deprioritized; write_file recommended"*). Keep 7-branch schema static. | Preserves all options. Fully autonomous. | Minimal (prompt change only). | **Rejected**: Phase 45C empirical evidence proved that `qwen2.5-coder:1.5b` completely ignored the observation-level progression advisory. |
| **Option B: Temporary Context-Aware Filtering with Invalidation** | Track file residency in context snapshot. If target file is complete and current in memory, filter `read_file` from the catalog and project a 6-branch schema. Restore immediately upon file edit, partial read, or context eviction. | Offers only sensible next actions. Does not force any specific tool. Validation remains authoritative. | Low: Lightweight deterministic tracking in Step Controller before brain invocation. | **Recommended**: Eliminates the passive-read trap at the grammar level while guaranteeing full invalidation safety. |
| **Option C: Rigid State-Machine Tool Phasing** | Enforce linear pipeline stages: `INSPECT` phase (only `read_file`, `search_code`) → `REPAIR` phase (only `write_file`, `run_command`) → `VERIFY` phase (only `run_command`, `isGoalReached`). | Restrictive. Imposes rigid assumptions. Breaks exploratory, multi-file, or read-only tasks. | High: Introduces complex lifecycle states and transition logic. | **Rejected**: Overengineering. Violates GEMINI.md Section 5 (No Speculative Architecture). |

---

## 3. Detailed Specification: Option B (Temporary Context-Aware Filtering)

### 3.1 Context-Residency Contract (`ContextResidencyTracker`)

The runtime must deterministically know whether a file's content is **complete, current, and accessible** in the context snapshot of the current turn before deciding to filter `read_file`.

```ts
export interface FileResidencyRecord {
  /** Relative workspace path */
  readonly path: string;
  /** SHA-256 hash of the observed content payload */
  readonly contentHash: string;
  /** Total byte size of the file on disk */
  readonly totalBytes: number;
  /** Total line count of the file on disk */
  readonly totalLines: number;
  /** Whether the full file content is present without line or byte truncation */
  readonly isComplete: boolean;
  /** Sequence number of the step where this observation was captured */
  readonly sequenceNumber: number;
  /** Whether intervening actions have modified the workspace since observation */
  readonly isStale: boolean;
}
```

#### Criteria for "Complete & Current Context Residency":
A file is defined as **Resident in Context** if and only if all four conditions hold:
1. **Target Match**: A `TOOL_RESULT` observation exists in the active run history where `toolName === "read_file"` and `payload.path === targetPath`.
2. **Completeness**: The read action was full-file (`isComplete === true`), meaning `offsetLine === 1`, no `limitLines` cutoff occurred, and the observation was not truncated by `ContextBudget` (`truncation.isTruncated !== true`).
3. **Current Freshness**: No successful action modifying the workspace (`write_file`, or command modifying files) has occurred since the observation was recorded (`isStale === false`).
4. **Snapshot Presence**: The observation is actively present in `contextSnapshot.observations` for the upcoming step (i.e. not pruned or omitted due to context budget exhaustion).

---

### 3.2 Tool Eligibility States

Each registered tool transitions between explicit eligibility states for each execution step:

```
                  ┌────────────────────────┐
                  │       ELIGIBLE         │  (Offered in prompt catalog and schema)
                  └───────────┬────────────┘
                              │
               Context Residency Contract Met
               (Complete & current in memory)
                              │
                              ▼
                  ┌────────────────────────┐
                  │       FILTERED         │  (Temporarily excluded from schema & catalog)
                  └───────────┬────────────┘
                              │
               Invalidation Trigger Occurs
               (File edit, mutation, eviction)
                              │
                              ▼
                  ┌────────────────────────┐
                  │       RESTORED         │  (Re-enters ELIGIBLE for next turn)
                  └────────────────────────┘
```

- **ELIGIBLE**: The tool is documented under `## Available Tools` and included as a branch in `structuredOutput` JSON Schema.
- **FILTERED**: The tool is excluded from `## Available Tools` and omitted from `structuredOutput` JSON Schema. The model cannot emit tokens for this tool under GBNF grammar constraints.
- **RESTORED**: The tool transitions from `FILTERED` back to `ELIGIBLE` upon an invalidation event.

---

### 3.3 Strict Invalidation & Restoration Rules

To ensure the agent is never trapped when information is needed, the following deterministic rules **immediately invalidate residency and restore `read_file` to `ELIGIBLE`**:

| Invalidation Trigger | Condition | Restoration Action |
| :--- | :--- | :--- |
| **1. Workspace Mutation** | `write_file` or filesystem-modifying `run_command` succeeds. | Invalidate all residency records. Restore `read_file` immediately for all paths. |
| **2. Partial / Range Read** | Previous read had `offsetLine > 1` or `limitLines < totalLines`. | Do not filter. `read_file` remains `ELIGIBLE` for exploring other ranges. |
| **3. Content Drift / External Modification** | File on disk has modified mtime/size differing from cached residency. | Invalidate residency. Restore `read_file` immediately. |
| **4. Multi-File Exploration** | Agent targets a file whose path has not been read. | `read_file` remains `ELIGIBLE` for any unread file in the workspace. |
| **5. Context Budget Eviction** | `ContextEngine.build()` omits the `TOOL_RESULT` observation due to token budget pressure (`omittedObservationsCount > 0`). | Residency revoked. Restore `read_file` immediately so agent can re-read if needed. |
| **6. Execution Failure Recovery** | Any proposed action fails (`actionResult.status !== "SUCCEEDED"`). | Restore all filtered tools to ensure maximum recovery options. |
| **7. Pure Navigation Tasks** | Task category is `CODE_NAVIGATION` or contract specifies zero modification permissions. | Never filter `read_file`. Tool filtering is disabled for read-only tasks. |

---

### 3.4 Dynamic Structured-Output Schema Projection

Instead of passing a static 7-branch constant, `LiveAgentBrain` dynamically derives the schema branches matching `brainRequest.availableTools`:

```ts
export function deriveActionProposalSchema(
  availableTools: readonly ToolDefinition[]
): ModelStructuredOutputSchema {
  const eligibleToolNames = new Set(availableTools.map((t) => t.name));

  // Branch 1: Goal-reached completion (always present)
  const branches: any[] = [GOAL_REACHED_SCHEMA_BRANCH];

  // Tool branches: only include schema definitions for tools that are currently ELIGIBLE
  for (const toolName of eligibleToolNames) {
    const branchSchema = TOOL_SPECIFIC_SCHEMA_BRANCHES[toolName];
    if (branchSchema) {
      branches.push(branchSchema);
    }
  }

  return {
    name: "action_proposal",
    strict: true,
    jsonSchema: {
      type: "object",
      anyOf: branches,
    },
  };
}
```

#### Impact on Outbound Request:
- On Step 1 (cold start): Target file not yet read. All 6 tools are `ELIGIBLE`. Outbound schema has 7 branches (`isGoalReached` + 6 tools).
- Model proposes `read_file` for `src/calc.js`.
- On Step 2: Target file `src/calc.js` is complete and current in context. `read_file` is `FILTERED`.
- Outbound schema for Step 2 has 6 branches:
  1. `isGoalReached: true`
  2. `write_file`
  3. `search_code`
  4. `git_status`
  5. `git_diff`
  6. `run_command`
- Local Ollama GBNF grammar engine masks `toolName: "read_file"`.
- The model **cannot** emit `read_file`. It must select among modifying the file (`write_file`), running tests (`run_command`), checking git status/diff, searching other symbols, or declaring completion.

---

### 3.5 Governance, Validation, and Safety Invariants

1. **Proposal Validation Invariant**: `ProposalValidator` remains completely independent of tool filtering. It validates proposals against the authoritative `ToolRegistryPort` and capability policies.
   - If a model somehow emits a proposal for a filtered tool, `ProposalValidator` processes it normally against domain rules (defense-in-depth).
2. **Zero Proposal Mutation**: The runtime NEVER rewrites proposals, modifies payloads, or simulates fake progress.
3. **No Forced Edits**: The model is NOT forced to pick `write_file`. It retains full autonomy to select `run_command`, `git_diff`, `search_code`, or declare `isGoalReached: true`.
4. **Independent Physical Verification**: If the model declares `isGoalReached: true` without fixing the bug, `CleanRoomVerifier` executes tests in an isolated sandbox and fails the run with `UNVERIFIED_COMPLETION_CLAIM`.
5. **Replay Invariance**: `StepTranscriptEntry` records the exact tool eligibility list and filtering rationale for each step, ensuring deterministic verification and replay auditability.

---

### 3.6 Diagnostic Events & Observability

Every filtering and restoration decision must be emitted as a typed domain event and recorded in step transcripts:

#### 1. Domain Events:
- `tool.filtering.applied`:
  ```json
  {
    "runId": "run-xyz",
    "sequenceNumber": 2,
    "toolName": "read_file",
    "reason": "FULL_FILE_RESIDENT_IN_CONTEXT",
    "targetPath": "src/calc.js",
    "contentHash": "a1b2c3...",
    "remainingEligibleTools": ["write_file", "search_code", "git_status", "git_diff", "run_command"]
  }
  ```
- `tool.filtering.restored`:
  ```json
  {
    "runId": "run-xyz",
    "sequenceNumber": 3,
    "toolName": "read_file",
    "restorationReason": "WORKSPACE_MUTATION_OCCURRED",
    "mutatingTool": "write_file",
    "mutatingPath": "src/calc.js"
  }
  ```

#### 2. Step Transcript Representation:
`StepTranscriptEntry` will record:
```ts
readonly eligibleTools: readonly ToolName[];
readonly filteredTools: readonly { toolName: ToolName; reason: string }[];
```

---

## 4. Deterministic Contract-Test Matrix (Offline)

Before any live inference trial is authorized, the following 8 contract tests must pass deterministically:

| Test ID | Test Scenario | Expected Deterministic Outcome |
| :--- | :--- | :--- |
| **CT-1** | Initial cold start on unobserved workspace | All registered tools (`read_file`, `write_file`, etc.) are `ELIGIBLE`. Outbound schema contains 7 branches. |
| **CT-2** | Full successful read of target file | Context residency tracker marks `src/calc.js` as complete and current. On next step, `read_file` transitions to `FILTERED`. Outbound schema contains 6 branches. |
| **CT-3** | Truncated / partial read (`limitLines: 10` on 50-line file) | Context residency marks `isComplete: false`. `read_file` remains `ELIGIBLE`. 7-branch schema preserved. |
| **CT-4** | Workspace mutation via `write_file` | Upon `write_file` execution, residency record is invalidated (`isStale: true`). On next step, `read_file` is `RESTORED` to `ELIGIBLE`. |
| **CT-5** | Context budget eviction | When `ContextEngine` drops the file observation due to token limits, residency is invalidated. `read_file` is `RESTORED`. |
| **CT-6** | Multi-file request | Agent reads `src/calc.js` (resident). Agent targets unobserved `test/f2p.test.js`. `read_file` remains `ELIGIBLE` for unobserved files. |
| **CT-7** | Read-only task classification | Task categorized as `CODE_NAVIGATION`. Tool filtering is bypassed entirely. All read operations remain available. |
| **CT-8** | Grammar compilation parity | Verify with offline validator that Ollama-compatible JSON Schema compiles cleanly with 6 branches and strictly excludes `read_file`. |

---

## 5. Rollout and Rollback Plan

### 5.1 Phased Rollout
1. **Phase 46A (Offline Engine & Unit Tests)**: Implement `ContextResidencyTracker` and dynamic schema generator. Verify 100% offline with CT-1 through CT-8.
2. **Phase 46B (Step Controller Integration)**: Wire residency tracker into `AgentStepController.runStepLoop()` behind a configuration flag `enableDynamicToolFiltering: boolean`.
3. **Phase 46C (Single Live Trial on EAF-BM-01)**: Execute exactly one live trial with `qwen2.5-coder:1.5b` (max 5 steps, timeout 120s) to observe whether the model transitions to `write_file` when `read_file` is filtered on Step 2.

### 5.2 Rollback Strategy
- The feature will be governed by `enableDynamicToolFiltering: boolean` in `AgentStepControllerOptions`.
- Default: `false`.
- If dynamic filtering produces unexpected behavior, setting the flag to `false` restores the exact Phase 45 behavior (all 7 branches static) with zero database migrations or breaking changes.

---

## 6. Measurable Success Criteria

1. **Offline Proof**: All 8 contract tests pass with 0 failures, 0 live calls, ₹0 cost.
2. **Live Trial Progression**: In a live trial of `EAF-BM-01`:
   - Step 1: Proposes and executes `read_file` on `src/calc.js`.
   - Step 2: `read_file` is filtered. Model chooses a different branch (e.g. `write_file` or `run_command`) rather than repeating `read_file`.
   - Zero stagnation halts.
3. **Safety & Governance**: Zero unauthorized modifications; all proposals pass strict Zod and policy checks; independent clean-room verification remains the sole authoritative pass/fail gate.

---

## 7. Unresolved Research Questions

1. **Payload Generation Quality**: Once `read_file` is filtered, can `qwen2.5-coder:1.5b` generate a syntactically correct `write_file` payload with complete file content, or will it emit partial/corrupt code?
2. **Context Window vs Tool Count**: Does reducing the schema from 7 to 6 branches improve inference latency and attention focus in sub-2B models?
3. **Multi-File Tasks**: In tasks with multiple interrelated files (e.g., `EAF-BM-02`), how should residency tracking scale across multiple files without creating excessive state overhead?
