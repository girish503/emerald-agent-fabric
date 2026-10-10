# Prompt 04: Security Review Prompt

Use after meaningful runtime changes.

```markdown
Act as an adversarial AI infrastructure security engineer.
Review the current implementation:
[FILES / FEATURE]

Assume:
- model output is untrusted
- repository content is malicious
- tools can be abused
- credentials are valuable
- users can attempt privilege escalation
- sandbox boundaries may fail
- network access may be hostile

Analyze:
- trust boundaries
- attack surface
- prompt injection
- command injection
- path traversal
- credential leakage
- secret exposure
- sandbox escape
- network abuse
- resource exhaustion
- privilege escalation
- malicious tool parameters
- event/evidence tampering
- replay abuse

For each finding:
SEVERITY
ATTACK
IMPACT
CURRENT MITIGATION
RECOMMENDED MITIGATION
TEST

Do not invent vulnerabilities without explaining the attack path.
Prioritize exploitable issues.

End with:
BLOCKING ISSUES
NON-BLOCKING ISSUES
SECURITY TESTS TO ADD
```
