/**
 * Phase 92: Cooperative Memory & Working-Tree Security Policy
 *
 * Implements the 30 negative security controls N481–N510 and authority invariants M1–M18.
 *
 * ALL CONTROLS FAIL CLOSED.
 */

import {
  MemoryRecord,
  computeMemoryContentDigest,
} from "../domain/cooperative-memory.js";
import {
  MutationProposal,
  WorkingTreeReconciliationResult,
} from "../domain/working-tree-state.js";
import { isSensitiveKey } from "../domain/canonical-hash.js";

export interface PolicyCheckResult {
  readonly controlId: string;
  readonly passed: boolean;
  readonly reason: string;
}

export class CooperativeMemoryPolicy {
  // N481: agent self-authorized memory
  public static checkN481AgentSelfAuthorized(record: unknown): PolicyCheckResult {
    const rec = record as Record<string, unknown>;
    const violates = rec.authoritative === true;
    return {
      controlId: "N481",
      passed: !violates,
      reason: violates
        ? "Fail-closed: agent self-authorized memory is strictly prohibited"
        : "Compliant: record has authoritative = false",
    };
  }

  // N482: authority-bearing memory injection
  public static checkN482AuthorityBearingInjection(record: unknown): PolicyCheckResult {
    const rec = record as Record<string, unknown>;
    const violates =
      rec.policyAuthority === true ||
      rec.authorityClassification === "AUTHORIZED_MEMORY";
    return {
      controlId: "N482",
      passed: !violates,
      reason: violates
        ? "Fail-closed: authority-bearing memory injection blocked"
        : "Compliant: no authority-bearing fields present",
    };
  }

  // N483: credential injection through memory
  public static checkN483CredentialInjection(content: unknown): PolicyCheckResult {
    let hasCredential = false;
    const inspect = (val: unknown) => {
      if (val && typeof val === "object") {
        for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
          if (isSensitiveKey(k)) {
            hasCredential = true;
          }
          inspect(v);
        }
      }
    };
    inspect(content);

    return {
      controlId: "N483",
      passed: !hasCredential,
      reason: hasCredential
        ? "Fail-closed: credential detected in memory content"
        : "Compliant: memory content free of unredacted credentials",
    };
  }

  // N484: terminal authority injection through memory
  public static checkN484TerminalAuthorityInjection(record: unknown): PolicyCheckResult {
    const rec = record as Record<string, unknown>;
    const violates = rec.terminalAuthority === true;
    return {
      controlId: "N484",
      passed: !violates,
      reason: violates
        ? "Fail-closed: terminal authority injection through memory rejected"
        : "Compliant: terminalAuthority = false",
    };
  }

  // N485: verification authority injection through memory
  public static checkN485VerificationAuthorityInjection(record: unknown): PolicyCheckResult {
    const rec = record as Record<string, unknown>;
    const violates = rec.verificationAuthority === true;
    return {
      controlId: "N485",
      passed: !violates,
      reason: violates
        ? "Fail-closed: verification authority injection through memory rejected"
        : "Compliant: verificationAuthority = false",
    };
  }

  // N486: policy authority injection through memory
  public static checkN486PolicyAuthorityInjection(record: unknown): PolicyCheckResult {
    const rec = record as Record<string, unknown>;
    const violates = rec.policyAuthority === true;
    return {
      controlId: "N486",
      passed: !violates,
      reason: violates
        ? "Fail-closed: policy authority injection through memory rejected"
        : "Compliant: policyAuthority = false",
    };
  }

  // N487: memory scope expansion
  public static checkN487MemoryScopeExpansion(
    recordGoalId: string,
    requestGoalId: string,
    allowCrossGoal: boolean
  ): PolicyCheckResult {
    const violates = !allowCrossGoal && recordGoalId !== requestGoalId;
    return {
      controlId: "N487",
      passed: !violates,
      reason: violates
        ? "Fail-closed: memory access exceeds requesting goal scope"
        : "Compliant: memory access within goal boundary",
    };
  }

  // N488: repository scope expansion
  public static checkN488RepositoryScopeExpansion(
    recordRepoId: string,
    declaredRepos: readonly string[]
  ): PolicyCheckResult {
    const violates = !declaredRepos.includes(recordRepoId);
    return {
      controlId: "N488",
      passed: !violates,
      reason: violates
        ? `Fail-closed: repository ${recordRepoId} outside declared repos`
        : "Compliant: repository within scope",
    };
  }

  // N489: workspace scope expansion
  public static checkN489WorkspaceScopeExpansion(
    recordWorkspaceId: string,
    declaredWorkspaces: readonly string[]
  ): PolicyCheckResult {
    const violates = !declaredWorkspaces.includes(recordWorkspaceId);
    return {
      controlId: "N489",
      passed: !violates,
      reason: violates
        ? `Fail-closed: workspace ${recordWorkspaceId} outside declared workspaces`
        : "Compliant: workspace within scope",
    };
  }

  // N490: stale memory execution
  public static checkN490StaleMemoryExecution(record: MemoryRecord): PolicyCheckResult {
    const violates = record.freshness === "STALE";
    return {
      controlId: "N490",
      passed: !violates,
      reason: violates
        ? "Fail-closed: execution based on STALE memory is rejected"
        : "Compliant: memory is not stale",
    };
  }

  // N491: expired memory execution
  public static checkN491ExpiredMemoryExecution(record: MemoryRecord): PolicyCheckResult {
    const violates = record.freshness === "EXPIRED" || record.status === "EXPIRED";
    return {
      controlId: "N491",
      passed: !violates,
      reason: violates
        ? "Fail-closed: execution based on EXPIRED memory is rejected"
        : "Compliant: memory is not expired",
    };
  }

  // N492: revoked memory execution
  public static checkN492RevokedMemoryExecution(record: MemoryRecord): PolicyCheckResult {
    const violates = record.freshness === "REVOKED" || record.status === "REVOKED";
    return {
      controlId: "N492",
      passed: !violates,
      reason: violates
        ? "Fail-closed: execution based on REVOKED memory is rejected"
        : "Compliant: memory is not revoked",
    };
  }

  // N493: memory version rollback
  public static checkN493MemoryVersionRollback(
    currentVersion: number,
    newVersion: number
  ): PolicyCheckResult {
    const violates = newVersion <= currentVersion;
    return {
      controlId: "N493",
      passed: !violates,
      reason: violates
        ? `Fail-closed: version rollback attempt (new ${newVersion} <= current ${currentVersion})`
        : "Compliant: monotonic version increment",
    };
  }

  // N494: memory digest substitution
  public static checkN494MemoryDigestSubstitution(record: MemoryRecord): PolicyCheckResult {
    const computed = computeMemoryContentDigest(record.content);
    const violates = computed !== record.contentDigest;
    return {
      controlId: "N494",
      passed: !violates,
      reason: violates
        ? `Fail-closed: content digest substitution mismatch (${computed} !== ${record.contentDigest})`
        : "Compliant: content digest matches payload",
    };
  }

  // N495: provenance removal
  public static checkN495ProvenanceRemoval(record: MemoryRecord): PolicyCheckResult {
    const violates = !record.provenanceRoot || record.provenanceRoot.trim() === "";
    return {
      controlId: "N495",
      passed: !violates,
      reason: violates
        ? "Fail-closed: memory record missing provenance root"
        : "Compliant: provenance root present",
    };
  }

  // N496: cross-agent memory contamination
  public static checkN496CrossAgentContamination(
    sourceAgentId: string,
    targetAgentId: string,
    declaredAgents: readonly string[]
  ): PolicyCheckResult {
    const violates =
      !declaredAgents.includes(sourceAgentId) || !declaredAgents.includes(targetAgentId);
    return {
      controlId: "N496",
      passed: !violates,
      reason: violates
        ? "Fail-closed: cross-agent contamination outside declared workflow"
        : "Compliant: agents are declared collaborators",
    };
  }

  // N497: cross-goal memory contamination
  public static checkN497CrossGoalContamination(
    sourceGoalId: string,
    targetGoalId: string,
    allowSharing: boolean
  ): PolicyCheckResult {
    const violates = !allowSharing && sourceGoalId !== targetGoalId;
    return {
      controlId: "N497",
      passed: !violates,
      reason: violates
        ? "Fail-closed: cross-goal contamination without explicit permission"
        : "Compliant: cross-goal boundaries respected",
    };
  }

  // N498: cross-repository memory contamination
  public static checkN498CrossRepositoryContamination(
    sourceRepo: string,
    targetRepo: string,
    declaredEdges: ReadonlyArray<{ readonly from: string; readonly to: string }>
  ): PolicyCheckResult {
    if (sourceRepo === targetRepo) {
      return { controlId: "N498", passed: true, reason: "Same repository" };
    }
    const hasEdge = declaredEdges.some(
      (e) =>
        (e.from === sourceRepo && e.to === targetRepo) ||
        (e.from === targetRepo && e.to === sourceRepo)
    );
    return {
      controlId: "N498",
      passed: hasEdge,
      reason: hasEdge
        ? "Compliant: declared cross-repository dependency edge exists"
        : `Fail-closed: undeclared cross-repository edge between ${sourceRepo} and ${targetRepo}`,
    };
  }

  // N499: memory query amplification
  public static checkN499QueryAmplification(
    requestedLimit: number,
    maxLimit: number
  ): PolicyCheckResult {
    const violates = requestedLimit > maxLimit;
    return {
      controlId: "N499",
      passed: !violates,
      reason: violates
        ? `Fail-closed: query limit ${requestedLimit} exceeds max ${maxLimit}`
        : "Compliant: query limit within bounds",
    };
  }

  // N500: memory expansion recursion
  public static checkN500ExpansionRecursion(
    currentRound: number,
    maxRounds: number
  ): PolicyCheckResult {
    const violates = currentRound > maxRounds;
    return {
      controlId: "N500",
      passed: !violates,
      reason: violates
        ? `Fail-closed: expansion round ${currentRound} exceeds limit ${maxRounds}`
        : "Compliant: expansion within bound",
    };
  }

  // N501: working-tree stale write
  public static checkN501StaleWrite(
    proposalBaseRevision: string,
    currentRevision: string
  ): PolicyCheckResult {
    const violates = proposalBaseRevision !== currentRevision;
    return {
      controlId: "N501",
      passed: !violates,
      reason: violates
        ? `Fail-closed: stale write attempt against rev ${proposalBaseRevision} (current ${currentRevision})`
        : "Compliant: write against current revision",
    };
  }

  // N502: lost update
  public static checkN502LostUpdate(
    proposalA: MutationProposal,
    proposalB: MutationProposal
  ): PolicyCheckResult {
    const filesA = new Set(Object.keys(proposalA.affectedFileDigests));
    const overlap = Object.keys(proposalB.affectedFileDigests).filter((f) => filesA.has(f));
    const violates = overlap.length > 0;
    return {
      controlId: "N502",
      passed: !violates,
      reason: violates
        ? `Fail-closed: concurrent modification of overlapping files [${overlap.join(", ")}] prevented`
        : "Compliant: non-overlapping updates",
    };
  }

  // N503: silent overwrite
  public static checkN503SilentOverwrite(
    fileModified: string,
    proposalRecorded: boolean
  ): PolicyCheckResult {
    const violates = !proposalRecorded;
    return {
      controlId: "N503",
      passed: !violates,
      reason: violates
        ? `Fail-closed: silent overwrite on ${fileModified} without registered proposal`
        : "Compliant: mutation tracked by proposal",
    };
  }

  // N504: base-revision substitution
  public static checkN504BaseRevisionSubstitution(
    recordedBase: string,
    actualBase: string
  ): PolicyCheckResult {
    const violates = recordedBase !== actualBase;
    return {
      controlId: "N504",
      passed: !violates,
      reason: violates
        ? `Fail-closed: base revision mismatch (${recordedBase} !== ${actualBase})`
        : "Compliant: base revision matches",
    };
  }

  // N505: tree-digest substitution
  public static checkN505TreeDigestSubstitution(
    recordedDigest: string,
    actualDigest: string
  ): PolicyCheckResult {
    const violates = recordedDigest !== actualDigest;
    return {
      controlId: "N505",
      passed: !violates,
      reason: violates
        ? `Fail-closed: tree digest substitution detected (${recordedDigest} !== ${actualDigest})`
        : "Compliant: tree digest valid",
    };
  }

  // N506: unauthorized merge
  public static checkN506UnauthorizedMerge(
    reconciliation: WorkingTreeReconciliationResult
  ): PolicyCheckResult {
    const violates = reconciliation.status !== "RECONCILED";
    return {
      controlId: "N506",
      passed: !violates,
      reason: violates
        ? `Fail-closed: merge attempted with non-reconciled status ${reconciliation.status}`
        : "Compliant: reconciliation status is RECONCILED",
    };
  }

  // N507: conflict suppression
  public static checkN507ConflictSuppression(
    reconciliation: WorkingTreeReconciliationResult
  ): PolicyCheckResult {
    const violates =
      reconciliation.status === "RECONCILED" && reconciliation.conflicts.length > 0;
    return {
      controlId: "N507",
      passed: !violates,
      reason: violates
        ? "Fail-closed: conflict suppression detected; conflicts present but status RECONCILED"
        : "Compliant: no suppressed conflicts",
    };
  }

  // N508: local-merge-to-terminal escalation
  public static checkN508LocalMergeToTerminalEscalation(
    reconciliation: WorkingTreeReconciliationResult
  ): PolicyCheckResult {
    const violates =
      (reconciliation as unknown as { terminalAuthority?: boolean }).terminalAuthority ===
        true ||
      (reconciliation as unknown as { verificationAuthority?: boolean })
        .verificationAuthority === true;
    return {
      controlId: "N508",
      passed: !violates,
      reason: violates
        ? "Fail-closed: local merge cannot confer terminal or verification authority"
        : "Compliant: merge is non-authoritative",
    };
  }

  // N509: oracle/reference leakage
  public static checkN509OracleLeakage(content: unknown): PolicyCheckResult {
    const text = typeof content === "string" ? content : JSON.stringify(content);
    const violates = /__ORACLE__|GOLD_PATCH|REFERENCE_SOLUTION/i.test(text);
    return {
      controlId: "N509",
      passed: !violates,
      reason: violates
        ? "Fail-closed: oracle/reference leakage detected in memory content"
        : "Compliant: no reference test leakage",
    };
  }

  // N510: terminal authority escalation
  public static checkN510TerminalAuthorityEscalation(entity: unknown): PolicyCheckResult {
    const obj = entity as Record<string, unknown>;
    const violates =
      obj.terminalAuthority === true ||
      obj.terminalSuccess === true ||
      obj.verified === true;
    return {
      controlId: "N510",
      passed: !violates,
      reason: violates
        ? "Fail-closed: cooperative memory cannot issue terminal authority"
        : "Compliant: zero terminal authority",
    };
  }
}
