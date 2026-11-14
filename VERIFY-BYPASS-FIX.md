# Verification Bypass Fail-Closed Remediation Report

## 1. Executive Summary
This remediation closes the spec-less verification bypass vulnerability identified in `src/application/worker-runtime.ts` (lines 1694–1785). Previously, when a `MissionContract` specified zero verification specifications (`!vSpecs || vSpecs.length === 0`), the verification block was bypassed entirely, allowing the run to transition directly to `COMPLETED` based solely on provider `SUCCESS`.

With this fix, the runtime enforces a strict fail-closed boundary by default: any run executing under a contract with zero or missing verification specifications is rejected, transitioned to `FAILED` with code `NO_VERIFICATION_SPECS`, records diagnostic evidence into the run evidence stream, safely disposes of the workspace, and cannot be marked as a verified success.

If an operator explicitly sets `allowUnverifiedCompletion` (via `--allow-unverified-completion` on CLI / worker host), the run is allowed to complete without failing closed, but:
1. An authoritative domain event `verification.unverified_completion_authorized` is durably appended to the event stream recording the operator's identity and timestamp.
2. The run is never marked as verified (`isVerificationPassed` remains false; verification evidence records `UNVERIFIED_COMPLETION_AUTHORIZED`).
3. Scoped memory verification recordings are omitted.

---

## 2. Exact Changes in Runtime and Infrastructure

### A. `src/application/worker-runtime.ts`
- Added `allowUnverifiedCompletion?: boolean;` to `WorkerRuntimeOptions`.
- Added `public readonly allowUnverifiedCompletion: boolean;` field on `WorkerRuntime`.
- Imported `createEvidence`, `createOutputPayloadEvidence`, `createProcessExitEvidence`, and `type DomainEvent`.
- In `runOnce()`, before checking `vSpecs`, if `!vSpecs || vSpecs.length === 0`:
  - Checks if `this.allowUnverifiedCompletion` is true or if a prior `verification.unverified_completion_authorized` event exists on the run.
  - If authorized by operator:
    - Appends durable event `verification.unverified_completion_authorized` with operator identity into state store transaction.
    - Records output payload and exit evidence.
    - Allows completion without failing closed, but run remains unverified.
  - If unauthorized:
    - Records output evidence and `NO_VERIFICATION_SPECS` diagnostic evidence.
    - Safely disposes workspace.
    - Fails run closed with code `NO_VERIFICATION_SPECS`.

### B. `src/application/worker-host.ts`
- Forwarded `allowUnverifiedCompletion: options.allowUnverifiedCompletion === true` into both `WorkerRuntime` constructor calls (governed provider branch and in-process execution provider branch).

### C. `src/cli/emerald-cli.ts`
- Added `--verification-spec <json>` flag to `emerald submit` for attaching verification specifications via CLI.
- Added `--web-ui-root <dir>` / `--web-ui` validation and forwarding in `handleServer`.

### D. Test Fixtures Categorized and Updated
All test fixtures that were relying on spec-less auto-pass were given explicit, minimal verification specifications matching their intended outcomes, without weakening any assertions:
- `tests/application/artifact-export-worker.test.ts` (3 fixtures specced)
- `tests/transport/durable-http-server.integration.test.ts` (scenarios 4, 5, 6, 7 specced with `EXACT_OUTPUT_MATCH`)
- `tests/recovery/tenant-launch-coordinator.test.ts` (scenario 10 specced in `setupHarness`)
- `tests/e2e/production-worker-cli.test.ts` (submit helper updated with operation-specific verification specs)
- `tests/application/durable-cli-agent-wiring.test.ts` (scenarios 2, 4, 8 specced with `--verification-spec`)
- `tests/application/worker-workspace-disposal.test.ts` (scenarios 1b, 5b, 12, 13 specced)
- `tests/application/workspace-runtime-integration.test.ts` (scenarios 1, 2, 5 specced)

---

## 3. Run Status & Lifecycle Behavior

### Without Operator Override (Default Fail-Closed):
- **Run Status**: `FAILED` (never `COMPLETED`).
- **Error Code**: `NO_VERIFICATION_SPECS`.
- **Error Message**: `"Contract specifies zero verification specifications; cannot complete run as verified success"`.
- **Evidence Stream**: Records output payload evidence, process exit evidence, and a diagnostic `OUTPUT_PAYLOAD` evidence item detailing `NO_VERIFICATION_SPECS`.
- **Event Lifecycle**: Emits `run.failed` event; `run.completed` is never emitted.
- **Workspace State**: Disposed safely with reason `"No verification specifications"`.

### With Operator Override (`allowUnverifiedCompletion: true`):
- **Run Status**: `COMPLETED`.
- **Event Lifecycle**: Emits `verification.unverified_completion_authorized` with operator identity and reason `OPERATOR_OPT_IN_NO_VERIFICATION_SPECS`.
- **Verification Integrity**: Marked as unverified, never verified success.

---

## 4. Verification Results

### A. TypeScript Build & Baseline Gate Check
- `npm run build`: Exit 0 (clean compilation).
- `node scripts/ci/check-tsc-baseline.js`:
  - Approved Baseline Total: 287
  - Current Diagnostics: 255
  - New Diagnostics: 0 (GATE PASSED)
  - Resolved Diagnostics: 32

### B. Vitest Targeted Test Suites
- `tests/application/worker-runtime-verification-bypass.test.ts`: 3/3 passed (fail-closed spec-less, specced success, explicit opt-in).
- `tests/application/completion-evidence-gate.test.ts`: 16/16 passed.
- `tests/application/artifact-export-worker.test.ts`: 7/7 passed.
- `tests/transport/durable-http-server.integration.test.ts`: 25/25 passed.
- `tests/recovery/tenant-launch-coordinator.test.ts`: 48/48 passed.
- `tests/e2e/production-worker-cli.test.ts`: 4 passed, 2 skipped (Windows).
- `tests/application/durable-cli-agent-wiring.test.ts`: 9/9 passed.
- `tests/application/worker-workspace-disposal.test.ts`: 19/19 passed.
- `tests/application/workspace-runtime-integration.test.ts`: 15/15 passed.

**Total Targeted Tests**: 9 test files passed, 146 passed | 2 skipped | 0 failed.
