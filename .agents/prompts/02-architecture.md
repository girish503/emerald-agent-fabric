# Prompt 02: Architecture Prompt

Use after PRD approval.

```markdown
Act as a Principal Distributed Systems Engineer.
Given this approved PRD:
[PRD]

Design the smallest architecture that satisfies it.
Provide:
- Component boundaries
- Data flow
- State transitions
- APIs
- Domain objects
- Persistence
- Concurrency model
- Failure model
- Security boundaries
- Observability
- Latency model
- Testing boundaries
- Scaling boundary

For every proposed technology answer:
WHY THIS?

Also explicitly list:
WHAT WE ARE NOT BUILDING.

Do not introduce infrastructure merely because it is common in industry.
Prefer simple local architecture until measurements require distributed infrastructure.
Produce an ADR-ready decision.
Do not write implementation code.
```
