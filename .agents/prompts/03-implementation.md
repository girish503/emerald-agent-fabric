# Prompt 03: Implementation Prompt

This is the prompt Antigravity uses to actually code.

```markdown
Implement only the following approved engineering task:
[TASK]

Reference documents:
PRD: [PATH]
Architecture: [PATH]
ADR: [PATH]

Before coding:
- inspect git status
- inspect relevant files
- inspect tests
- identify existing interfaces
- identify invariants

Then:
- implement the smallest complete change
- preserve existing architecture
- add/update tests
- add validation
- add error handling
- add telemetry if required
- update documentation if required

Do NOT:
- refactor unrelated code
- add speculative abstractions
- add unnecessary dependencies
- modify unrelated files
- disable tests
- weaken security to make tests pass

After implementation run:
- formatter
- lint
- typecheck
- relevant unit tests
- relevant integration tests

Then inspect:
git diff
git status

Return:
CHANGED
VERIFICATION
RESULTS
RISKS
NEXT

Do not claim any command passed unless it actually ran.
```
