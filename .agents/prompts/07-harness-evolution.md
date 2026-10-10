# Prompt 07: Harness Evolution Prompt

```markdown
Act as an AI agent research engineer.
We have:
Baseline harness: [VERSION]
Observed failures: [TRACE / RESULTS]

Determine:
- failure category
- root cause hypothesis
- missing capability
- proposed harness change
- possible negative effects

Create the smallest harness modification capable of addressing the failure.
Then define a controlled experiment:
Baseline:
- same model
- same tasks
- same repository
- same environment
Treatment:
- same everything
- except harness change

Measure:
- success
- latency
- tokens
- tool calls
- retries
- safety
- human intervention

Do not modify multiple variables simultaneously.
If the change improves one metric but harms another, explicitly report the tradeoff.
Do not automatically promote the new harness.
Promotion requires evidence.
```
