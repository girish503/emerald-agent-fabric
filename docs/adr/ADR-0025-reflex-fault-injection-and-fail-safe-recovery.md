# ADR-0025: Reflex Fault Injection and Fail-Safe Recovery

## Status
Accepted

## Context
Across Phases 8.1 through 8.5, Emerald Agent Fabric established:
1. **Governed Reflex Interceptor Seam** (`src/domain/reflex.ts`): Positioned strictly between untrusted proposal validation and authoritative policy evaluation.
2. **Deterministic Rule-Based Reflex Heuristics** (`src/adapters/reflex/rule-based-reflex.ts`): Implemented three explainable rules (`reflex.failure-loop.v1`, `reflex.redundant-action.v1`, `reflex.budget-pressure.v1`).
3. **Controlled Empirical Evaluation** (`src/application/evaluation/controlled-evaluation.ts`): Proved under canonical tasks that Reflex reduces futile execution without harming productive task completion.
4. **Reflex Evidence & Offline Replay** (`src/domain/reflex-evidence.ts`): Produced tamper-evident observational records allowing offline verification.
5. **Adversarial Reliability & Invariant Evaluation** (`tests/application/reflex-adversarial-reliability.test.ts`): Proved authority monotonicity and fail-closed containment when Reflex receives hostile or ambiguous state.

### Research Question
> What happens when Reflex itself fails (throws an exception, returns malformed output, invalid decisions, config failures, evidence failures, cancellations, timeouts)? Does the system fail closed without authorization bypass?

## Decision

### 1. Fail-Closed Containment Principle
Reflex sits in the governance pipeline:
$$\text{ModelBrain} \to \text{ProposalValidator} \to \text{ReflexInterceptor} \to \text{PolicyEvaluator} \to \text{ToolExecutionGateway}$$

Under all internal Reflex failure conditions:
$$\text{Reflex Failure} \implies \text{NO AUTHORIZATION} \implies \text{providerInvocationCount} \equiv 0$$

Reflex failure NEVER silently converts into an `ALLOW` recommendation or bypasses downstream policy checks.

### 2. Telemetry and Evidence Purity
- **No Fabricated Telemetry**: When Reflex throws an error or fails validation, the system does NOT fabricate `reflexDecision: "REJECT"` or `reflexDecision: "ALLOW"`. Instead, `reflexDecision` remains `undefined`.
- **No Fabricated Replay Evidence**: Unexpected runtime crashes do not generate synthetic `ReflexEvidence` blocks with forged decisions. `reflexEvidence` remains `undefined`.
- **Typed Error Reporting**: The transcript entry records `reflexError: err.message`, capturing the exact failure cause.
- **Fail-Closed Accounting**: The proposal is rejected fail-closed, incrementing `proposalRejections` towards the configured `maxProposalRejections` ceiling to prevent infinite loops.

### 3. Cancellation Fast-Path
- If `params.abortSignal?.aborted` is true, or if Reflex throws an `AbortError`, `AgentStepController` immediately short-circuits and returns `terminalReason: "CANCELLED"`.
- Zero tools are executed on cancellation.

### 4. Wall-Clock Timeout Ceiling
- Reflex execution is bounded by the overall step loop `maxWallClockMs` budget.
- If a slow or delayed Reflex implementation pushes elapsed wall-clock time past the ceiling, the controller terminates deterministically with `MAX_WALL_CLOCK`.

### 5. Authority Monotonicity & Output Firewall
- All outputs returned by `ReflexPort.evaluate()` are strictly validated against `ReflexDecisionSchema`.
- Unknown keys, unauthorized capabilities, or governance override attempts (e.g., `bypassGovernance: true`) fail schema validation and trigger `InvalidReflexDecisionError`.
- Proposal and context objects passed to Reflex are defensively frozen; Reflex cannot mutate proposals to alter the action dispatched to `ToolExecutionGateway`.

### 6. UNKNOWN State Preservation & BASELINE Non-Interference
- If an earlier action generated an `UNKNOWN` execution attempt, subsequent Reflex failures cannot mutate, overwrite, or clear that durable `UNKNOWN` state from SQLite.
- In `BASELINE` execution mode, `AgentStepController` uses `NoopReflex` (or skips Reflex), remaining completely isolated from faults in experimental Reflex adapters.

### 7. Executable 12-Row Fault Matrix
| Row | Fault Mode | Injected Condition | Expected Behavior | Verified Mechanism |
|---|---|---|---|---|
| 1 | `EXCEPTION_THROW` | Throws `ReflexExecutionError` | Rejects proposal, 0 tools executed | `reflexError` recorded, `providerInvocationCount === 0` |
| 2 | `NON_ERROR_THROW` | Throws primitive string panic | Rejects proposal, 0 tools executed | `String(err)` captured in `reflexError`, 0 tools executed |
| 3 | `INVALID_DECISION_STRING` | Returns `decision: "EXECUTE_IMMEDIATELY"` | Validation error in `reflexError`, 0 tools executed | `validateReflexDecision` throws `InvalidReflexDecisionError` |
| 4 | `INVALID_REASON_CODE` | Returns `reasonCode: "UNAUTHORIZED_ACCESS"` | Validation error in `reflexError`, 0 tools executed | Zod enum validation catches illegal reason code |
| 5 | `INVALID_SCHEMA_SHAPE` | Returns `null` or non-object primitive | Validation error in `reflexError`, 0 tools executed | Strict object schema rejection |
| 6 | `AUTHORITY_INJECTION` | Injects `bypassGovernance: true`, elevated capabilities | Strict rejection, 0 tools executed | `findForbiddenAuthorityKeys` / strict Zod rejection |
| 7 | `RULE_CONFIG_CORRUPTION` | Corrupted `activeConfigHash` | Caught during replay, safe execution | `replayReflexEvidence` returns `MISMATCH_CONFIGURATION` |
| 8 | `CONTEXT_CORRUPTION_ATTEMPT` | Mutates incoming `ReflexContext` | Throws TypeError / ignored, 0 tools executed | Immutable frozen context defense |
| 9 | `OBSERVATIONAL_EVIDENCE_FAILURE` | Invalid evidence structure | Rejects or continues safely without authorization | `createReflexEvidence` validation firewall |
| 10 | `ABORT_SIGNAL_CANCELLATION` | AbortSignal triggered during Reflex evaluation | Terminal reason `CANCELLED`, 0 tools executed | Immediate abort fast-path in `AgentStepController` |
| 11 | `BOUNDED_TIMEOUT_DELAY` | Simulated async delay exceeding budget | Terminal reason `MAX_WALL_CLOCK`, 0 tools executed | Wall-clock check in `AgentStepController` |
| 12 | `ASYNC_REJECTION` | Unhandled `Promise.reject()` from Reflex | Rejects proposal, 0 tools executed | Async `try/catch` in step loop intercepts rejection |

## Consequences

### Positive
- Proven runtime containment: a bug, crash, or vulnerability in Reflex cannot cause unauthorized tool execution or bypass policy.
- Honest telemetry: evaluation metrics reflect genuine decisions rather than fabricated error states.
- Clean cancellation and timeout recovery for interactive or bounded operations.

### Limitations
- **Scope**: Covers Reflex fault injection and fail-safe recovery. Does not implement adaptive retry or self-healing heuristics.
- **Single Attempt Rejection**: Current recovery simply rejects the proposal and increments `proposalRejections`. Future phases may explore adaptive replanning.
