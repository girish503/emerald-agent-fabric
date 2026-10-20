# Phase 74 Research Report: Governed Fine-Grained Typed AST Rewrite Grammar

## 1. Phase 73 Baseline & Boundary
Phase 73 evaluated Neural-Guided Governed Constructive Program Synthesis directly atop Phase 72 (`1765859`). Phase 73 introduced an untrusted local open-weight neural advisor (`qwen2.5-coder:3b`, Q4_K_M) through a strictly non-authoritative typed proposal schema and branch ranker. Phase 73 established:
- Valid Proposal Rate: `15/15 (100.0%)`
- Neural Ordering Gain: `+12.8%` search latency reduction
- Neural Discovery Gain: `0.0%`
- L5 Clean-Room Success: `5/5`
- L6 Clean-Room Success: `5/5`
- L7 Clean-Room Success: `0/5`
- Overall Success: `10/15 (66.7%)`
- Scientific Decision: `NEURAL_GUIDANCE_BOUNDARY`
- Remaining Boundary: `PROGRAM_SYNTHESIS_CAPABILITY_BOUNDARY`

Phase 73 definitively demonstrated that while neural guidance efficiently accelerates constructor selection and prioritizes search branches on L5/L6 tasks, high-level structural proposals cannot bridge the gap on L7 tasks. When decomposed tasks require fine-grained AST mutations across decoupled compilation units, coarse constructive calculus primitives (`GUARD`, `BRANCH`, `STATE_SET`, `SEQUENCE`) could not be mapped into executable multi-file code modifications without a fine-grained, typed AST rewrite grammar.

## 2. Research Question
Can a finite, typed, deterministic AST rewrite grammar provide the missing code materialization capability required to synthesize verified multi-file program transformations on L7 tasks, without resorting to unconstrained code generation or violating Emerald's fail-closed governance invariants?

## 3. Hypotheses
- **H1 (Grammar Expressivity)**: A finite set of 22 typed AST rewrite primitives across 16 node types and 9 effects can express arbitrary localized syntax modifications across JavaScript/TypeScript programs.
- **H2 (Target Determinism & Ambiguity Prevention)**: Exact AST target resolution using structural paths, source spans, and content hashes can uniquely identify mutation sites and reject ambiguous matches fail-closed.
- **H3 (Multi-File Atomic Materialization)**: Multi-file AST rewrite plans can be atomically verified, compiled, and applied, with full snapshot rollback (`ROLLBACK_ALL`) guaranteeing zero workspace residue on any parse, typecheck, or invariant failure.
- **H4 (Capability Boundary Falsification)**: If the persistent L7 failure is caused solely by coarse materialization granularity, introducing fine-grained AST rewrites will yield `L7 > 0/5`. If L7 remains `0/5`, the boundary is definitively confirmed to be semantic program synthesis rather than AST materialization.
- **H5 (Fail-Closed Governance Invariance)**: The introduction of fine-grained AST rewrite capabilities maintains 100% fail-closed compliance across all historical negative controls (N1–N110) and 15 new AST-specific controls (N111–N125).

## 4. Why This Differs from Prior Phases
- **Phases 60–67**: Evaluated symbolic repair, program space decomposition, and relational semantic synthesis on whole-program graphs.
- **Phases 68–69**: Evaluated runtime trace grounding and active coinductive exploration (proved evidence acquisition is not the bottleneck).
- **Phases 70–71**: Introduced constructive program induction calculus and guided heuristic search (proved search budget is not the primary blocker).
- **Phase 72**: Introduced the cross-module coordination protocol (proved multi-module interface synchronization achieves 100% agreement).
- **Phase 73**: Introduced neural proposal guidance (proved neural priors provide valid high-level skeletons but lack fine-grained code materialization).
- **Phase 74**: Directly addresses the AST materialization layer itself—replacing coarse template instantiations with a rigorous, typed, reversible AST rewrite grammar with atomic multi-file transaction semantics.

## 5. Grammar Architecture & Design Principles
The Phase 74 AST rewrite system is structured into five decoupled layers:
1. **Grammar Vocabulary**: 22 immutable rewrite primitives operating strictly on typed AST nodes.
2. **Target Resolution Layer (`ASTTargetResolver`)**: Computes exact structural matches, verifying source spans, node kinds, and target content hashes. Ambiguous structural targets (`AMBIGUOUS_AST_TARGET`) or missing nodes (`AST_TARGET_NOT_FOUND`) are rejected fail-closed.
3. **Dependency Supervisor (`ASTRewriteDependencyManager`)**: Models intra-plan rewrite dependencies as a directed acyclic graph (DAG), computes topological execution order, and rejects cycles (`AST_REWRITE_DEPENDENCY_CYCLE`).
4. **Atomic Materializer (`ASTAtomicMaterializer`)**: Executes multi-file transactions with pre-flight snapshotting, postcondition checking, and transactional rollback (`ROLLBACK_ALL`).
5. **Constructive Planner (`SemanticASTRewritePlanner`)**: Translates high-level constructive intent into ordered, typed AST rewrite plans.

## 6. 22 Finite AST Rewrite Primitives
The grammar defines exactly 22 finite, typed rewrite primitives:
1. `REPLACE_NODE`: Replace an AST node with another node of an identical kind.
2. `REPLACE_EXPRESSION`: Replace an expression node with an equivalent or refined expression.
3. `REPLACE_STATEMENT`: Replace a statement node within a statement list.
4. `INSERT_BEFORE`: Insert a statement or declaration before the target node.
5. `INSERT_AFTER`: Insert a statement or declaration after the target node.
6. `DELETE_NODE`: Remove an unused or redundant AST node.
7. `WRAP_EXPRESSION`: Wrap an expression in an enclosing expression (e.g., unary, call, or parenthesis).
8. `WRAP_STATEMENT`: Wrap a statement in a control-flow block (e.g., `try-catch` or `if`).
9. `REPLACE_OPERATOR`: Mutate a binary or unary operator (e.g., `===` to `!==`).
10. `REPLACE_LITERAL`: Update a literal value (number, string, boolean, null).
11. `REPLACE_IDENTIFIER`: Rename or substitute an identifier node.
12. `REPLACE_PARAMETER`: Replace a function parameter definition.
13. `INSERT_PARAMETER`: Append a new parameter to a formal parameter list.
14. `DELETE_PARAMETER`: Remove a parameter from a function declaration.
15. `REPLACE_CALL_ARGUMENT`: Replace an argument passed into a call expression.
16. `INSERT_CALL_ARGUMENT`: Insert an argument into a function call.
17. `DELETE_CALL_ARGUMENT`: Remove an argument from a function call.
18. `REPLACE_RETURN_EXPRESSION`: Replace the return expression in a return statement.
19. `INSERT_GUARD`: Insert a defensive condition check before a function body or sensitive operation.
20. `INSERT_STATE_UPDATE`: Insert an assignment updating module-scoped or instance state.
21. `REPLACE_CONDITION`: Mutate a test condition in an `if`, `while`, or ternary expression.
22. `REPLACE_BLOCK`: Replace an entire block statement body.

## 7. 16 Typed AST Nodes
All rewrite operations are strictly typed against 16 distinct AST node categories:
`Expression`, `Statement`, `Declaration`, `Parameter`, `Identifier`, `Literal`, `CallExpression`, `BinaryExpression`, `UnaryExpression`, `ConditionalExpression`, `Block`, `Function`, `Class`, `Import`, `Export`, `TypeNode`.

Type constraints require that `producedTargetType` matches the enclosing AST context. For instance, an expression context rejects a `Declaration` node (`N114`), and a parameter list rejects an unassociated `Statement`.

## 8. 9 Declared Rewrite Effects
Every rewrite operation declares its semantic effect footprint:
- `READ_AST`: Inspects AST nodes without modification.
- `WRITE_AST`: Modifies AST node contents or attributes.
- `STRUCTURAL_EDIT`: Alters the tree topology (inserting, deleting, wrapping nodes).
- `SEMANTIC_EDIT`: Alters program runtime semantics.
- `CONTROL_FLOW_EDIT`: Alters branching, loops, returns, or exceptions.
- `STATE_EDIT`: Introduces or mutates persistent or global state.
- `TYPE_EDIT`: Alters type annotations or signatures.
- `IMPORT_EDIT`: Adds, removes, or modifies module import statements.
- `EXPORT_EDIT`: Adds, removes, or modifies exported symbols.

Operations attempting state modification without declared `STATE_EDIT` are rejected fail-closed (`N115`).

## 9. AST Target Resolution & Ambiguity Prevention
To prevent non-deterministic or accidental code mutation, `ASTTargetResolver` requires:
- `filePath`: Relative repository path within the declared mutation scope.
- `sourceSpan`: Precise line and column bounding box (`startLine`, `startColumn`, `endLine`, `endColumn`).
- `nodeKind`: Expected `ASTRewriteType`.
- `structuralPath`: Canonical hierarchical path (e.g., `Program/FunctionDeclaration/BlockStatement/ReturnStatement`).
- `targetHash`: SHA-256 content digest of the target AST subtree.

If two or more nodes match a query, the resolver triggers `AMBIGUOUS_AST_TARGET` and halts execution (`N113`). If the content hash differs from the pre-flight inspection, `TARGET_HASH_MISMATCH` is returned (`N112`).

## 10. Topological Dependency Management & Cycle Detection
Complex program modifications often require multi-step edits (e.g., inserting a helper function before referencing it in a call expression). `ASTRewriteDependencyManager` models operations as graph nodes:
- Dependencies specify `fromOpId -> toOpId`.
- In-degrees are tracked using Kahn's algorithm.
- If the resolved topological sort contains fewer nodes than the total operation count, an `AST_REWRITE_DEPENDENCY_CYCLE` error is emitted and the entire plan is aborted (`N116`).

## 11. Atomic Multi-File Materializer & Snapshot Rollback Mechanics
The `ASTAtomicMaterializer` implements transactional ACID semantics:
1. **Pre-flight Budget Validation**: Enforces `maxRewriteOperations` (64), `maxFilesPerPlan` (6), `maxASTNodesTouched` (128), and `maxRewriteDepth` (8).
2. **Snapshot Creation**: Records in-memory snapshots of all affected files prior to applying edits.
3. **Sequential Materialization**: Applies topologically sorted rewrites.
4. **Post-Materialization Validation**: Runs incremental parsing and typechecking.
5. **Transactional Rollback (`ROLLBACK_ALL`)**: If any operation, parse step, or invariant fails, all modified files are restored from snapshot. Zero dirty workspace residue survives (`N117`).

## 12. Constructive Intent to AST Rewrite Translation
`SemanticASTRewritePlanner` maps abstract constructive programs (Phase 70) and neural structural proposals (Phase 73) into concrete `ASTRewritePlan` instances:
- For single-function tasks (L5), generates localized `INSERT_GUARD` and `REPLACE_EXPRESSION` operations on single files.
- For multi-function tasks (L6), generates coordinated rewrites across two files (e.g., middleware and route handlers).
- For whole-program tasks (L7), generates cross-module rewrites across multiple compilation units (e.g., `src/calc.js` and `src/parser.js`) with explicit dependency links.

## 13. Frozen Rewrite Budgets & Resource Bounds
All Phase 74 evaluations are strictly bounded by frozen architectural limits:
- `maxRewriteOperations`: 64 operations
- `maxFilesPerPlan`: 6 files
- `maxNodesPerRewrite`: 1 node
- `maxASTNodesTouched`: 128 nodes
- `maxRewritePlans`: 64 plans
- `maxRewriteDepth`: 8 levels
- `maxRollbackAttempts`: 1 attempt
- `maxRewriteWallClockMs`: 30,000 ms per trial

## 14. Experimental Hardware Profile
All experiments were conducted on the frozen research platform:
- **CPU**: Intel(R) Core(TM) i3-N305 @ 1.80GHz (8 cores / 8 threads)
- **RAM**: 7.63 GiB (8,192,663,552 bytes)
- **Accelerator**: `ACCELERATOR_UNAVAILABLE` (Strict local CPU execution, ₹0 compute cost)
- **Operating System**: Windows 11
- **Node.js**: v20.19.0
- **Timeout Ceiling**: 120,000 ms per run

## 15. 4 Experimental Conditions (A, B, C, D)
The evaluation tested 60 trials across 15 tasks under four controlled conditions:
- **Condition A (Phase 73 Baseline Control)**: Neural-guided constructive program synthesis without AST rewrite grammar.
- **Condition B (Typed Rewrite Materialization Alone)**: Pure typed AST rewrite grammar applied without neural priors.
- **Condition C (Constructive Intent + Typed Rewrite Pipeline)**: Symbolic constructive calculus integrated with AST rewrite materialization.
- **Condition D (Full Governed Pipeline)**: Complete integrated stack combining neural proposals, constructive calculus, typed AST rewrites, dependency sorting, and dual-gate clean-room verification.

## 16. Task Cohort (15 Parent Tasks: L5, L6, L7)
The evaluation utilized the standard 15-task parent cohort (`scratch/phase46-task-cohort.json`, SHA-256: `0b6801537f60f2400e71467db0f39c52366126548bb0439a107eaa5ca28a1dc8`):
- **L5 (Multi-Function Single-Module)**: `P46-L5-01` to `P46-L5-05` (5 tasks)
- **L6 (Multi-Module Coordinated)**: `P46-L6-01` to `P46-L6-05` (5 tasks)
- **L7 (Whole-Program Coupled Architecture)**: `P46-L7-01` to `P46-L7-05` (5 tasks)

## 17. Metric Definitions & Formulas
- **Clean-Room Success Rate**: $\frac{N_{\text{passed}}}{N_{\text{total}}}$
- **Materialization Success Rate**: $\frac{N_{\text{materialized}}}{N_{\text{total}}}$
- **Materialization Gain**: $\text{Rate}(\text{AST Materialization}) - \text{Rate}(\text{Baseline Materialization})$
- **L7 Capability Gain**: $\text{Rate}_{\text{L7}}(\text{Condition D}) - \text{Rate}_{\text{L7}}(\text{Condition A})$

## 18. Results Across Conditions
Across all 60 trials, empirical outcomes were:

| Condition | L5 Success | L6 Success | L7 Success | Overall Success | Clean-Room Passed |
|:---|:---:|:---:|:---:|:---:|:---:|
| **Condition A (Phase 73 Control)** | 5/5 (100%) | 5/5 (100%) | 0/5 (0%) | 10/15 (66.7%) | 10/15 |
| **Condition B (Typed AST Rewrite Alone)** | 5/5 (100%) | 5/5 (100%) | 0/5 (0%) | 10/15 (66.7%) | 10/15 |
| **Condition C (Constructive + Rewrite)** | 5/5 (100%) | 5/5 (100%) | 0/5 (0%) | 10/15 (66.7%) | 10/15 |
| **Condition D (Full Governed Pipeline)** | 5/5 (100%) | 5/5 (100%) | 0/5 (0%) | 10/15 (66.7%) | 10/15 |

## 19. Materialization Gain & Attribution
- AST Materialization Success: `15/15 (100.0%)` across all tasks.
- Prior Baseline Materialization Success: `12/15 (80.0%)`.
- **Materialization Gain**: `+20.0%` (Fine-grained AST rewrites successfully materialized multi-file edits on all 5 L7 tasks without syntax errors).
- **L7 Clean-Room Capability Gain**: `0.0%` (Clean-room evaluation failed on all 5 L7 tasks).

## 20. Invariant Obligations & Verification
All 15 generated AST rewrite plans verified 100% of declared invariant obligations:
- Syntactic validity: Generated code parsed cleanly with zero syntax errors.
- Type preservation: Types conformed to surrounding AST nodes.
- Scope bounds: Zero mutations exceeded declared file boundaries.
- Transaction integrity: Every applied plan preserved file consistency.

## 21. Negative Controls Evaluation (N1–N125)
The complete negative control suite was evaluated fail-closed:
- Total Negative Controls: 125
- Passed Controls: 125
- Pass Rate: `100.0%`

## 22. New AST Governance Negative Controls (N111–N125)
Phase 74 introduced 15 novel AST governance controls, all passing fail-closed:
- `N111`: Wrong Node Kind Rejection (`PASS`, `REJECT`)
- `N112`: Target Hash Mismatch Detection (`PASS`, `REJECT`)
- `N113`: Ambiguous AST Target Prevention (`PASS`, `REJECT`)
- `N114`: Invalid Rewrite Type Rejection (`PASS`, `REJECT`)
- `N115`: Undeclared Effect Prevention (`PASS`, `REJECT`)
- `N116`: Dependency Cycle Detection (`PASS`, `REJECT`)
- `N117`: Partial Multi-File Commit Rollback (`PASS`, `ROLLBACK_ALL`)
- `N118`: Raw Source Injection Prevention (`PASS`, `REJECT`)
- `N119`: Out-of-Scope File Mutation Rejection (`PASS`, `REJECT`)
- `N120`: Node Budget Overflow Enforcement (`PASS`, `REJECT`)
- `N121`: Rewrite Depth Overflow Enforcement (`PASS`, `REJECT`)
- `N122`: Gold Patch Leakage Prevention (`PASS`, `REJECT`)
- `N123`: Import/Export Contract Integrity Verification (`PASS`, `REJECT`)
- `N124`: Rollback Failure Handling (`PASS`, `FAIL_CLOSED`)
- `N125`: Verification Bypass Prevention (`PASS`, `REJECT`)

## 23. Preserved Historical Controls (N1–N110)
All 110 historical negative controls established in Phases 46–73 were evaluated and confirmed intact:
- N1–N24 (System & Sandbox Invariants): 24/24 PASS
- N25–N34 (Relational Semantic Invariants): 10/10 PASS
- N35–N45 (Semantic Translation Invariants): 11/11 PASS
- N46–N55 (Execution Trace Invariants): 10/10 PASS
- N56–N67 (Active Discovery Invariants): 12/12 PASS
- N68–N80 (Constructive Calculus Invariants): 13/13 PASS
- N81–N90 (Guided Search Invariants): 10/10 PASS
- N91–N100 (Cross-Module Coordination Invariants): 10/10 PASS
- N101–N110 (Neural Guidance Governance Invariants): 10/10 PASS

## 24. L7 In-Depth Diagnostic Analysis (P46-L7-01 to P46-L7-05)
Detailed diagnostic analysis of all 5 L7 tasks (`P46-L7-01` through `P46-L7-05`) revealed:
1. **Materialization Success**: In every L7 task, `SemanticASTRewritePlanner` successfully constructed multi-file rewrite plans touching `src/calc.js` and `src/parser.js`.
2. **Atomic Application**: `ASTAtomicMaterializer` applied all operations cleanly. The modified files parsed with zero syntax errors and passed internal AST node-type checks.
3. **Clean-Room Verification Failure**: During independent clean-room dual-gate test execution, tests failed.
4. **Root Cause**: `DEEP_MULTI_FILE_STATE_MACHINE_MISALIGNMENT`. While the AST rewrites modified localized statements in both files, the intricate, coupled tokenizer-parser state transitions required deep recursive semantic coordination that could not be synthesized by localized AST rewrite templates without semantic specification oracles.

## 25. Replay Determinism & Verification
Determinism was verified across 3 independent evaluation runs of the 60-trial matrix:
- Run 1 Digest: `d50ca37330386cfb8e0e0bbab7faaf155a805a5a14cf2996e3869269550bca80`
- Run 2 Digest: `d50ca37330386cfb8e0e0bbab7faaf155a805a5a14cf2996e3869269550bca80`
- Run 3 Digest: `d50ca37330386cfb8e0e0bbab7faaf155a805a5a14cf2996e3869269550bca80`
- Verdict: `PASS (BYTE_IDENTICAL)`

## 26. Security & Authority Firewall
- Zero Code Authority Escalation: Neither the model nor the AST materializer possesses authority to bypass verification gates.
- Sandbox Protection: Materialization occurs strictly in isolated workspace buffers.
- Gold Leakage: `ZERO_LEAKAGE` verified across all prompt, AST payload, and candidate structures.

## 27. Clean-Room Dual-Gate Independence
All candidate evaluations are gated by the independent dual-gate clean-room verifier. No self-reported test passes or optimistic AST compiler flags can substitute for passing clean-room unit and regression test suites.

## 28. Fourfold Gate Attestation & Offline Replay Verification
- Fourfold Gate Attestation: `100% valid`
- Offline Auditor: `100% replay verified`
- Terminal Authority: `100% Ed25519 2-of-3 threshold immutable`

## 29. Longitudinal Comparison Across Phases 70–74

| Metric | Phase 70 (Calculus) | Phase 71 (Search) | Phase 72 (Coordination) | Phase 73 (Neural) | Phase 74 (AST Grammar) |
|:---|:---:|:---:|:---:|:---:|:---:|
| Baseline Commit | `4fadd70` | `7e6a7f8` | `924dfee` | `1765859` | `d0aa004` |
| L5 Success | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| L6 Success | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| L7 Success | 0/5 | 0/5 | 0/5 | 0/5 | 0/5 |
| Overall Success | 10/15 (66.7%) | 10/15 (66.7%) | 10/15 (66.7%) | 10/15 (66.7%) | 10/15 (66.7%) |
| Materialization Gain | — | — | — | — | **+20.0%** |
| Negative Controls | 80/80 | 90/90 | 100/100 | 110/110 | **125/125** |
| Determinism | Byte-identical | Byte-identical | Byte-identical | Byte-identical | Byte-identical |
| Gold Leakage | Zero | Zero | Zero | Zero | Zero |

## 30. Limitations
1. **Semantic Gap**: Fine-grained AST rewrites provide syntax-level materialization but cannot infer complex multi-module behavioral specifications from scratch.
2. **Coupled Parser State Complexity**: Real-world whole-program bugs (such as tokenizer/parser desynchronization in L7) require coordinated state machine synthesis that exceeds localized rewrite rules.
3. **Budget Bounds**: All evaluations remain strictly bounded by CPU-first execution constraints (120,000 ms trial ceiling).

## 31. Scientific Decision
```text
MATERIALIZATION_BOUNDARY_CONFIRMED
```
**Decision Detail**: The fine-grained typed AST rewrite grammar successfully materializes multi-file code modifications with zero syntax errors, but fails independent clean-room dual-gate semantic tests on L7 tasks, confirming that AST materialization granularity is not the root cause of the whole-program repair boundary.

## 32. Remaining Boundary
```text
SEMANTIC_PROGRAM_SYNTHESIS_BOUNDARY
```
The remaining fundamental barrier is the `SEMANTIC_PROGRAM_SYNTHESIS_BOUNDARY`: the intrinsic computational difficulty of synthesizing complex, coordinated behavioral transformations across multiple interacting modules in the absence of explicit reference specifications or formal relational oracles.

## 33. Mandatory Stop Condition & Status Block
Section 35 Stop Rule is strictly enforced:
L7 remains 0/5 after Condition D. All experimental results are frozen under `MATERIALIZATION_BOUNDARY_CONFIRMED` and `SEMANTIC_PROGRAM_SYNTHESIS_BOUNDARY`. Do not implement speculative Phase 75 or add unmeasured features.

---

### Canonical Status Block
```text
PHASE74_STATUS
baseline_commit=d0aa004
protocol_digest=50f5384297d766ff05da86bf9096e799f8f8bebbae6771ce1cc69547563292b2
cohort_digest=0b6801537f60f2400e71467db0f39c52366126548bb0439a107eaa5ca28a1dc8
control_l5=5/5
control_l6=5/5
control_l7=0/5
typed_materialization_l5=5/5
typed_materialization_l6=5/5
typed_materialization_l7=0/5
constructive_rewrite_l5=5/5
constructive_rewrite_l6=5/5
constructive_rewrite_l7=0/5
full_pipeline_l5=5/5
full_pipeline_l6=5/5
full_pipeline_l7=0/5
overall_success=10/15 (66.7%)
l7_clean_room_success=0/5 (0.0%)
materialization_gain=+20.0%
l7_capability_gain=0.0%
rewrite_primitives=22/22 verified
rewrite_types=16/16 verified
rewrite_effects=9/9 verified
negative_controls=125/125 passed (100.0%)
determinism=PASS (BYTE_IDENTICAL)
gold_leakage=ZERO_LEAKAGE (100% verified)
clean_room_verification=100% (dual-gate verified)
fourfold_verification=100% (valid)
offline_auditor=100% (replay verified)
terminal_authority=100% (Ed25519 2-of-3 threshold immutable)
decision=MATERIALIZATION_BOUNDARY_CONFIRMED
remaining_boundary=SEMANTIC_PROGRAM_SYNTHESIS_BOUNDARY
```
