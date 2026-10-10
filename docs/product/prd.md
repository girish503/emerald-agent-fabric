# Emerald Agent Fabric: Product Requirements Document (PRD) Index & Baseline

## Status
Living Document — Governed by Master Engineering Constitution Version 1.0.

## 1. Problem
Autonomous software-engineering agents operate on real filesystems, execute shell commands, and interact with complex developer environments. Existing open-source and commercial implementations often suffer from:
- Fragile execution loops with unhandled failure states.
- Inadequate or illusory sandboxing that risks machine security and exposes secrets.
- Opaque decision-making with subjective evaluation ("looks good").
- Tight coupling to single model providers or proprietary prompt architectures.
- High, unmeasured latencies and runaway token usage without disciplined latency decomposition.

## 2. Target Users
1. **AI Infrastructure Engineers**: Designing agent runtimes, orchestration engines, and tool execution boundaries.
2. **AI Security Researchers**: Auditing tool permissions, capability leaks, prompt injection resistance, and sandbox escapes.
3. **Agent Evaluation Researchers**: Benchmarking harness modifications on deterministic tasks (SWE-bench, Harbor).

## 3. High-Level Capabilities Roadmap
- **Phase 0**: Research / PRD / Architecture & Foundations.
- **Phase 1**: Deterministic Runtime.
- **Phase 2**: Durable State Machine.
- **Phase 3**: Local Sandbox.
- **Phase 4**: Typed Tool System.
- **Phase 5**: Validated Event Architecture.
- **Phase 6**: UI Run Console.
- **Phase 7**: Agent Runtime (Observe -> Understand -> Plan -> Propose -> Reflex -> Policy -> Execute -> Observe -> Verify).
- **Phase 8**: GitHub Issue -> PR Workflow.
- **Phase 9**: Evidence Bundle Generation.
- **Phase 10**: Replay System.
- **Phase 11**: Reflex Engine.
- **Phase 12**: Harness Evolution & Controlled Experiments.
- **Phase 13**: Browser Verification.
- **Phase 14**: Security Attack Suite.
- **Phase 15**: Failure Injection.
- **Phase 16**: Benchmark Laboratory.
- **Phase 17**: Scale Experiments.

## 4. Acceptance Criteria & Definition of Done
Every PRD slice must specify:
- Functional & Non-Functional requirements.
- Security & Reliability boundaries.
- Observability & Latency model impacts.
- Concrete test plan and verifiable criteria.
