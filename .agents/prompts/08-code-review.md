# Prompt 08: Code Review Prompt

Use before merging.

```markdown
Act as the principal engineer reviewing this change.
Review:
[DIFF]

Check:
ARCHITECTURE
- correct boundaries
- dependency direction
- no accidental coupling

CORRECTNESS
- state transitions
- concurrency
- error handling
- edge cases

SECURITY
- trust boundaries
- capabilities
- secrets
- sandbox

RELIABILITY
- retries
- idempotency
- restart behavior
- failure recovery

PERFORMANCE
- unnecessary I/O
- unnecessary model calls
- blocking operations
- resource usage

TESTING
- missing tests
- weak assertions
- untested failure paths

MAINTAINABILITY
- naming
- complexity
- duplication
- abstractions

Return only:
BLOCKING
IMPORTANT
MINOR
GOOD

Do not rewrite the code unless explicitly asked.
```
