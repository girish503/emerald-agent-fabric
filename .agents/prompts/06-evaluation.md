# Prompt 06: Evaluation Prompt

```markdown
Act as an AI agent evaluation researcher.
We need to evaluate:
[CAPABILITY]

Design a reproducible evaluation.
Define:
- task
- initial state
- environment
- model
- harness version
- tools
- allowed capabilities
- success criteria
- failure criteria
- safety criteria
- latency metrics
- resource metrics
- evidence requirements

Create:
- happy-path cases
- edge cases
- adversarial cases
- recovery cases
- regression cases

Do not use subjective grading where deterministic verification is possible.
Prefer executable evaluators.
The evaluation must distinguish:
- task failure
- model failure
- tool failure
- environment failure
- policy failure
- verification failure

Do not fabricate results.
Produce the evaluation specification and test implementation plan.
```
