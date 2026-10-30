# Integration Brief: Aider — Coding-Agent Task Loop, Repo-Map, and Test-Feedback

**Document ID**: `EAF-OSS-002`  
**Date of Inspection**: 2026-10-16  
**Status**: APPROVED FOR DESIGN (Implementation strictly deferred to Phase 13)  
**Role**: Senior AI Infrastructure Engineer & Technical Co-Founder  
**Upstream System**: [Aider](https://github.com/Aider-AI/aider)  
**Inspected Commit SHA**: [`5dc9490bb35f9729ef2c95d00a19ccd30c26339c`](https://github.com/Aider-AI/aider/commit/5dc9490bb35f9729ef2c95d00a19ccd30c26339c)  

---

## 1. Executive Summary

Aider is widely regarded as the most effective open-source code-editing assistant. Its exceptional benchmark performance stems from three architectural pillars:
1. **Repo-Map**: A graph-theoretic symbol map (tree-sitter AST extraction + PageRank via NetworkX) that fits the high-level semantic topology of large repositories into a compact 1,024-token budget.
2. **Defensive Editing Formats**: Constrained edit representations (e.g. search/replace blocks or whole-file overwrites) with pre-commit validation.
3. **Automated Test-Driven Reflection**: An automated test execution loop (`auto_test`) that catches syntax and test failures immediately after an edit and feeds the error trace back into the model context for up to 3 bounded reflections.

For Emerald Agent Fabric, Aider provides the blueprint for **Phase 13 (Coding-Agent Task Loop)**. Emerald already possesses the six fundamental tools required for this loop: `read_file`, `search_code`, `git_status`, `git_diff`, `write_file`, and `run_command`. By adopting Aider's test-feedback reflection mechanics and adapting its repo-map concept into Emerald's `ContextEngine`, Emerald can execute complete, verified software maintenance cycles under strict capability and lease governance.

---

## 2. Research Question

> How does Aider achieve reliable code modifications and self-correcting test loops across unfamiliar codebases, and how can those context-selection, editing, and test-feedback patterns be mapped onto Emerald's six frozen tools and Context Engine without adding unvetted third-party dependencies or bypassing transaction boundaries?

---

## 3. Upstream Inspected Source Files

The following files from [`Aider-AI/aider`](https://github.com/Aider-AI/aider) at commit `5dc9490bb35f9729ef2c95d00a19ccd30c26339c` were inspected:

1. **[`aider/repomap.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/repomap.py)**:
   - Lines 70–165: Tree-sitter query configuration for extracting definitions and references (tags) across Python, JavaScript, TypeScript, Go, Rust, and C++.
   - Lines 250–380: Directed multigraph construction (`NetworkX.MultiDiGraph`); edges represent symbol reference $\rightarrow$ definition relationships.
   - Lines 381–460: Personalized PageRank computation (`nx.pagerank`), weighting nodes higher if their source files are already present in the active conversation context.
   - Lines 520–610: `to_tree` formatting algorithm converting ranked tags into an indented tree representation bounded by `map_tokens` (default 1024 tokens).

2. **[`aider/coders/base_coder.py`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/coders/base_coder.py)**:
   - Lines 650–740: `run_one` core execution loop and reflection dispatch.
   - Lines 850–930: `apply_updates` applying model-generated edits to workspace files on disk.
   - Lines 980–1080: `auto_test` and `cmd_test` running lint/test commands immediately following file updates; capturing output and returning `reflected_message`.
   - Lines 1081–1140: `max_reflections = 3` counter protecting against infinite repair loops.

3. **[`aider/website/docs/repomap.md`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/website/docs/repomap.md)** and **[`aider/website/docs/more/edit-formats.md`](https://github.com/Aider-AI/aider/blob/5dc9490bb35f9729ef2c95d00a19ccd30c26339c/aider/website/docs/more/edit-formats.md)**:
   - Empirical findings on edit format reliability across model sizes: 3B–8B models fail search/replace diff formats and perform significantly better with whole-file rewrites or structured line replacement.

---

## 4. Verified Upstream Findings

### 4.1 Personalized PageRank Repo-Map
Aider solves the context-selection problem without sending entire files to the LLM. 
- It extracts symbol identifiers (e.g., class names, function signatures) using tree-sitter.
- It builds a graph where nodes are source files and edges are symbol references.
- It calculates personalized PageRank: files that the user or agent has already mentioned receive higher initial probability weights.
- It renders an abbreviated syntax outline of the most salient files until the token budget is reached.
- This gives the model "map awareness" of related files without exhausting context.

### 4.2 Reflection Loop with Bounded Counter
In `aider/coders/base_coder.py`:
- When a file update is applied, Aider executes `auto_test`.
- If the test command returns exit code 0, reflection terminates successfully.
- If the test command fails, the exit code, stderr, and relevant stdout lines are bundled into a `reflected_message` (e.g. `"Tests failed: AssertionError: expected 4 to equal 5 at line 22"`).
- The model is re-invoked with this reflection prompt.
- The loop is bounded by `max_reflections = 3`. If tests still fail after 3 attempts, Aider halts and reports failure rather than burning unlimited tokens.

### 4.3 Model Size vs Edit Format Reality
Aider's documentation and benchmarks show that small models (3B to 8B parameters, including `llama3.2:3b`) struggle to generate correct search/replace blocks because they hallucinate surrounding context lines. For small local models, whole-file generation or explicit file write tools achieve vastly higher reliability than diff patches.

---

## 5. Emerald Integration Design

### 5.1 Mapping to Emerald's Six Frozen Tools

Emerald has already specified and frozen the exact six tools needed for the coding-agent loop:

| Tool Name | Emerald Domain Schema | Purpose in Coding Loop |
|---|---|---|
| `search_code` | `{ query: string }` | Symbol and string lookup across repository files. |
| `read_file` | `{ path: string, startLine?: number, endLine?: number }` | Inspecting targeted code sections discovered via search. |
| `write_file` | `{ path: string, content: string }` | Applying bounded file modifications. |
| `git_status` | `{}` | Verifying modified files and uncommitted workspace state. |
| `git_diff` | `{ path?: string, cached?: boolean }` | Inspecting exact unified diff of applied changes. |
| `run_command` | `{ argv: string[], cwd?: string }` | Running compilation, linting, and automated tests. |

All six tools execute through `ToolExecutionGateway` inside the isolated workspace (or Docker sandbox), recording durable `Action` and `Attempt` entities in SQLite.

### 5.2 A. Adopt (What Emerald Adopts)
1. **Test-Driven Reflection Cycle**: After an edit is applied via `write_file`, the agent loop in Phase 13 must automatically propose or trigger verification via `run_command` (or `git_diff`).
2. **Failure Trace Feedback**: When `run_command` returns exit code $\ne 0$, its captured `stderr` and trailing stdout must be projected into the next step's observation block with high context priority.
3. **Bounded Reflection Budget**: Limit consecutive test-repair iterations to $K=3$ within a task. If the tests do not pass after 3 edits, the agent must declare recovery failure or halt.
4. **Pre-Edit Inspection Requirement**: Require the agent to observe code via `read_file` before permitting `write_file` on that path (enforced via Reflex confidence or policy guard).

### 5.3 B. Adapt (Mapping to Emerald ContextEngine)

Instead of vendoring Aider's Python tree-sitter and NetworkX stack into Emerald's Node.js/TypeScript backend, we adapt the pattern through Emerald's `ContextEngine` and `ContextSourcePort`:

```
┌────────────────────────────────────────────────────────┐
│                      ContextEngine                     │
├────────────────────────────────────────────────────────┤
│ Context Sources:                                       │
│ 1. Mission Specification (Goal & Requirements)        │
│ 2. Repository Outline (Dynamic file / symbol map)      │
│ 3. Working Tree Diff (from git_diff observation)       │
│ 4. Test Execution Output (from run_command observation)│
│ 5. Recent Step Trajectory (Last 3 Steps)               │
└──────────────────────────┬─────────────────────────────┘
                           │ Prompts
                           ▼
┌────────────────────────────────────────────────────────┐
│                   AgentBrain (Ollama)                  │
└──────────────────────────┬─────────────────────────────┘
                           │ Proposes Action
                           ▼
┌────────────────────────────────────────────────────────┐
│               Governed Execution Gateway               │
│  write_file → git_diff → run_command (test suite)      │
└────────────────────────────────────────────────────────┘
```

1. **Lightweight TypeScript Repo-Map Adapter**:
   - In Emerald v1, `ContextEngine` can generate a deterministic repository outline using `git ls-files` and exported TypeScript AST signatures (via TypeScript compiler API, which is already in Emerald's dependencies), avoiding external native C libraries.
   - Outlines are cached per commit hash.
2. **Coding Task State Machine**:
   - Phase 13 executes the sequence: `OBSERVE (search_code, read_file) → EDIT (write_file) → INSPECT (git_diff) → TEST (run_command) → EVALUATE (Reflection)`.
   - If tests pass $\rightarrow$ model proposes `isGoalReached: true`.
   - If tests fail $\rightarrow$ observation carries test error trace $\rightarrow$ model proposes targeted fix.

### 5.4 C. Skip (What Emerald Explicitly Rejects)
1. **Diff-Patch String Editing for Small Models**: As validated in Aider's research, 3B models cannot reliably output unified diff hunks. Emerald relies on `write_file` with complete, verified file content.
2. **Automatic Unverified Git Commits**: Aider commits every intermediate edit directly to git history. Emerald preserves intermediate edits in workspace working trees under lease fencing, committing or packaging only upon verified task completion.
3. **Interactive User Prompts Mid-Loop**: Aider stops to ask the user questions in the terminal. Emerald runs autonomously against a non-interactive mission contract; unexpected conditions trigger `Reflex` escalation or explicit `WAITING_APPROVAL` states.

---

## 6. Conformance Test Specifications

For Phase 13 certification, the following deterministic tests must pass:

1. **Test 13.1: Read-Edit-Diff Cycle**:
   - Target: A sample workspace containing `src/math.ts` with a syntax error (`return a - b;` instead of `return a + b;`).
   - Step 1: Model calls `search_code({ query: "return a -" })` $\rightarrow$ receives `src/math.ts:3`.
   - Step 2: Model calls `read_file({ path: "src/math.ts" })` $\rightarrow$ receives file contents.
   - Step 3: Model calls `write_file({ path: "src/math.ts", content: "..." })` with corrected code.
   - Step 4: Model calls `git_diff({ path: "src/math.ts" })`.
   - Assert: `git_diff` observation contains `+  return a + b;` and `-  return a - b;`.

2. **Test 13.2: Automated Test-Failure Reflection**:
   - Initial edit introduces a failing test assertion.
   - Model runs `run_command({ argv: ["npm", "test"] })`.
   - Gateway returns exit code 1 with stdout: `"AssertionError: expected 5 to be 10"`.
   - Assert: Next step prompt contains the literal assertion failure.
   - Model applies secondary edit.
   - Model re-executes `run_command({ argv: ["npm", "test"] })`.
   - Gateway returns exit code 0.
   - Model terminates with `isGoalReached: true`.

3. **Test 13.3: Bounded Reflection Ceiling**:
   - Simulated test suite that never passes (broken environment or impossible requirement).
   - Agent attempts repair 3 times.
   - Assert: On the 4th iteration, `AgentStepController` halts the loop with `MAX_REFLECTIONS_EXCEEDED` or step budget exhaustion.
   - Assert: Run transitions to `FAILED` with full evidence persisted.

---

## 7. Productization Lessons from Aider

1. **Git Diff as Primary Verification**: Developers understand git diffs better than any other explanation format. Presenting `git_diff` output immediately after an edit gives operators instant verification of agent behavior.
2. **Compact Outlines Outperform Giant Contexts**: Flooding a model with entire files degrades reasoning. Extracting high-signal symbol outlines keeps small models focused and avoids quadratic latency penalties on CPU inference.
3. **Failure Output is Context, Not Crash**: A failing test command is normal during software engineering. It should never be treated as an agent runtime failure; it is high-value feedback that guides the subsequent edit.

---

## 8. Dependencies & Sequencing

- **Pre-requisite**: **Phase 11 (Real Tool Execution)** and **Phase 12 (Multi-Step Agent Loop)**.
- **Direct Target**: **Phase 13 (Coding-Agent Task Loop)**.
- **Downstream Consumer**: **Phase 14 (Independent Verification)**.

---

## 9. Open Questions & Technical Uncertainties

1. **Token Cost of Whole-File Rewrites**: For files $> 500$ lines, rewriting the entire file via `write_file` consumes significant tokens and model output time on CPU. Should Emerald implement a typed `replace_lines` tool in Phase 13?
   - Recommendation: Start Phase 13 with `write_file` on small, modular files ($\le 150$ lines) typical of well-architected SWE tasks, evaluating `replace_lines` only if token pressure warrants it.
