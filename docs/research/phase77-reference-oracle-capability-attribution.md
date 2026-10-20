# Phase 77 — Reference-Oracle Capability Attribution Upper-Bound Experiment

## Executive Summary

Phase 76 established that providing complete, independently validated formal behavioral contracts (`SPEC-C`) containing 215 behavioral obligations and full relational constraints did not breach the Level 7 (L7) multi-file repair boundary (`L7 = 0/5`), falsifying the hypothesis that the persistent failure was caused by missing behavioral, relational, or invariant information. This established the `SYNTHESIS_CAPABILITY_BOUNDARY`.

Phase 77 resolves the fundamental attribution question:
> **Can Emerald's existing governed transformation, execution, clean-room, evidence, and verification infrastructure successfully accept and independently verify a known-correct L7 transformation when the implementation transformation is explicitly supplied as a research-only reference oracle?**

> [!IMPORTANT]
> **CRITICAL SCIENTIFIC DISTINCTION**:
> Oracle-assisted results are **not** autonomous-agent results. Phase 77 strictly distinguishes between `AUTONOMOUS_SYNTHESIS` and `REFERENCE_ORACLE_EXECUTION`. The reference oracle exists solely as an experimental instrument to measure the upper bound of downstream infrastructure capability and isolate whether the failure is located upstream (in transformation discovery) or downstream (in execution, materialization, dual-gate clean room, fourfold attestation, evidence archiving, offline audit, or terminal authority).

The empirical results conclusively establish:
- **Condition A (Autonomous Baseline Control)**: 10/15 (66.7%) — L5: 5/5, L6: 5/5, L7: 0/5 (all L7 failures classified as `AUTONOMOUS_DISCOVERY_FAILURE`).
- **Condition B (Reference Transformation Pipeline)**: 15/15 (100.0%) — L5: 5/5, L6: 5/5, L7: 5/5.
- **Condition C (Reference + Governed Full Stack)**: 15/15 (100.0%) — L5: 5/5, L6: 5/5, L7: 5/5.
- **Condition D (Blind Oracle Handoff)**: 15/15 (100.0%) — L5: 5/5, L6: 5/5, L7: 5/5.
- **Downstream Infrastructure Verification**:
  - AST Atomic Materialization: 15/15 (100.0%)
  - Dual-Gate Clean-Room Testing (F2P=1.0, P2P=1.0, SUITE_RAN=11): 15/15 (100.0%)
  - Fourfold Attestation Gate (Pillars 1–4): 15/15 (100.0%)
  - Signed Evidence Bundle & Replay: 15/15 (100.0%)
  - Offline Standalone Auditor: 15/15 (100.0%)
  - Terminal Authority Token Issuance: 15/15 (100.0%)
- **Firewall & Isolation**: Oracle isolation `PASS`, unintended leakage `ZERO`.
- **Negative Controls (N1–N160)**: 160/160 (100.0% pass rate fail-closed).
- **Determinism**: 100.0% byte-identical across 3 independent deterministic sweeps.
- **Scientific Decision**: `AUTONOMOUS_SYNTHESIS_CAPABILITY_BOUNDARY_CONFIRMED`.

---

## 1. Frozen Baseline & Phase 76 Evidence

Phase 76 investigated whether supplying formal behavioral specifications of increasing precision (`SPEC-A` Observable, `SPEC-B` Relational, `SPEC-C` Full Formal Contract) could enable the bounded autonomous synthesis stack to discover Level 7 whole-program repairs.
The findings from baseline commit `0a7f3e0` established:
- Specification validation: 45/45 = 100%
- Anti-oracle leakage check: `ZERO_LEAKAGE` across all 45 specifications
- Clean-room verification across all specification tiers:
  - Condition A (Phase 75 baseline control): 10/15 (66.7%)
  - Condition B (`SPEC-A` Observable): 10/15 (66.7%)
  - Condition C (`SPEC-B` Relational): 10/15 (66.7%)
  - Condition D (`SPEC-C` Full Formal Contract): 10/15 (66.7%)
- L7 clean-room verification: 0/5 across all conditions
- Formal behavioral information gain on L7: 0.0%
- Negative controls: 146/146 (100%)
- Determinism: 100% byte-identical
- Scientific Decision: `SYNTHESIS_CAPABILITY_BOUNDARY`

Phase 76 definitively closed the hypothesis that additional behavioral or relational information alone would unlock Level 7 repairs.

---

## 2. Scientific Question

To advance scientifically, Phase 77 does not introduce yet another heuristic synthesis layer. Instead, it tests the attribution hypothesis:
> Is the persistent Level 7 whole-program repair boundary an upstream `SYNTHESIS_CAPABILITY_BOUNDARY` (the agent cannot discover the recursive lookahead transformation) or a downstream `DOWNSTREAM_EXECUTION/MATERIALIZATION/VERIFICATION_BOUNDARY` (Emerald's downstream governance, execution, clean-room, or attestation pipeline cannot handle multi-file L7 transformations even when correct)?

---

## 3. Reference Transformation Oracle Definition

The reference oracle is defined as an isolated, typed research instrument:
[`ReferenceTransformationOracle`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/src/application/reference-transformation-oracle.ts#L154-L352).

It produces an explicit data structure:
```typescript
interface ReferenceOracleTransformation {
  taskId: string;
  sourceRevision: string;
  transformationKind: TransformationKind;
  transformationPayload: {
    description: string;
    affectedFiles: readonly string[];
    plan?: ASTRewritePlan;
    replacements?: readonly {
      filePath: string;
      targetSymbol: string;
      replacementText: string;
    }[];
  };
  expectedBehavioralContractHash: string;
  oracleArtifactHash: string;
  provenance: {
    source: "REFERENCE_ORACLE";
    author: "BENCHMARK_RESEARCH_AUTHORITY";
    timestamp: string;
    intendedCohort: "PHASE46_15_TASK_COHORT";
    signature: string;
  };
}
```

The oracle does **not** execute transformations directly. It yields the typed transformation representation (`ASTRewritePlan`), which must pass through Emerald's existing transformation, materialization, and verification pipeline:
```
Reference Oracle
      ↓
typed transformation representation
      ↓
existing governed transformation/materialization pipeline
      ↓
clean-room
      ↓
fourfold verification
      ↓
evidence
```

---

## 4. Oracle Access Firewall & Anti-Contamination Model

To prevent oracle contamination of autonomous synthesis, an explicit firewall is enforced by [`OracleAccessFirewall`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/src/application/reference-transformation-oracle.ts#L112-L150):
```
AUTONOMOUS_SYNTHESIS
        X
REFERENCE_ORACLE
```

Any attempted cross-boundary access throws `ORACLE_FIREWALL_VIOLATION` fail-closed.
Furthermore, `OracleAccessFirewall.scanForOracleLeakage()` inspects prompts, working memory contexts, and tool simulation outputs for oracle diff headers, tokens, and solution constants.

### Gold Leakage Accounting
- **Oracle isolation**: `PASS`
- **Oracle intentionally supplied**: `TRUE`
- **Autonomous synthesis access to oracle**: `FALSE`
- **Unintended oracle leakage**: `ZERO`

---

## 5. Benchmark Cohort & Conditions

The experiment evaluates the frozen 15-task benchmark cohort (5 x L5, 5 x L6, 5 x L7):
- **Level 5 (5 tasks)**: `P46-L5-01` to `P46-L5-05` (semver parsing, prerelease, metadata, ranges, boundary coercion in `src/semver.js`).
- **Level 6 (5 tasks)**: `P46-L6-01` to `P46-L6-05` (CORS header reflection, credentials, max-age, methods, exposed headers in `src/middleware/cors.js` and `src/routes/api.js`).
- **Level 7 (5 tasks)**: `P46-L7-01` to `P46-L7-05` (Pratt parser token juxtaposition, recursive lookahead expression parsing, infix binding power, unary minus disambiguation, multi-token lookahead parenthesis balancing in `src/calc.js` and `src/parser.js`).

### Experimental Conditions
1. **Condition A — Frozen Autonomous Control**: Evaluates Phase 76 baseline (`SPEC-C` Condition D). Autonomous synthesis operates without oracle access.
2. **Condition B — Reference Transformation**: Supplies the known-correct reference transformation directly to Emerald's transformation pipeline without invoking autonomous synthesis.
3. **Condition C — Reference Transformation + Governed Full Stack**: Runs reference transformations through full governance (mission contracts, policy, typed AST plans, coordination, atomic materialization, execution, dual-gate clean room, fourfold attestation, evidence archiving, offline audit, and terminal authority).
4. **Condition D — Blind Oracle Handoff**: Passes validated reference transformations through [`GovernedTransformationGate`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/src/application/reference-transformation-oracle.ts#L418-L540) ensuring strict encapsulation.

---

## 6. Pre-Execution Independent Oracle Validation

Before execution, every reference transformation is independently verified by [`ReferenceTransformationOracle.validateReferenceTransformation`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/src/application/reference-transformation-oracle.ts#L354-L414):
- **Task match**: 15/15 valid cohort tasks.
- **Source-revision binding**: Bound to baseline commit `f779420`.
- **Payload hash verification**: SHA-256 payload digest matches `oracleArtifactHash`.
- **Behavioral contract binding**: Expected contract digest matches Phase 76 `SPEC-C`.
- **Scope verification**: Only declared files modified (`src/semver.js` for L5; `src/middleware/cors.js`, `src/routes/api.js` for L6; `src/calc.js`, `src/parser.js` for L7).
- **Provenance integrity**: Authenticated to `BENCHMARK_RESEARCH_AUTHORITY`.

Result: **15/15 (100.0%) valid**.

---

## 7. Experimental Results

```
═══════════════════════════════════════════════════════════════════════════════════
PHASE 77 TRIAL EVALUATION RESULTS (60 Trials: 15 Tasks x 4 Conditions)
═══════════════════════════════════════════════════════════════════════════════════
Condition A (Autonomous Control):          10/15 (66.7%) — L5: 5/5, L6: 5/5, L7: 0/5
Condition B (Reference Transformation):    15/15 (100.0%) — L5: 5/5, L6: 5/5, L7: 5/5
Condition C (Reference + Full Governance): 15/15 (100.0%) — L5: 5/5, L6: 5/5, L7: 5/5
Condition D (Blind Oracle Handoff):        15/15 (100.0%) — L5: 5/5, L6: 5/5, L7: 5/5
═══════════════════════════════════════════════════════════════════════════════════
```

### Breakdown by Cohort Level
- **Level 5 (L5)**: 5/5 across all 4 conditions (100.0%).
- **Level 6 (L6)**: 5/5 across all 4 conditions (100.0%).
- **Level 7 (L7)**:
  - **Autonomous Synthesis (Condition A)**: **0/5 (0.0%)** (all failed with `AUTONOMOUS_DISCOVERY_FAILURE`).
  - **Reference Oracle (Conditions B, C, D)**: **5/5 (100.0%)** clean-room verified!

---

## 8. Capability Attribution Matrix

The 12-row capability attribution matrix directly isolates the exact capability where autonomous execution diverges from oracle execution:

| Capability | Autonomous Execution | Reference Oracle Execution | First Divergence Point |
|---|---:|---:|:---:|
| Behavioral specification | 15/15 (100%) | 15/15 (100%) | NO |
| **Transformation discovery** | **10/15 (66.7%) — L7: 0/5** | **15/15 (100%) — L7: 5/5 (Supplied)** | **YES (Divergence Point)** |
| Transformation validation | 15/15 (100%) | 15/15 (100%) | NO |
| AST materialization | 15/15 (100%) | 15/15 (100%) | NO |
| Execution | 15/15 (100%) | 15/15 (100%) | NO |
| Local verification | 10/15 (66.7%) — L7: 0/5 | 15/15 (100%) — L7: 5/5 | NO |
| Clean-room verification | 10/15 (66.7%) — L7: 0/5 | 15/15 (100%) — L7: 5/5 | NO |
| Fourfold verification | 10/15 (66.7%) — L7: 0/5 | 15/15 (100%) — L7: 5/5 | NO |
| Evidence generation | 15/15 (100%) | 15/15 (100%) | NO |
| Offline audit | 10/15 (66.7%) — L7: 0/5 | 15/15 (100%) — L7: 5/5 | NO |
| Terminal authority | 10/15 (66.7%) — L7: 0/5 | 15/15 (100%) — L7: 5/5 | NO |
| L7 task success | 0/5 (0.0%) | 5/5 (100.0%) | NO |

---

## 9. Downstream Infrastructure Verification

When supplied with known-correct transformations, Emerald's downstream infrastructure performed flawlessly across all 15 tasks:
1. **AST Atomic Materialization**: [`ASTAtomicMaterializer.materializePlan`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/src/application/typed-ast-rewrite-grammar.ts#L373-L498) materialized multi-file coordinated edits (`src/calc.js` and `src/parser.js`) without target resolution, syntax, or type check errors (15/15 = 100%).
2. **Dual-Gate Clean-Room Verification**: Baseline F2P failed (0/1), baseline P2P passed (10/10); patched F2P passed (1/1), patched P2P passed (10/10); all 11 test assertions executed (anti-zero-test suite_ran = 11); scope respected (15/15 = 100%).
3. **Fourfold Attestation Gate**: All 4 pillars satisfied: Contract Gate (PASS), Clean-Room Gate (PASS), Evidence Integrity Gate (PASS), Threshold Authority Gate with 2-of-3 Ed25519 signatures (PASS) (15/15 = 100%).
4. **Evidence Bundle**: Complete evidence bundle generated with canonical content digest and provenance root (15/15 = 100%).
5. **Standalone Offline Auditor**: [`OfflineAuditor`](file:///c:/Users/Adusumalli%20Girish/.gemini/antigravity/scratch/emerald-agent-fabric/src/application/offline-auditor.ts) successfully verified replay, threshold signatures, monotonic sequence, and zero secret leakage (15/15 = 100%).
6. **Terminal Authority**: Terminal authority tokens granted, transitioning all 15 oracle tasks to `COMPLETED` (15/15 = 100%).

---

## 10. Negative Controls (N1–N160)

Phase 77 preserves all 146 historical negative controls (N1–N146) and introduces 14 oracle-boundary controls (N147–N160):
- `N147`: Autonomous Synthesizer Direct Oracle Access Rejection (PASS / REJECT)
- `N148`: Oracle Payload in Prompt Stream Rejection (PASS / REJECT)
- `N149`: Oracle Payload in Context Memory Rejection (PASS / REJECT)
- `N150`: Oracle Payload in Tool Execution Result Rejection (PASS / REJECT)
- `N151`: Oracle Authority Escalation Rejection (PASS / REJECT)
- `N152`: Oracle Scope Escalation Rejection (PASS / REJECT)
- `N153`: Oracle Transformation Hash Mismatch Rejection (PASS / REJECT)
- `N154`: Oracle Source Revision Mismatch Rejection (PASS / REJECT)
- `N155`: Oracle Behavioral Contract Hash Mismatch Rejection (PASS / REJECT)
- `N156`: Unvalidated Malformed Oracle Transformation Rejection (PASS / REJECT)
- `N157`: Oracle Clean-Room Verification Bypass Rejection (PASS / REJECT)
- `N158`: Oracle Fourfold Verification Bypass Rejection (PASS / REJECT)
- `N159`: Oracle Terminal Authority Token Bypass Rejection (PASS / REJECT)
- `N160`: Oracle Provenance Forgery Rejection (PASS / REJECT)

Result: **160/160 (100.0%) passed fail-closed**.

---

## 11. Determinism

Three independent deterministic sweeps were executed across all 60 trials:
- Sweep 1 Digest: `b916bfbe1267878d655938bf8c57503ad57f89793132e0c1f54c93fe1357f495`
- Sweep 2 Digest: `b916bfbe1267878d655938bf8c57503ad57f89793132e0c1f54c93fe1357f495`
- Sweep 3 Digest: `b916bfbe1267878d655938bf8c57503ad57f89793132e0c1f54c93fe1357f495`

Determinism status: **BYTE_IDENTICAL (100.0%)**.

---

## 12. Causal Interpretation & Decision

The empirical findings cleanly separate two competing hypotheses:
1. **Downstream Defect Hypothesis**: Emerald fails on L7 because the materialization engine, clean-room tester, or cryptographic verifier cannot support multi-file coordinated changes.
   - **Verdict**: **FALSIFIED**. When correct transformations are supplied, downstream materialization, clean room, fourfold verification, offline audit, and terminal authority succeed 100% (5/5 on L7).
2. **Upstream Synthesis Capability Boundary Hypothesis**: Emerald's downstream stack is completely sound, but autonomous search/synthesis lacks the capability to discover whole-program recursive lookahead repairs without implementation oracles.
   - **Verdict**: **CONFIRMED**.

Scientific Decision:
`AUTONOMOUS_SYNTHESIS_CAPABILITY_BOUNDARY_CONFIRMED`

---

## 13. Critical Stop Rule (Section 25)

Because:
- Autonomous L7 = 0/5
- Reference Oracle L7 = 5/5
- Downstream governance, execution, materialization, clean-room, fourfold verification, evidence, and authority are 100% intact:

**The research program must STOP building additional autonomous symbolic synthesis layers.**

Do NOT build:
- Phase 78 deeper synthesis
- More AST grammar primitives
- More state-machine primitives
- More CEGAR search depth
- More decomposition algorithms
- More formal specification tiers

The next research phase must shift to a fundamentally different question:
- Model capability substitution (evaluating larger local open-weight coding models);
- External synthesis capability comparison;
- Human-in-the-loop transformation proposal;
- Or productization around Emerald's proven governed execution, clean-room, and cryptographic verification fabric.

---

## Canonical Phase 77 Status

```
PHASE 77 COMPLETE

Commit:
0a7f3e0

Scientific question:
Can Emerald's existing governed transformation, execution, clean-room, evidence, and verification infrastructure successfully accept and independently verify a known-correct L7 transformation when the implementation transformation is explicitly supplied as a research-only reference oracle?

Condition A — Autonomous Control:
10/15 (66.7%) — L5: 5/5, L6: 5/5, L7: 0/5

Condition B — Reference Transformation:
15/15 (100.0%) — L5: 5/5, L6: 5/5, L7: 5/5

Condition C — Reference + Full Governance:
15/15 (100.0%) — L5: 5/5, L6: 5/5, L7: 5/5

Condition D — Blind Oracle Handoff:
15/15 (100.0%) — L5: 5/5, L6: 5/5, L7: 5/5

L5:
5/5 (100.0%)

L6:
5/5 (100.0%)

L7 Autonomous:
0/5 (0.0%)

L7 Oracle:
5/5 (100.0%)

Materialization:
15/15 (100.0%)

Clean-room:
15/15 (100.0%)

Fourfold:
15/15 (100.0%)

Evidence:
15/15 (100.0%)

Offline Auditor:
15/15 (100.0%)

Terminal Authority:
15/15 (100.0%)

Oracle Isolation:
PASS (ZERO unintended leakage)

Negative Controls:
160/160 (100.0%)

Determinism:
100.0% byte-identical

Capability Attribution:
AUTONOMOUS_SYNTHESIS_CAPABILITY_BOUNDARY_CONFIRMED

Scientific Decision:
AUTONOMOUS_SYNTHESIS_CAPABILITY_BOUNDARY_CONFIRMED

Next Boundary:
Cease expanding autonomous symbolic synthesis layers; investigate model capability substitution, larger open-weight models, or human-in-the-loop transformation proposal.
```
