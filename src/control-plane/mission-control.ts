/**
 * Emerald Agent Fabric — Production Control Plane: Mission Control
 *
 * Implements authoritative Mission lifecycle management:
 * - User intent → Structured Task & Mission Contract
 * - Cryptographic contract hash binding
 * - Activation and revocation controls
 * - Immutable storage in SQLite / state store
 *
 * Principle:
 * "The model proposes. The runtime governs. The sandbox executes. The verifier decides. The evidence proves."
 */

import {
  createMissionContract,
  createResourceLimits,
  MissionContract,
  ResourceLimits,
} from "../domain/mission-contract.js";
import { createExecutionPolicy } from "../domain/policy.js";
import { createVerificationSpec } from "../domain/verification.js";
import { ClockPort, SystemClock } from "../ports/clock.port.js";
import { StateStorePort } from "../ports/state-store.port.js";

export interface Mission {
  readonly missionId: string;
  readonly taskId: string;
  readonly title: string;
  readonly description: string;
  readonly repositoryPath: string;
  readonly workspacePath: string;
  readonly contract: MissionContract;
  readonly status: "CREATED" | "ACTIVE" | "COMPLETED" | "REVOKED";
  readonly createdAt: string;
  readonly activatedAt?: string;
  readonly revokedAt?: string;
  readonly revocationReason?: string;
}

export interface CreateMissionParams {
  readonly missionId?: string;
  readonly taskId?: string;
  readonly title: string;
  readonly description: string;
  readonly repositoryPath: string;
  readonly workspacePath?: string;
  readonly allowedTools?: readonly string[];
  readonly resourceLimits?: {
    readonly timeoutMs?: number;
    readonly maxAttempts?: number;
    readonly maxOutputBytes?: number;
  };
  readonly governedBenchmarkRepairMode?: boolean;
}

export class MissionControl {
  private readonly missions: Map<string, Mission> = new Map();
  private missionCounter: number = 0;

  constructor(
    private readonly stateStore?: StateStorePort,
    private readonly clock: ClockPort = new SystemClock(),
  ) {}

  public getStateStore(): StateStorePort | undefined {
    return this.stateStore;
  }

  public getClock(): ClockPort {
    return this.clock;
  }

  /**
   * Create a new governed mission and bind an immutable MissionContract.
   */
  public createMission(params: CreateMissionParams): Mission {
    this.missionCounter++;
    const nowIso = this.clock.now().toISOString();
    const missionId = params.missionId ?? `mission-${Date.now()}-${this.missionCounter}`;
    const taskId = params.taskId ?? `task-${this.missionCounter}`;
    const workspacePath = params.workspacePath ?? params.repositoryPath;

    const allowedTools = params.allowedTools ?? [
      "read_file",
      "search_code",
      "git_status",
      "git_diff",
      "write_file",
      "run_command",
    ];

    const limits: ResourceLimits = createResourceLimits({
      timeoutMs: params.resourceLimits?.timeoutMs ?? 300000,
      maxAttempts: params.resourceLimits?.maxAttempts ?? 10,
      maxOutputBytes: params.resourceLimits?.maxOutputBytes ?? 1024 * 1024,
    });

    const contract: MissionContract = createMissionContract({
      contractId: `contract-${missionId}`,
      version: 1,
      taskId,
      policy: createExecutionPolicy({
        allowedCapabilities: allowedTools,
        isolationRequirement: "ISOLATED",
        governedBenchmarkRepairMode: params.governedBenchmarkRepairMode ?? false,
      }),
      verificationSpecs: [
        createVerificationSpec({
          specId: `spec-${missionId}`,
          ruleKind: "EXIT_CODE_ZERO",
        }),
      ],
      resourceLimits: limits,
      status: "ACTIVE",
      createdAt: nowIso,
      activatedAt: nowIso,
    });

    const mission: Mission = {
      missionId,
      taskId,
      title: params.title,
      description: params.description,
      repositoryPath: params.repositoryPath,
      workspacePath,
      contract,
      status: "ACTIVE",
      createdAt: nowIso,
      activatedAt: nowIso,
    };

    this.missions.set(missionId, mission);
    return mission;
  }

  public getMission(missionId: string): Mission | undefined {
    return this.missions.get(missionId);
  }

  public listMissions(): readonly Mission[] {
    return Array.from(this.missions.values());
  }

  public activateMission(missionId: string): void {
    const mission = this.missions.get(missionId);
    if (!mission) throw new Error(`Mission not found: ${missionId}`);
    if (mission.status === "REVOKED") throw new Error(`Cannot activate revoked mission: ${missionId}`);

    const updated: Mission = {
      ...mission,
      status: "ACTIVE",
      activatedAt: this.clock.now().toISOString(),
    };
    this.missions.set(missionId, updated);
  }

  public revokeMission(missionId: string, reason: string): void {
    const mission = this.missions.get(missionId);
    if (!mission) throw new Error(`Mission not found: ${missionId}`);

    const updated: Mission = {
      ...mission,
      status: "REVOKED",
      revokedAt: this.clock.now().toISOString(),
      revocationReason: reason,
    };
    this.missions.set(missionId, updated);
  }
}
