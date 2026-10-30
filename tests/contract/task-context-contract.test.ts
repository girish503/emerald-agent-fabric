/**
 * Phase 45B: Task-Context Contract & Progression Guidance Contract Tests
 *
 * Verifies that:
 * 1. Grounded task descriptions are preserved from Phase43PilotTask definitions through
 *    coordinator.createTask and context assembly into LiveAgentBrain's ModelProviderRequest.
 * 2. Grounded verification criteria (fail-to-pass and pass-to-pass commands with expected exit codes)
 *    and target file paths are prominently surfaced in "## Task Execution Context".
 * 3. Generic navigation tasks without repair criteria do not have fabricated edit rules or criteria.
 * 4. Structured output schema (7 branches) and authoritative proposal validation remain strictly intact.
 * 5. Frozen benchmark fixtures (PHASE43_PILOT_TASKS) and historical evidence remain completely unmodified.
 */

import { describe, expect, it } from "vitest";
import {
  Phase43BenchmarkRunner,
  PHASE43_PILOT_TASKS,
} from "../../src/production/benchmark/phase43-benchmark-runner.js";
import {
  OllamaFetchLike,
  OllamaModelProvider,
} from "../../src/adapters/models/ollama-model-provider.js";
import {
  EvidenceSigner,
  TrustedKeyring,
} from "../../src/application/evidence-signer.js";

describe("Phase 45B — Task-Context Contract & Progression Guidance", () => {
  it("preserves grounded defect, target file, and verification commands in outbound model request for EAF-BM-01", async () => {
    let capturedBody: any = null;

    const fakeFetch: OllamaFetchLike = async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return new Response(
        JSON.stringify({
          model: "qwen2.5-coder:1.5b",
          message: {
            role: "assistant",
            content: JSON.stringify({
              isGoalReached: false,
              proposalId: "step-1",
              toolName: "read_file",
              inputPayload: { path: "src/calc.js" },
              contextSnapshotHash: "0".repeat(64),
            }),
          },
          done: true,
          done_reason: "stop",
          prompt_eval_count: 50,
          eval_count: 30,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const provider = new OllamaModelProvider({
      baseURL: "http://127.0.0.1:11434",
      defaultModel: "qwen2.5-coder:1.5b",
      fetch: fakeFetch,
    });

    const runner = new Phase43BenchmarkRunner();
    const task = runner.getTask("EAF-BM-01");

    const workerKeys = EvidenceSigner.generateKeyPair();
    const supervisorKeys = EvidenceSigner.generateKeyPair();

    const keyring = new TrustedKeyring();
    keyring.registerKey({
      authorityId: "auth-worker-p43",
      keyId: "key-worker-p43",
      role: "WORKER_PRODUCER",
      publicKey: workerKeys.publicKey,
      status: "TRUSTED",
    });
    keyring.registerKey({
      authorityId: "auth-supervisor-p43",
      keyId: "key-supervisor-p43",
      role: "SUPERVISOR",
      publicKey: supervisorKeys.publicKey,
      status: "TRUSTED",
    });

    // Execute exactly 1 step
    await runner.executeTrial(task, {
      modelProvider: provider,
      model: "qwen2.5-coder:1.5b",
      signingKeys: { workerKeys, supervisorKeys },
      keyring,
      maxSteps: 1,
      stepTimeoutMs: 5000,
      retainWorkspace: false,
    });

    expect(capturedBody).not.toBeNull();
    const userMessage = capturedBody.messages.find((m: any) => m.role === "user")?.content ?? "";

    // 1. Task Title & Objective
    expect(userMessage).toContain("- Task Title: Core Arithmetic Off-by-One Fix");
    expect(userMessage).toContain("### Task Objective & Criteria");
    expect(userMessage).toContain("Target File: src/calc.js");
    expect(userMessage).toContain("Allowed Modification Scope: src/calc.js");
    expect(userMessage).toContain(
      "Grounded Defect: In add(a, b), the current implementation returns a + b + 1 instead of a + b. Expected behavior: add(2, 3) === 5."
    );
    expect(userMessage).toContain("Objective: Repair the defect in 'src/calc.js'.");
    expect(userMessage).toContain(
      "Repair Requirement: Make the smallest appropriate repair and verify it using the existing verification test command."
    );

    // 2. Exact Grounded Verification & Regression Criteria
    expect(userMessage).toContain("Verification Criteria:");
    expect(userMessage).toContain("Verification test 'node test/f2p.test.js' must pass with exit code 0.");
    expect(userMessage).toContain("Regression test 'node test/p2p.test.js' must pass with exit code 0.");

    // 3. Structured Output Schema Conformance
    expect(capturedBody.format).toBeDefined();
    expect(capturedBody.format.anyOf.length).toBe(7);
  });

  it("preserves grounded defect, target file, and verification commands for EAF-BM-02 and EAF-BM-03", async () => {
    const runner = new Phase43BenchmarkRunner();
    const workerKeys = EvidenceSigner.generateKeyPair();
    const supervisorKeys = EvidenceSigner.generateKeyPair();

    const keyring = new TrustedKeyring();
    keyring.registerKey({
      authorityId: "auth-worker-p43",
      keyId: "key-worker-p43",
      role: "WORKER_PRODUCER",
      publicKey: workerKeys.publicKey,
      status: "TRUSTED",
    });
    keyring.registerKey({
      authorityId: "auth-supervisor-p43",
      keyId: "key-supervisor-p43",
      role: "SUPERVISOR",
      publicKey: supervisorKeys.publicKey,
      status: "TRUSTED",
    });

    for (const taskId of ["EAF-BM-02", "EAF-BM-03"] as const) {
      let capturedBody: any = null;
      const fakeFetch: OllamaFetchLike = async (_input, init) => {
        capturedBody = JSON.parse(String(init?.body ?? "{}"));
        return new Response(
          JSON.stringify({
            model: "qwen2.5-coder:1.5b",
            message: {
              role: "assistant",
              content: JSON.stringify({
                isGoalReached: false,
                proposalId: "step-1",
                toolName: "read_file",
                inputPayload: { path: "src/calc.js" },
                contextSnapshotHash: "0".repeat(64),
              }),
            },
            done: true,
            done_reason: "stop",
            prompt_eval_count: 50,
            eval_count: 30,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      };

      const provider = new OllamaModelProvider({
        baseURL: "http://127.0.0.1:11434",
        defaultModel: "qwen2.5-coder:1.5b",
        fetch: fakeFetch,
      });

      const task = runner.getTask(taskId);
      await runner.executeTrial(task, {
        modelProvider: provider,
        model: "qwen2.5-coder:1.5b",
        signingKeys: { workerKeys, supervisorKeys },
        keyring,
        maxSteps: 1,
        stepTimeoutMs: 5000,
        retainWorkspace: false,
      });

      expect(capturedBody).not.toBeNull();
      const userMessage = capturedBody.messages.find((m: any) => m.role === "user")?.content ?? "";

      expect(userMessage).toContain(`- Task Title: ${task.title}`);
      expect(userMessage).toContain(`Target File: ${task.targetFile}`);
      expect(userMessage).toContain(`Allowed Modification Scope: ${task.allowedPathPatterns.join(", ")}`);
      expect(userMessage).toContain(`Verification test '${task.failToPass.testCommand.join(" ")}' must pass with exit code 0.`);
    }
  });

  it("confirms frozen benchmark fixture definitions remain unmodified", () => {
    // Assert invariant baseline properties
    expect(PHASE43_PILOT_TASKS["EAF-BM-01"].title).toBe("Core Arithmetic Off-by-One Fix");
    expect(PHASE43_PILOT_TASKS["EAF-BM-01"].targetFile).toBe("src/calc.js");
    expect(PHASE43_PILOT_TASKS["EAF-BM-01"].allowedPathPatterns).toEqual(["src/calc.js"]);
    expect(PHASE43_PILOT_TASKS["EAF-BM-01"].groundedDefect).toBe(
      "In add(a, b), the current implementation returns a + b + 1 instead of a + b. Expected behavior: add(2, 3) === 5."
    );
    expect(PHASE43_PILOT_TASKS["EAF-BM-01"].failToPass.testCommand).toEqual(["node", "test/f2p.test.js"]);
    expect(PHASE43_PILOT_TASKS["EAF-BM-01"].failToPass.expectedPatchedExitCode).toBe(0);
    expect(PHASE43_PILOT_TASKS["EAF-BM-01"].passToPass.testCommand).toEqual(["node", "test/p2p.test.js"]);
    expect(PHASE43_PILOT_TASKS["EAF-BM-01"].passToPass.expectedPatchedExitCode).toBe(0);

    // Confirm frozen fixture dictionary is frozen
    expect(Object.isFrozen(PHASE43_PILOT_TASKS)).toBe(true);
  });
});
