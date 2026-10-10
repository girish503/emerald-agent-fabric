# Emerald Agent Fabric: Primary Use Cases

## Use Case 1: Autonomous Issue Resolution on a Sandboxed Repository
- **Actor**: Autonomous Agent / Developer.
- **Trigger**: A GitHub issue or reproduction script is provided.
- **Workflow**:
  1. System initializes a durable run and leases a worker.
  2. Isolated OCI container sandbox is instantiated with restricted network/filesystem.
  3. Repository is cloned at a specified immutable revision.
  4. Agent executes bounded loop: Observe repository -> Plan fix -> Propose edits -> Reflex risk check -> Security policy validation -> Sandboxed execution.
  5. Agent runs deterministic tests and verifications.
  6. On success, an Evidence Bundle is produced (diff, execution logs, test outputs, token & latency metrics).
- **Invariants**: Permanent credentials never enter sandbox. All tool invocations are logged as typed events.

## Use Case 2: Controlled Harness Evolution Experiment
- **Actor**: AI Evaluation Researcher.
- **Trigger**: An observed agent failure on a benchmark dataset (e.g., SWE-bench Verified).
- **Workflow**:
  1. Researcher documents failure classification and creates a reproducible test case.
  2. Modifies single harness parameter (e.g. tool schema or verification policy) to produce `harness-vNext`.
  3. Controlled experiment is run: Baseline vs Treatment under identical models, repositories, and budgets.
  4. Metrics compared: Success rate, latency, token consumption, tool call counts, safety violations.
  5. Harness change is promoted or rejected strictly based on evidence.

## Use Case 3: Offline Deterministic Replay and Audit
- **Actor**: Security Auditor / Infrastructure Engineer.
- **Trigger**: A suspicious tool call, security policy trip, or runtime anomaly during a previous run.
- **Workflow**:
  1. Auditor loads Run ID and corresponding Evidence Bundle.
  2. Replay engine reconstructs exact environment state, harness version, model inputs/outputs, and tool events.
  3. Step-by-step verification inspects policy decisions, reflex assessments, and sandbox capability checks.
