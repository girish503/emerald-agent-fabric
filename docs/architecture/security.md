# Emerald Agent Fabric: Security Architecture

## 1. Threat Model & Untrusted Boundaries
The architecture treats the following boundaries as untrusted:
1. **Task Input & Operation Parameters**: Can contain malformed data, schema-breaking keys, or attempted prototype pollution.
2. **Worker Identifiers**: Must be validated against the worker registry; rogue or stale workers must not forge lease renewals.
3. **Future Model & Tool Outputs**: Treated as untrusted payload strings subject to strict schema validation.
4. **Execution Runtime**: Host OS privileges must be isolated; Capability 1 uses pure in-process function execution, with OS isolation deferred to Phase 3.

---

## 2. Layered Trust Boundaries (Capability 1)

```
[ Untrusted Client / External Inputs ]
                  │
                  ▼
         [ Input Validation Gate ]
     Strict Zod Schemas / Property Stripping
                  │
                  ▼
         [ Domain State Machine ]
     Pure Invariant Checks / State Transition Validation
                  │
                  ▼
         [ Persistence Boundary ]
     100% Parameterized SQL Statements (SQLite Prepared)
                  │
                  ▼
         [ Worker / Lease Gate ]
     Fencing Token Verification (`lease_id`, `version`)
                  │
                  ▼
         [ Execution Boundary ]
     Isolated `OperationPort` (Pure Functions in Capability 1)
```

---

## 3. Core Security Controls

### 3.1 Input Validation & Schema Sanitization
- All task inputs and operation parameters are passed through strict Zod schemas with unknown key stripping (`z.object(...).strict()`).
- Prevents object prototype pollution and schema drift before data touches the database.

### 3.2 SQL Injection Defense
- 100% of SQLite database queries use prepared parameterized statements (`better-sqlite3` or typed SQLite bindings).
- Dynamic SQL string concatenation is strictly forbidden by repository lint rules.

### 3.3 Lease Fencing & Worker Isolation
- Workers cannot mutate a run unless they present the active, unexpired `lease_id` and matching `version`.
- Stale workers that stall past their lease expiration are fenced off; updates fail with 0 rows affected.

### 3.4 Event Log Integrity (Application-Level Append-Only)
- We explicitly do NOT claim that SQLite files are "cryptographically tamper-proof." An operator or attacker with raw OS filesystem write access could alter SQLite bytes directly.
- Instead, the architecture guarantees **application-level append-only immutability**:
  - The persistence repository exposes only an `appendEvent` method.
  - No `UPDATE` or `DELETE` SQL queries exist for `run_events` in the codebase.
  - Foreign key constraints and unique sequence constraints prevent sequence forgery through application APIs.

### 3.5 Secret Redaction & Log Hygiene
- Permanent credentials are never stored in `tasks`, `runs`, or `run_events`.
- Payloads are checked against a recursive redaction filter (`apiKey`, `password`, `token`, `secret`) before any JSON string is written to diagnostic stdout/stderr streams.

### 3.6 Operation Dispatch vs Authorization Gate
- Resolving an operation by `operationName` within an `ExecutionProvider` is mechanical execution routing, **NOT** an authorization mechanism.
- Future tool execution and agent capabilities must pass through policy and capability authorization gates before being dispatched to any execution provider.
- Execution providers report mechanical outcomes only and do not evaluate security policy.

