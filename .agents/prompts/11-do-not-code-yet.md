# Prompt 11: "Do Not Code Yet" Gatekeeper Prompt

This prevents jumping ahead to speculative generation.

```markdown
DO NOT WRITE CODE.
Analyze the requested feature:
[FEATURE]

Your task is only to determine:
- what problem it solves
- whether Emerald actually needs it
- which layer owns it
- what existing modules it affects
- what new contracts are required
- what state transitions are required
- what failure modes exist
- what security implications exist
- what telemetry is required
- how it will be evaluated
- how it affects latency
- what should explicitly NOT be built

Then propose the smallest implementation plan.
STOP.
Wait for implementation approval.
```
