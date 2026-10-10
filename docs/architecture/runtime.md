# Emerald Agent Fabric: Runtime Architecture

## 1. The Execution Loop
The runtime implements the explicit loop:
```
OBSERVE
   ↓
UNDERSTAND
   ↓
PLAN
   ↓
PROPOSE ACTION
   ↓
REFLEX (Risk assessment, Action necessity, Confidence)
   ↓
POLICY (Security policies, Capability verification)
   ↓
EXECUTE (Sandboxed tool invocation)
   ↓
OBSERVE
   ↓
VERIFY (Deterministic verification & test pass check)
```

## 2. State Machine Specification
```
                 ┌───────────────┐
                 │    CREATED    │
                 └───────┬───────┘
                         │
                         ▼
                 ┌───────────────┐
                 │    QUEUED     │
                 └───────┬───────┘
                         │
                         ▼
                 ┌───────────────┐
                 │    LEASED     │
                 └───────┬───────┘
                         │
                         ▼
                 ┌───────────────┐
       ┌─────────┤    RUNNING    ├─────────┐
       │         └───────┬───────┘         │
       │                 │                 │
       ▼                 ▼                 ▼
┌──────────────┐ ┌──────────────┐  ┌──────────────┐
│  RECOVERING  │ │  VERIFYING   │  │WAIT_APPROVAL │
└──────┬───────┘ └───────┬──────┘  └───────┬──────┘
       │                 │                 │
       └────────┬────────┴─────────┬───────┘
                │                  │
                ▼                  ▼
        ┌──────────────┐   ┌──────────────┐
        │  COMPLETED   │   │FAILED/TIMEOUT│
        └──────────────┘   └──────────────┘
```

## 3. Worker Leasing and Heartbeats
- Workers acquire a lease with an explicit TTL.
- Active workers must emit heartbeats to retain lease ownership.
- If a worker crashes or drops heartbeats, the lease expires and enters `RECOVERING`.
- All operations are backed by idempotency keys to ensure crash-recovery without duplicate side effects.
