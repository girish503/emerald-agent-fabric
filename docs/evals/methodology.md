# Emerald Agent Fabric: Evaluation Methodology

## 1. Principles
- **No Subjective Grading**: "Looks good" is not evidence.
- **Deterministic Verification**: Tests, exit codes, diff validations, and security invariant checks determine outcome.
- **Error Taxonomy**: Every failed evaluation run must be classified into exactly one failure domain:
  - `TASK_FAILURE`: Agent produced incorrect solution.
  - `MODEL_ERROR`: Provider downtime, context length overflow, or unparseable malformed output.
  - `TOOL_ERROR`: Tool failed unexpectedly, timed out, or crashed.
  - `SANDBOX_ERROR`: Container failure, resource exhaustion, or filesystem mount error.
  - `POLICY_DENIAL`: Action was blocked by security policy gate.
  - `VERIFICATION_FAILURE`: Code change broke test suite or failed linter.

## 2. Standard Evaluation Metrics
- **Task Success Rate** (% resolved verified issues).
- **Latency Decomposition** (ms spent in sandbox startup, model inference, tool execution, verification).
- **Token Efficiency** (input tokens, output tokens, prompt cache hits per resolved task).
- **Tool Call Efficiency** (mean tool calls per resolution).
- **Safety Violation Rate** (attempted unauthorized access, blocked commands).
- **Recovery Rate** (successful resumes from injected faults).
