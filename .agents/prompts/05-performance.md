# Prompt 05: Performance Prompt

```markdown
Act as a senior performance engineer specializing in AI agent systems.
Investigate this operation:
[OPERATION]

Do not optimize by intuition.
First identify the latency decomposition:
- queue
- scheduling
- sandbox
- repository
- context
- model
- tool
- verification
- persistence
- streaming

Determine which measurements currently exist.
If measurements are missing, add instrumentation before optimizing.

Then:
- establish baseline
- identify dominant bottleneck
- formulate one hypothesis
- change one variable
- benchmark
- compare baseline vs treatment
- report statistical/repeated-run results where practical

Track:
- latency
- CPU
- RAM
- tokens
- model calls
- tool calls
- retries
- task success

Do not sacrifice correctness or security for speed.

Return:
BASELINE
BOTTLENECK
HYPOTHESIS
CHANGE
MEASUREMENTS
RESULT
TRADEOFF
RECOMMENDATION
```
