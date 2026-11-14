/**
 * ADR-0043 verification operation registry — hardening regression tests.
 *
 * Every component here is real (pure validation function); nothing is mocked and nothing is executed.
 * The bypass cases below passed validation before the hardening and must stay rejected.
 */
import { describe, expect, it } from "vitest";
import { validateVerificationOperation } from "../../src/application/verification-operation-registry.js";

describe("verification operation registry hardening (ADR-0043 / SEC-002)", () => {
  const rejected: readonly (readonly string[])[] = [
    // Inline evaluation through flags that the forbidden-flag list did not cover
    ["node", "--test", "-p", "process.exit(0)"],
    ["node", "--test", "--print", "1"],
    ["node", "--test", "-pe", "1"],
    ["node", "--test", "--experimental-vm-modules"],
    // The executable must be the server-defined bare name, never a workspace-supplied path
    ["./node", "test.js"],
    ["bin/node", "test.js"],
    ["/usr/bin/node", "test.js"],
    ["..\\node", "test.js"],
    // Fused short flags on interpreters and runners
    ["ruby", "-rsocket", "test.rb"],
    ["ruby", "-x"],
    ["rspec", "-r./evil"],
    ["rake", "-e1"],
    // Arbitrary program execution through build-tool options and goals
    ["go", "test", "-exec", "sh"],
    ["go", "test", "-toolexec", "sh"],
    ["go", "test", "-exec=sh"],
    ["mvn", "exec:exec"],
    ["mvn"],
    ["gradle", "publish"],
    ["gradle"],
    // npx may only select the runner; it must not resolve arbitrary packages
    ["npx", "--package", "evil", "vitest"],
    ["npx", "-y", "vitest"],
  ];

  for (const argv of rejected) {
    it(`rejects ${JSON.stringify(argv)}`, () => {
      const result = validateVerificationOperation(argv);
      expect(result.valid).toBe(false);
      expect(result.reason).toBeTruthy();
    });
  }

  const accepted: readonly (readonly [readonly string[], string])[] = [
    [["node", "test.js"], "node_test"],
    [["node", "tests/solver.test.mjs"], "node_test"],
    [["node", "--test"], "node_test"],
    [["node", "--test", "tests/a.test.js", "tests/b.test.js"], "node_test"],
    [["python3", "-m", "pytest", "tests"], "python_test"],
    [["python", "test_solver.py"], "python_test"],
    [["npm", "test"], "npm_test"],
    [["npm", "run", "test"], "npm_test"],
    [["npx", "vitest"], "vitest_run"],
    [["npx", "vitest", "run"], "vitest_run"],
    [["npx", "jest"], "jest_run"],
    [["pytest", "-q"], "pytest_run"],
    [["cargo", "test"], "cargo_test"],
    [["go", "test", "./..."], "go_test"],
    [["go", "test", "-race", "-count", "1"], "go_test"],
    [["ruby", "test.rb"], "ruby_test"],
    [["rake", "test"], "ruby_test"],
    [["rspec"], "ruby_test"],
    [["mvn", "test"], "mvn_test"],
    [["gradle", "test"], "gradle_test"],
    [["dotnet", "test"], "dotnet_test"],
  ];

  for (const [argv, operationId] of accepted) {
    it(`accepts ${JSON.stringify(argv)} as ${operationId}`, () => {
      const result = validateVerificationOperation(argv);
      expect(result.reason).toBeUndefined();
      expect(result.valid).toBe(true);
      expect(result.operationId).toBe(operationId);
    });
  }
});
