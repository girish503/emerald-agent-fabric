# Emerald Agent Fabric — Bounded Pilot Operating Procedure: Local Model Developer Assistance

## Document Metadata
- **Document Type**: Standard Operating Procedure (SOP) & Runbook
- **Date**: 2026-10-23
- **Scope**: Local developer-assistance workflows using small open-weight models
- **Governing Constitution**: [GEMINI.md](../../GEMINI.md) (Master Engineering Constitution Version 1.0)
- **Governing Architecture Decision**: [ADR-0033: Bounded Human-in-the-Loop Repair with Small Local Models](../adr/ADR-0033-bounded-human-in-the-loop-repair-with-small-local-models.md)
- **Primary Model**: `qwen2.5-coder:3b` via local Ollama (`http://127.0.0.1:11434`)
- **Cost Policy**: Strictly ₹0 (Local CPU inference only; zero external cloud APIs or paid services)

---

## 1. Operating Philosophy & Scope

This Standard Operating Procedure defines the precise, step-by-step methodology for executing software engineering assistance tasks within Emerald Agent Fabric under the constraints established by [ADR-0033](../adr/ADR-0033-bounded-human-in-the-loop-repair-with-small-local-models.md).

### The Core Boundary
The supported operating mode is **Bounded Human-in-the-Loop Single-File Repair**. Under this posture:
- The agent runtime inspects code, diagnoses defects, and proposes line-anchored edits.
- The human operator reviews proposed diffs and retains sole decision authority.
- The runtime enforces strict capability boundaries, schema validation, and sovereign verification.
- **Autonomous multi-file software engineering is strictly prohibited.**

---

## 2. Supported 10-Step Operating Workflow

Every real-world engineering task must progress sequentially through the following ten stages.

```
1. TASK SELECTION
   ↓
2. BASELINE PREFLIGHT
   ↓
3. READ-ONLY INSPECTION
   ↓
4. ISOLATED LOCALIZATION
   ↓
5. STRUCTURED PROPOSAL
   ↓
6. HUMAN APPROVAL GATE
   ↓
7. GOVERNED MUTATION
   ↓
8. AUTOMATED REGRESSION & VERIFICATION
   ↓
9. EVIDENCE RECORDING & REPLAY
   ↓
10. FAIL-CLOSED REJECTION / CLOSEOUT
```

---

### Step 1: Task Selection & Scope Definition
- **Criteria**: Select a genuine, concrete, single-file defect or boundary check omission (e.g. unhandled OS error, missing input boundary validation).
- **Prohibition**: Do not manufacture synthetic bugs, modify frozen research artifacts (Phases 1–99), or attempt cross-module architectural refactoring.
- **Verified Target**: Identify exactly one mutable source file (e.g., `src/tools/production-tools.ts`).

### Step 2: Baseline Preflight & Working-Tree Preservation
- **Command**:
  ```bash
  git rev-parse --abbrev-ref HEAD
  git rev-parse HEAD
  git status --short
  node bin/emerald.js doctor
  ```
- **Requirements**:
  - Record the Git branch, HEAD commit SHA, and current working-tree state.
  - Verify subsystem health using `node bin/emerald.js doctor` (Node.js >= v20, Git, Docker, Ollama reachable, SQLite WAL ready).
  - Confirm all pre-existing user changes (staged, unstaged, or untracked) are noted and preserved. Do not run `git reset`, `git checkout`, or `git clean`.

### Step 3: Governed Read-Only Source Inspection
- **Mechanism**: Use `ProductionToolGateway` under capability `READ_WORKSPACE` with `read_file` or `search_code`.
- **Command / Programmatic Pattern**:
  ```typescript
  const gateway = new ProductionToolGateway(governance);
  const result = await gateway.executeTool("read_file", { path: targetFile }, toolContext);
  ```
- **Invariant**: The target file SHA-256 digest must be computed and recorded. Zero disk mutations are permitted during this stage.

### Step 4: Isolated Defect Localization & Empirical Reproduction
- **Rule**: Reproduce the observed defect empirically in an isolated sandbox or temporary directory before attempting any source code edits.
- **Mechanism**: Create a temporary directory (`os.mkdtempSync(path.join(os.tmpdir(), "emerald-repro-"))`), trigger the runtime condition, record the raw error code/message, and cleanly unlink temporary files.
- **Output**: Confirm whether the defect is reproducible (`reproduced: true`) without touching the repository root.

### Step 5: Structured Proposal Generation & Strict Validation
- **Model Invocation**: Prompt local `qwen2.5-coder:3b` via `OllamaModelAdapter` (`http://127.0.0.1:11434`, timeout 120,000ms).
- **Contract Requirement**: The prompt must supply a canonical JSON example adhering strictly to `validateStructuredProposal` and `EditFileAnchorInputSchema.strict()`:
  ```json
  {
    "version": "v1.8.0",
    "thought": "Add missing regular file check in toolWriteFile",
    "toolName": "edit_file_anchor",
    "toolInput": {
      "path": "src/tools/production-tools.ts",
      "searchAnchor": "exact_code_to_find",
      "replacementText": "exact_code_with_fix"
    },
    "isGoalReached": false
  }
  ```
- **Pre-Mutation Anchor Verification**: Check on disk that `searchAnchor` matches **exactly once** (`occurrences === 1`). If zero or more than one match is found, reject immediately.

### Step 6: Human Review & Blocking Approval Gate
- **Mechanism**: Submit an approval request to `ApprovalControl`:
  ```typescript
  const request = approvalControl.requestApproval({
    runId: run.runId,
    operation: "edit_file_anchor",
    parameters: proposal.toolInput,
    riskLevel: "MEDIUM",
    justification: "Repair toolWriteFile directory path defect",
  });
  ```
- **Operator Review**: Present the reproduction evidence, exact search anchor, and replacement text to the human operator.
- **Approval Execution**: The human operator must explicitly grant approval via `approvalControl.approve(approvalId, "operator", reason)`.
- **Enforcement**: If approval is denied or pending, the runtime halts without applying any changes.

### Step 7: Governed Line-Anchored Mutation
- **Mechanism**: Execute `edit_file_anchor` via `ProductionToolGateway` under capability fence `WRITE_TEMPORARY_OUTPUT`.
- **Governance Gate**: `ProductionGovernanceFacade.evaluateProposal(...)` verifies active fence authorization, tool whitelisting, and approval state.
- **Editor**: `LineAnchoredEditor.applyEdit()` performs an atomic write using temporary swap files and updates the target file.
- **Diff Audit**: Execute `git diff <targetFile>` to verify that only the intended lines were modified.

### Step 8: Automated Regression Testing & Independent Verification
- **Targeted Test Probe**: Execute an isolated probe script or direct vitest command verifying the repaired behavior:
  - Verify that the defect condition is rejected fail-closed with a domain error.
  - Verify that normal functionality remains operational.
- **Full Production Regression Suite**:
  ```bash
  npx vitest run tests/production/
  npx vitest run tests/e2e/
  npx vitest run tests/integration/phase99-governed-capability-fencing.test.ts
  npx tsx scripts/verify-phase10h-artifacts.ts
  ```
- **Sovereign Verification**: Run `ProductionVerifier.verify({ workspacePath, expectedModifiedFiles: [targetFile] })`.
- **Requirement**: All 140 production tests, E2E tests, capability fencing tests (262/262), and Phase 10H invariant checks (36/36) must pass.

### Step 9: Evidence Sealing & Deterministic Replay
- **Evidence Bundle**: Seal a `ProductionEvidenceBundle` containing the mission contract hash, model ID, prompt context digest, action timeline, git diff, test results, and sovereign proof hash.
- **3-Sweep Replay**: Run `ProductionReplayEngine.reconstructRun(bundle)` across 3 consecutive sweeps. Reconstructed outputs must be bit-for-bit identical (`s1 === s2 && s2 === s3`).
- **Persistence**: Save the complete machine-readable trial record in `scratch/bounded-real-project-<taskId>-results.json` and a Markdown audit report in `docs/production/bounded-real-project-<taskId>-report.md`.

### Step 10: Task Closeout & Git Hygiene
- **Git State**: Confirm `git status --short` shows only the single intended modified file and newly created unique evidence files.
- **Zero Commit Policy**: Do **NOT** run `git commit` or `git push`. Hand over the verified, unstaged modification to the human developer for final review and manual commit.

---

## 3. Mandatory Stop Conditions & Reporting Protocol

The operator and agent must halt execution immediately without mutating workspace files upon encountering any of the following stop conditions:

| Stop Condition | Trigger Criterion | Immediate Action | Operator Notification |
| :--- | :--- | :--- | :--- |
| **Schema Validation Failure** | Proposal fails `validateStructuredProposal` (`valid: false`) | Abort mutation; record schema error | Report invalid tool payload; do not guess syntax |
| **Anchor Match Ambiguity** | `searchAnchor` matches 0 or >1 times on disk | Abort edit; reject fail-closed | Report non-unique anchor count; do not use fuzzy matching |
| **Scope Expansion** | Proposal targets >1 file or touches forbidden directories | Halt execution; deny authorization | Report scope violation; restrict to approved target |
| **Approval Rejection / Timeout** | Operator declines approval or request times out | Halt workflow; retain state | Record approval denial in `ApprovalControl` |
| **Capability Fence Denial** | Action rejected by `ProductionGovernanceFacade` (e.g. `N711`) | Halt tool dispatch; fail closed | Report unauthorized tool/capability |
| **Verification Failure** | Unit tests fail or `ProductionVerifier` fails | Halt; classify `VERIFICATION_FAILED` | Report exact test failure output; do not commit |
| **Frozen Artifact Collision** | Proposed change touches Phases 1–99 or historical evidence | Immediately abort session | Report invariant breach; freeze immutable paths |
| **Resource / Hardware Ceiling** | Memory pressure > 90% or model inference timeout (>120s) | Terminate Ollama request | Report hardware constraint (ADR-0032) |

### Reporting Rule
When a stop condition is triggered, the operator must record the failure state in the task evidence JSON, classify the outcome (e.g. `PROPOSAL_VALIDATION_FAILED`, `ANCHOR_AMBIGUOUS`, `GOVERNANCE_DENIED`), and stop. **Indefinite or unconstrained retry loops are strictly forbidden.**

---

## 4. Machine-Readable Task Record Template

Every executed task must generate a standardized JSON record saved to `scratch/` matching the following schema:

```json
{
  "taskId": "task-YYYYMMDD-unique-name",
  "provenance": "genuine-real-project",
  "repository": "emerald-agent-fabric",
  "category": "HUMAN_REVIEWED_REPAIR",
  "title": "Short Descriptive Title of Defect Repair",
  "description": "Concrete explanation of the defect and repair strategy",
  "targetFile": "path/to/target/file.ts",
  "intendedOutcome": "Expected behavior and fail-closed domain error",
  "isMutationCapable": true,
  "model": "qwen2.5-coder:3b",
  "schemaVersion": "v1.8.0",
  "schemaDigest": "0a91b348fe7a26c60e2fb2124824d68986228ae46582f51382766f99fe68314e",
  "startTimestamp": "2026-10-23T06:00:00.000Z",
  "endTimestamp": "2026-10-23T06:01:00.000Z",
  "wallClockDurationMs": 60000,
  "modelInferenceMs": 45000,
  "operatorReviewMs": 15000,
  "verificationDurationMs": 2500,
  "promptCount": 1,
  "repromptCount": 0,
  "manualCorrectionsCount": 0,
  "proposalStatus": "ACCEPTED",
  "initialGitSha": "7109911fa4488c5759000fe08c3a77895ed214f4",
  "finalGitSha": "7109911fa4488c5759000fe08c3a77895ed214f4",
  "initialFileDigest": "sha256_before_edit",
  "finalFileDigest": "sha256_after_edit",
  "isByteIdentical": false,
  "modelProducedUsableProposal": true,
  "schemaValidationPassed": true,
  "toolSelected": "edit_file_anchor",
  "governanceAuthorized": true,
  "anchorMatchedUniquely": true,
  "approvalRequestId": "appr-timestamp-id",
  "humanReviewedDiff": true,
  "humanReviewApproved": true,
  "mutationOccurred": true,
  "defectReproductionInIsolation": {
    "reproduced": true,
    "rawErrorCode": "EISDIR",
    "rawErrorMessage": "error details"
  },
  "testsPassed": true,
  "sovereignVerified": true,
  "replayVerified": true,
  "unintendedWorkspaceChanges": false,
  "failureAttribution": "NONE_SUCCESSFUL_REPAIR",
  "taskStatus": "PASS",
  "outcomeClassification": "VERIFIED_HUMAN_APPROVED_REPAIR",
  "gitDiff": "diff --git a/... b/...",
  "evidenceBundleId": "sha256_bundle_digest",
  "proposedChange": {
    "targetFile": "path/to/target/file.ts",
    "searchAnchor": "exact_anchor_string",
    "replacementText": "exact_replacement_string"
  }
}
```

---

## 5. Bounded Operating Policy & Explicit Prohibitions

In accordance with [GEMINI.md](../../GEMINI.md) and [ADR-0033](../adr/ADR-0033-bounded-human-in-the-loop-repair-with-small-local-models.md), the following constraints are non-negotiable:

### Explicit Prohibitions
1. **Autonomous Multi-File Repair**: No task may plan or execute changes across multiple files concurrently.
2. **Unreviewed Workspace Mutations**: No model output may modify disk files without explicit, recorded operator approval in `ApprovalControl`.
3. **Automated Git Commits or Pushes**: The runtime must never commit or push changes. Version control operations remain strictly developer-owned.
4. **Relaxed Validation or Permissive Fallbacks**: Never weaken strict Zod schemas (`.strict()`), permit fuzzy anchor matching, or fall back to full-file overwrites.
5. **Epistemological Non-Claims**:
   - Replay validity proves evidence capture consistency, **not** general model intelligence.
   - Sovereign verification proves configured checks passed on the target, **not** universal functional correctness across all edge cases.
   - Successful execution of bounded tasks does **not** constitute a broad statistical reliability claim.

### Runtime Controls vs. Documentation Guidance
- **Runtime Enforced**: Capability fence limits (`CapabilityFenceEnforcer`), path traversal containment (`resolveSafePath`), proposal validation (`validateStructuredProposal`), approval gating (`ApprovalControl`), and sovereign verification (`ProductionVerifier`).
- **Operator Guidance**: Task selection criteria, review diligence, and refusal to rubber-stamp unverified proposals.

---

## 6. Known Implementation Gaps & Unresolved Technical Limitations

Operators must remain aware of two technical discrepancies identified during the ADR-0033 audit:

1. **Tool Error Classification Discrepancy**:
   - *Current State*: `toolWriteFile` in `src/tools/production-tools.ts` throws a generic JavaScript `Error` (`throw new Error(...)`) when encountering non-regular files.
   - *Limitation*: While this produces a controlled failure payload (`{ success: false, error: "Target path is not a regular file: ..." }`) and prevents raw Node.js OS crashes, it is not a typed subclass of `DomainError` from `src/domain/errors.ts` and lacks a machine-actionable `.code`.
   - *Guidance*: Operators must evaluate error messages by string pattern matching until formal `DomainError` migration is authorized.

2. **Filesystem Concurrency & TOCTOU Race Window**:
   - *Current State*: File tools evaluate path existence and file type synchronously before opening (`existsSync` → `statSync` → `writeFileSync`).
   - *Limitation*: There is a theoretical Time-of-Check-to-Time-of-Use race window if an external, concurrent operating system process swaps the file between validation and write.
   - *Mitigation*: Single-tenant workspace sandboxing and path containment mitigate risk, but atomic file descriptor operations (`O_NOFOLLOW | O_EXCL`) are recommended for future hardening.
