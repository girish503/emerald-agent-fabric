# ADR-0043: Secure REST Verification Specification Contract and Durable REST-to-Worker Propagation

## 1. Status
- **Status**: SECURITY_ACCEPTED.
- **Date**: 2026-11-10
- **Relates to**: ADR-0001 (Engineering Constitution), ADR-0002 (Durable State Machine), ADR-0004 (Tool Execution Gateway), ADR-0009 (Agent Step Controller), ADR-0036 (Mutation Intent & Crash Recovery), ADR-0037 (Tenant Quiescence).
- **Not a claim**: This design does not claim to permit arbitrary remote shell command execution by unauthenticated or untrusted callers; it establishes a strictly typed, allowlisted, server-validated, and tamper-evident verification contract for durable REST task submissions.

---

## 2. Context & Problem Statement

Prior to this decision, `POST /api/v1/tasks` accepted an input field `verificationSpecs` defined as `{ name: string, command: string, timeoutMs: number, expectedExitCode: number }`. However, in `src/transport/http/server.ts`, `submitDurableTask` created the durable `MissionContract` with an empty specification list: `verificationSpecs: []`.

This architectural gap caused two major issues:
1. **Completion Impossibility for REST Workloads**: In accordance with Emerald's engineering constitution (Section 9 & Section 19), an agent execution cannot reach authorized `COMPLETED` status without independent, authoritative verification evidence matching a contract specification. Because REST-submitted tasks had `verificationSpecs: []`, they could never be verified, resulting in fail-closed termination (`COMPLETION_UNVERIFIABLE: NO_VERIFICATION_SPECS`).
2. **Security Vulnerability of Unvalidated Command Strings**: Accepting an unparsed, raw shell `command: string` from external API tenants presents a critical prompt-injection and command-injection vector if passed directly into an execution sandbox without strict argument tokenization, executable allowlisting, and shell metacharacter rejection.

---

## 3. Required Safety & Architectural Invariants

- **Invariant A (Structured Representation over Raw Shell Strings)**:
  Verification commands must be represented as structured argument vectors (`argv: string[]`), not untrusted shell command strings. Shell interpreters (`sh`, `bash`, `zsh`, `cmd`, `powershell`) and shell metacharacters (`;`, `&`, `|`, `` ` ``, `$`, `>`, `<`, `\n`, `\r`) are strictly rejected.
- **Invariant B (Strict Executable Allowlisting & Operation Registry)**:
  Only server-approved test runner executables (`node`, `npm`, `npx`, `vitest`, `jest`, `python`, `python3`, `pytest`, `cargo`, `go`, etc.) are permitted. System utilities, network tools (`curl`, `wget`, `nc`, `ssh`), privilege escalators (`sudo`, `su`), container tools (`docker`, `kubectl`), and filesystem-destroying utilities (`rm`, `dd`, `mkfs`) are unconditionally rejected.
- **Invariant C (Authoritative Validation Before Persistence)**:
  All verification specifications must be validated by the server before any task, contract, or run record is created in the durable state store. Malformed or unauthorized specifications result in HTTP 400 Bad Request without side effects.
- **Invariant D (Immutable Contract Binding & Content Hash Integrity)**:
  Persisted verification specifications are permanently bound to the task contract `(tenantId, contractId, version)`. The canonical `contentHash` of the `MissionContract` covers the full array of verification specifications. Any post-issuance tampering is rejected as a `ContractIntegrityError`.
- **Invariant E (End-to-End Propagation to Worker Runtime)**:
  The authoritative specifications persisted in `MissionContract.spec.verificationSpecs` are loaded by the claiming worker and executed by `AgentStepController` via `executeGovernedVerificationStage`.
- **Invariant F (Governed Execution & Independent Completion Gate)**:
  Verification actions must execute strictly through `WorkerRuntime.executeAction` and `ToolExecutionGateway` using the configured physical provider. Completion authorization remains exclusively owned by the system-owned completion gate. Model-generated claims (`isGoalReached`) are never authoritative.
- **Invariant G (Server-Defined Verification Operation Registry & Code Execution Prohibition)**:
  Executable allowlists alone are insufficient. The server enforces a strict verification operation registry (`src/application/verification-operation-registry.ts`): arbitrary code execution flags (`-e`, `--eval`, `-c`, `-r`, `--require`, `--import`, `--inspect`, `--prof`), path traversals (`..`), absolute paths (`/`, `\`, `C:\`), and unauthorized package/binary subcommands (`npm install`, `npm exec`) are strictly rejected.
- **Invariant H (Zero Capability Escalation)**:
  Attaching verification specifications NEVER elevates the agent's policy capabilities (`allowedCapabilities`). The agent cannot propose or execute `run_command` unless explicitly granted `process.execute`. Verification commands execute strictly under server-owned system verification authority (`systemVerificationSpecId`) matched against immutable contract specifications.

---

## 4. Decision & Architecture

### 4.1 Schema Definition (`src/transport/http/api-contracts.ts`)
The `VerificationSpecInputSchema` is upgraded to support both structured argument vectors and strictly validated legacy commands:

```ts
export const ALLOWED_VERIFICATION_EXECUTABLES: readonly string[] = Object.freeze([
  "node", "npm", "npx", "vitest", "jest",
  "python", "python3", "pytest",
  "cargo", "go",
  "ruby", "rake", "rspec",
  "mvn", "gradle", "dotnet",
]);

export const SHELL_METACHARACTER_REGEX = /[;&|`$><\n\r]/;

export const VerificationSpecInputSchema = z
  .object({
    specId: z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/).optional(),
    name: z.string().min(1).max(128).optional(),
    ruleKind: z.enum(["EXIT_CODE_ZERO", "EXACT_OUTPUT_MATCH", "OUTPUT_HASH_MATCH"]).default("EXIT_CODE_ZERO"),
    argv: z.array(z.string().min(1).max(1024)).min(1).max(64).optional(),
    command: z.string().min(1).max(1024).optional(),
    timeoutMs: z.number().int().positive().max(300_000).default(30_000),
    expectedExitCode: z.number().int().default(0),
    expectedHash: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
    expectedOutput: z.unknown().optional(),
    requireMutation: z.boolean().default(false),
    requireDiff: z.boolean().default(false),
  })
  .strict();
```

### 4.2 Durable Submission Transformation (`src/application/durable-submission.ts`)
`SubmitDurableTaskParams` is extended to accept `verificationSpecs`. During `submitDurableTask`:
1. Each input spec is validated and transformed into a domain `VerificationSpec` (`createVerificationSpec`).
2. For `EXIT_CODE_ZERO`, `expectedValue` is populated with `{ toolName: "run_command", argv, timeoutMs, expectedExitCode, requireMutation, requireDiff }`.
3. `createMissionContract` incorporates `verificationSpecs`. The contract's canonical hash is computed and stored.
4. The contract is inserted into SQLite and marked `ACTIVE`.

### 4.3 Worker Propagation & Verification Execution
1. When a worker process (`WorkerHost`) claims a run, it reads the active `MissionContract` via `RunCoordinator`.
2. When the agent loop halts (`GOAL_REACHED`, action budget exhaustion, or terminal stagnation candidate), `AgentStepController` evaluates `contract.spec.verificationSpecs`.
3. The verification command is dispatched through `executeGovernedVerificationStage` to `WorkerRuntime.executeAction`.
4. Provider results are recorded as process exit evidence with provenance `SYSTEM_VERIFICATION`.
5. The independent completion gate verifies that `exitCode === 0` and latches completion.

---

## 5. Security & Isolation Considerations
1. **Multi-Tenant Isolation**: Specifications are scoped to the authenticated `principal.tenantId`. Evidence produced in one tenant run cannot satisfy contracts in another tenant.
2. **No Host Execution Fallback**: Physical execution provider remains mandatory. Untrusted workloads cannot fall back to host execution.
3. **Replay & Fencing Safety**: Checkpoint reconciliation and attempt deduplication tokens (`verification:${runId}:${actionId}:${attemptNumber}`) prevent replay attacks or stale worker revivals.
4. **Denial-of-Service Defense**: Per-command timeout is capped at $\min(300000, \text{remainingVerificationBudgetMs})$. Total verification action count and wall-clock budget remain independently enforced.

---

## 6. Verification & Acceptance
- Unit tests in `tests/transport/api-contracts.test.ts` (40 of 40 passed) for schema validation, metacharacter rejection, executable allowlisting, code-execution flag prohibition (`-e`, `--eval`, `-c`), and path traversal rejection.
- Unit and integration tests in `tests/transport/durable-http-server.integration.test.ts` and `tests/transport/fastify-server.test.ts` (96 of 96 passed) for contract persistence and contentHash integrity.
- Integration tests in `tests/integration/rest-verification-propagation.integration.test.ts` (10 of 10 passed) for end-to-end REST submission → contract persistence → worker claim → system-owned verification → completion gate authorization, including negative tests proving zero capability escalation for agent proposals.
- TypeScript CI Quality Baseline Gate: passed with zero new diagnostics (283 current vs 287 baseline; 4 resolved).
