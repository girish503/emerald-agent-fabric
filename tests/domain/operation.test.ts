import { describe, expect, it } from "vitest";
import {
  EchoOperation,
  OperationContext,
  SumOperation,
} from "../../src/domain/operation.js";

describe("Deterministic Operation Contract", () => {
  const context: OperationContext = {
    runId: "run-op-1",
    taskId: "task-op-1",
    idempotencyToken: "token-1234",
    timestamp: "2026-10-10T12:00:00.000Z",
  };

  it("executes EchoOperation deterministically", async () => {
    const op = new EchoOperation();
    expect(op.name).toBe("echo");

    const input = { message: "pure domain computation", numbers: [1, 2, 3] };
    const result1 = await op.execute(input, context);
    const result2 = await op.execute(input, context);

    expect(result1.output).toEqual(input);
    expect(result2.output).toEqual(input);
    expect(result1).toEqual(result2);
  });

  it("executes SumOperation deterministically", async () => {
    const op = new SumOperation();
    expect(op.name).toBe("sum");

    const numbers = [10, 20, 30, 40];
    const result = await op.execute(numbers, context);

    expect(result.output).toBe(100);
  });
});
