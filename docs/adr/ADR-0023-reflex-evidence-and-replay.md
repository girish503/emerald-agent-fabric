# ADR-0023: Reflex Evidence and Replay Instrumentation

## Status
Accepted

## Context
Across Phase 8, Emerald Agent Fabric established the governed Reflex architecture:
- **Phase 8.1**: Established the governed `ReflexPort` interceptor boundary situated strictly between `ProposalValidator` and `PolicyEvaluator`.
- **Phase 8.2**: Added deterministic, explainable safety heuristics (`reflex.failure-loop.v1`, `reflex.redundant-action.v1`, `reflex.budget-pressure.v1`).
- **Phase 8.3**: Empirically compared unassisted `BASELINE` and `REFLEX` execution under controlled conditions, demonstrating that Reflex halts futile repeated failure loops and redundant action loops while preserving a 100% pass rate on productive work.

However, prior to Phase 8.4, Reflex decisions were transient runtime events captured only as scalar status fields on the step transcript. The runtime lacked:
1. **Immutable Observational Record**: No dedicated domain entity captured the complete input state, rule configuration hash, context hash, decision, reason code, and evidence signal.
2. **Deterministic Offline Replay**: Verifying whether Reflex behaved correctly previously required re-running the entire system (agent step controller, live agent brain, mock or real model provider, policy evaluator, and durable SQLite store).
3. **Cryptographic Tamper-Evidence**: No canonical content hash bound the decision to the specific proposal and observational context snapshot.
4. **Epistemic and Security Boundaries**: No formal schema guaranteed that secrets, credentials, or authority-granting tokens were excluded from captured Reflex records, or that replay could run with zero side effects.

### Research Question
> Can every Reflex decision be captured as deterministic, replayable evidence such that the same Reflex input and configuration produce the same decision and reason without invoking the model or executing tools?

## Decision

### 1. Pure Domain Model for Reflex Evidence
Establish `ReflexEvidence` in `src/domain/reflex-evidence.ts`:
```typescript
export interface ReflexEvidence {
  readonly evidenceId: string;
  readonly schemaVersion: number;
  readonly runId: string;
  readonly sequenceNumber: number;
  readonly proposalId: string;
  readonly toolName: ToolName;
  readonly actionInputHash: string;
  readonly contextSnapshotHash?: string;
  readonly reflexImplementation: string;
  readonly reflexImplementationVersion: string;
  readonly ruleConfigurationHash: string;
  readonly reflexContextHash: string;
  readonly decision: ReflexDecisionKind;
  readonly reasonCode: ReflexReasonCode;
  readonly triggeredRuleId?: string;
  readonly observedSignal?: string;
  readonly thresholdUsed?: number;
  readonly observedCount?: number;
  readonly rationale?: string;
  readonly precedenceIndex?: number;
  readonly replayInput: ReflexReplayInput;
  readonly evidenceIdentityHash: string;
  readonly evaluatedAt: string;
}
```

### 2. Pure Offline Deterministic Replay
Implement `replayReflexEvidence(evidence, options)`:
- **Guarantees**:
  1. **Zero Model Execution**: Never calls LLM providers, local Ollama, or mock brains.
  2. **Zero Tool Execution**: Never executes tools, mutates filesystems, or spawns Docker containers.
  3. **Zero Persistence Mutation**: Never reads or writes to SQLite databases.
  4. **Strict Comparison Semantics**:
     - `MATCH`: Recomputed decision, reason code, and triggered rule match the recorded evidence bit-for-bit.
     - `MISMATCH_DECISION`: Recomputed decision differs from recorded decision.
     - `MISMATCH_REASON`: Recomputed reason code differs.
     - `MISMATCH_RULE`: Recomputed triggered rule differs.
     - `MISMATCH_CONFIGURATION`: Evaluator configuration hash does not match `ruleConfigurationHash`.
     - `MISMATCH_CONTEXT`: Context hash integrity check fails against `reflexContextHash`.
     - `INVALID_EVIDENCE`: Evidence schema validation or tamper-evident hash verification fails.

### 3. Tamper-Evident Cryptographic Identity Hash
Implement `computeReflexEvidenceIdentityHash`:
- Deterministic canonical JSON serialization with lexicographical key ordering.
- Cryptographic SHA-256 digest.
- Excludes volatile runtime metadata (`evaluatedAt`, `evidenceId`).
- Guarantees bit-for-bit tamper evidence: any alteration to proposal, context, rule configuration hash, decision, or reason code invalidates the hash.

### 4. Security, Credential, and Authority Firewalls
Enforce strict security boundaries:
- **64 KB Payload Ceiling**: Total serialized canonical evidence cannot exceed `MAX_REFLEX_EVIDENCE_BYTES` (65,536 bytes).
- **Secret Firewall**: Rejects any proposal or context containing sensitive keywords (`isSensitiveKey`: `secret`, `password`, `token`, `apiKey`, etc.).
- **Authority Firewall**: Strictly rejects forbidden authority fields (`findForbiddenAuthorityKeys`: `workerId`, `leaseId`, `contractBinding`, `capabilities`, `isolationLevel`, etc.).
- **Monotonic Authority Invariant**: Evidence is purely observational and confers zero execution authority:
  $$\text{EffectiveAuthorityAfterReflex} \subseteq \text{EffectiveAuthorityBeforeReflex}$$

### 5. Runtime & Evaluation Integration
- **`AgentStepController`**:
  - In `REFLEX` mode (`!(this.reflex instanceof NoopReflex)`), creates and attaches `reflexEvidence` to `StepTranscriptEntry`.
  - In `BASELINE` mode (`NoopReflex`), leaves `reflexEvidence` strictly `undefined`.
- **`EvaluationRunner` & `EvaluationTrial`**:
  - Extracts `reflexEvidence` from transcript entries into `EvaluationRunResult` and `EvaluationTrial`.
  - Includes `evidenceId` in `evidenceReferences`.
  - Replay can be performed directly from completed `EvaluationTrial` records without external dependencies.

## Consequences

### Positive
- **Complete Replayability**: Any Reflex decision across historical evaluation trials can be verified offline in microseconds.
- **Auditable Safety**: Interventions (`REJECT`, `DEFER`) and pass-throughs (`ALLOW`) are cryptographically bound to exact inputs and configuration hashes.
- **Zero Fabrication**: Baseline runs produce no synthetic evidence, maintaining empirical distinction between conditions.
- **Preserved Epistemic Integrity**: `UNKNOWN` execution states in context history remain `UNKNOWN` and are never rewritten.

### Limitations
- Replay verifies the Reflex decision logic given captured inputs; it does not simulate downstream environment state divergence.
