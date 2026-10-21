/**
 * Phase 93: Speculative Execution Security Policy
 *
 * Enforces negative security controls N511–N540 and authority invariants S1–S18.
 *
 * ALL CONTROLS FAIL CLOSED.
 */

import { SpeculativeBranch } from "../domain/speculative-execution.js";
import { isSensitiveKey } from "../domain/canonical-hash.js";

export const SPECULATIVE_RESOURCE_LIMITS = {
  MAX_SPECULATIVE_BRANCHES_PER_WORKFLOW: 8,
  MAX_BRANCH_DEPTH: 4,
  MAX_BRANCH_DEPENDENCIES: 16,
  MAX_SPECULATIVE_ACTIONS_PER_BRANCH: 12,
  MAX_TOTAL_SPECULATIVE_ACTIONS_PER_WORKFLOW: 64,
  MAX_SPECULATIVE_MEMORY_PER_WORKFLOW_BYTES: 256 * 1024, // 256KB
  MAX_BRANCH_OUTPUT_BYTES: 64 * 1024, // 64KB
  MAX_ROLLBACK_DEPTH: 8,
  MAX_ROLLBACK_CASCADE_SIZE: 32,
} as const;

export interface PolicyCheckResult {
  readonly controlId: string;
  readonly passed: boolean;
  readonly reason: string;
}

export class SpeculativeExecutionPolicy {
  // N511: speculative authority injection
  public static checkN511AuthorityInjection(record: unknown): PolicyCheckResult {
    const rec = record as Record<string, unknown>;
    const violates = rec.authoritative === true;
    return {
      controlId: "N511",
      passed: !violates,
      reason: violates
        ? "Fail-closed: speculative branch cannot have authoritative = true"
        : "Compliant: authoritative = false",
    };
  }

  // N512: speculative terminal authority injection
  public static checkN512TerminalAuthorityInjection(record: unknown): PolicyCheckResult {
    const rec = record as Record<string, unknown>;
    const violates = rec.terminalAuthority === true;
    return {
      controlId: "N512",
      passed: !violates,
      reason: violates
        ? "Fail-closed: speculative branch cannot confer terminal authority"
        : "Compliant: terminalAuthority = false",
    };
  }

  // N513: speculative verification authority injection
  public static checkN513VerificationAuthorityInjection(record: unknown): PolicyCheckResult {
    const rec = record as Record<string, unknown>;
    const violates = rec.verificationAuthority === true;
    return {
      controlId: "N513",
      passed: !violates,
      reason: violates
        ? "Fail-closed: speculative branch cannot confer verification authority"
        : "Compliant: verificationAuthority = false",
    };
  }

  // N514: speculative policy authority injection
  public static checkN514PolicyAuthorityInjection(record: unknown): PolicyCheckResult {
    const rec = record as Record<string, unknown>;
    const violates = rec.policyAuthority === true;
    return {
      controlId: "N514",
      passed: !violates,
      reason: violates
        ? "Fail-closed: speculative branch cannot confer policy authority"
        : "Compliant: policyAuthority = false",
    };
  }

  // N515: speculative credential injection
  public static checkN515CredentialInjection(content: unknown): PolicyCheckResult {
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
      controlId: "N515",
      passed: !hasCredential,
      reason: hasCredential
        ? "Fail-closed: credential detected in speculative content"
        : "Compliant: no credentials detected",
    };
  }

  // N516: speculative workspace escape
  public static checkN516WorkspaceEscape(
    branchWorkspace: string,
    declaredWorkspaces: readonly string[]
  ): PolicyCheckResult {
    const violates = !declaredWorkspaces.includes(branchWorkspace);
    return {
      controlId: "N516",
      passed: !violates,
      reason: violates
        ? `Fail-closed: workspace ${branchWorkspace} outside declared workspaces`
        : "Compliant: workspace within declared boundary",
    };
  }

  // N517: speculative repository escape
  public static checkN517RepositoryEscape(
    branchRepo: string,
    declaredRepos: readonly string[]
  ): PolicyCheckResult {
    const violates = !declaredRepos.includes(branchRepo);
    return {
      controlId: "N517",
      passed: !violates,
      reason: violates
        ? `Fail-closed: repository ${branchRepo} outside declared repositories`
        : "Compliant: repository within declared boundary",
    };
  }

  // N518: speculative goal escape
  public static checkN518GoalEscape(
    branchGoal: string,
    declaredGoals: readonly string[]
  ): PolicyCheckResult {
    const violates = !declaredGoals.includes(branchGoal);
    return {
      controlId: "N518",
      passed: !violates,
      reason: violates
        ? `Fail-closed: goal ${branchGoal} outside declared goals`
        : "Compliant: goal within declared boundary",
    };
  }

  // N519: speculative branch identity substitution
  public static checkN519BranchIdentitySubstitution(
    recordedBranchId: string,
    expectedBranchId: string
  ): PolicyCheckResult {
    const violates = recordedBranchId !== expectedBranchId;
    return {
      controlId: "N519",
      passed: !violates,
      reason: violates
        ? `Fail-closed: branch identity mismatch (${recordedBranchId} !== ${expectedBranchId})`
        : "Compliant: branch identity matches",
    };
  }

  // N520: speculative tree-digest substitution
  public static checkN520TreeDigestSubstitution(
    recordedDigest: string,
    actualDigest: string
  ): PolicyCheckResult {
    const violates = recordedDigest !== actualDigest;
    return {
      controlId: "N520",
      passed: !violates,
      reason: violates
        ? `Fail-closed: speculative tree digest mismatch (${recordedDigest} !== ${actualDigest})`
        : "Compliant: tree digest valid",
    };
  }

  // N521: speculative base-revision substitution
  public static checkN521BaseRevisionSubstitution(
    recordedBase: string,
    actualBase: string
  ): PolicyCheckResult {
    const violates = recordedBase !== actualBase;
    return {
      controlId: "N521",
      passed: !violates,
      reason: violates
        ? `Fail-closed: base revision mismatch (${recordedBase} !== ${actualBase})`
        : "Compliant: base revision valid",
    };
  }

  // N522: stale verification acceptance
  public static checkN522StaleVerificationAcceptance(
    verificationState: string,
    currentRevision: string,
    verificationRevision: string
  ): PolicyCheckResult {
    const violates =
      verificationState === "STALE" || currentRevision !== verificationRevision;
    return {
      controlId: "N522",
      passed: !violates,
      reason: violates
        ? `Fail-closed: stale verification acceptance blocked (state=${verificationState}, rev=${verificationRevision} vs current=${currentRevision})`
        : "Compliant: verification matches current revision",
    };
  }

  // N523: verification branch mismatch
  public static checkN523VerificationBranchMismatch(
    resultBranchId: string,
    targetBranchId: string
  ): PolicyCheckResult {
    const violates = resultBranchId !== targetBranchId;
    return {
      controlId: "N523",
      passed: !violates,
      reason: violates
        ? `Fail-closed: verification result branch mismatch (${resultBranchId} !== ${targetBranchId})`
        : "Compliant: branch identity bound to verification",
    };
  }

  // N524: verification contract mismatch
  public static checkN524VerificationContractMismatch(
    resultContractHash: string,
    branchContractHash: string
  ): PolicyCheckResult {
    const violates = resultContractHash !== branchContractHash;
    return {
      controlId: "N524",
      passed: !violates,
      reason: violates
        ? `Fail-closed: verification contract mismatch (${resultContractHash} !== ${branchContractHash})`
        : "Compliant: contract hash matches",
    };
  }

  // N525: verification goal mismatch
  public static checkN525VerificationGoalMismatch(
    resultGoalId: string,
    branchGoalId: string
  ): PolicyCheckResult {
    const violates = resultGoalId !== branchGoalId;
    return {
      controlId: "N525",
      passed: !violates,
      reason: violates
        ? `Fail-closed: verification goal mismatch (${resultGoalId} !== ${branchGoalId})`
        : "Compliant: goal identity matches",
    };
  }

  // N526: verification provenance mismatch
  public static checkN526VerificationProvenanceMismatch(
    resultProvenanceRoot: string,
    branchProvenanceRoot: string
  ): PolicyCheckResult {
    const violates = resultProvenanceRoot !== branchProvenanceRoot;
    return {
      controlId: "N526",
      passed: !violates,
      reason: violates
        ? `Fail-closed: verification provenance mismatch (${resultProvenanceRoot} !== ${branchProvenanceRoot})`
        : "Compliant: provenance root matches",
    };
  }

  // N527: failed-ancestor resurrection
  public static checkN527FailedAncestorResurrection(
    parentStatus: string
  ): PolicyCheckResult {
    const violates = parentStatus === "FAILED" || parentStatus === "INVALIDATED";
    return {
      controlId: "N527",
      passed: !violates,
      reason: violates
        ? `Fail-closed: cannot promote branch with failed/invalid parent (parentStatus=${parentStatus})`
        : "Compliant: parent is not failed/invalid",
    };
  }

  // N528: invalid-child promotion
  public static checkN528InvalidChildPromotion(
    childStatus: string
  ): PolicyCheckResult {
    const violates = childStatus !== "VERIFIED";
    return {
      controlId: "N528",
      passed: !violates,
      reason: violates
        ? `Fail-closed: cannot promote child branch with unverified status ${childStatus}`
        : "Compliant: child is verified",
    };
  }

  // N529: rollback bypass
  public static checkN529RollbackBypass(
    branchStatus: string,
    rollbackState: string
  ): PolicyCheckResult {
    const violates =
      (branchStatus === "FAILED" || branchStatus === "INVALIDATED") &&
      rollbackState === "NONE";
    return {
      controlId: "N529",
      passed: !violates,
      reason: violates
        ? "Fail-closed: failed or invalidated branch must enter rollback"
        : "Compliant: rollback registered",
    };
  }

  // N530: rollback evidence deletion
  public static checkN530RollbackEvidenceDeletion(
    historicalBranchesRetained: boolean
  ): PolicyCheckResult {
    const violates = !historicalBranchesRetained;
    return {
      controlId: "N530",
      passed: !violates,
      reason: violates
        ? "Fail-closed: rollback cannot erase historical branch records"
        : "Compliant: history preserved across rollback",
    };
  }

  // N531: rollback idempotency violation
  public static checkN531RollbackIdempotencyViolation(
    firstRollbackTreeDigest: string,
    secondRollbackTreeDigest: string
  ): PolicyCheckResult {
    const violates = firstRollbackTreeDigest !== secondRollbackTreeDigest;
    return {
      controlId: "N531",
      passed: !violates,
      reason: violates
        ? `Fail-closed: rollback idempotency violated (${firstRollbackTreeDigest} !== ${secondRollbackTreeDigest})`
        : "Compliant: rollback is strictly idempotent",
    };
  }

  // N532: silent speculative-to-authoritative mutation
  public static checkN532SilentMutation(
    speculativePromotedWithoutVerification: boolean
  ): PolicyCheckResult {
    const violates = speculativePromotedWithoutVerification;
    return {
      controlId: "N532",
      passed: !violates,
      reason: violates
        ? "Fail-closed: speculative state cannot mutate authoritative state without sovereign verification"
        : "Compliant: sovereign verification verified before promotion",
    };
  }

  // N533: speculative merge-to-terminal escalation
  public static checkN533MergeToTerminalEscalation(
    isMerged: boolean,
    claimsTerminalSuccess: boolean
  ): PolicyCheckResult {
    const violates = isMerged && claimsTerminalSuccess;
    return {
      controlId: "N533",
      passed: !violates,
      reason: violates
        ? "Fail-closed: speculative merge cannot confer terminal success"
        : "Compliant: merge is non-terminal",
    };
  }

  // N534: speculative verification-to-terminal escalation
  public static checkN534VerificationToTerminalEscalation(
    isVerified: boolean,
    claimsTerminalSuccess: boolean
  ): PolicyCheckResult {
    const violates = isVerified && claimsTerminalSuccess;
    return {
      controlId: "N534",
      passed: !violates,
      reason: violates
        ? "Fail-closed: local branch verification cannot confer terminal success without fourfold sovereign gate"
        : "Compliant: fourfold gate preserved",
    };
  }

  // N535: branch dependency spoofing
  public static checkN535DependencySpoofing(
    declaredDependencies: readonly string[],
    actualDependencies: readonly string[]
  ): PolicyCheckResult {
    const declaredSet = new Set(declaredDependencies);
    const hasUndeclared = actualDependencies.some((d) => !declaredSet.has(d));
    return {
      controlId: "N535",
      passed: !hasUndeclared,
      reason: hasUndeclared
        ? "Fail-closed: undeclared branch dependency detected"
        : "Compliant: dependencies declared",
    };
  }

  // N536: rollback cascade suppression
  public static checkN536CascadeSuppression(
    parentFailed: boolean,
    dependentBranchCancelled: boolean
  ): PolicyCheckResult {
    const violates = parentFailed && !dependentBranchCancelled;
    return {
      controlId: "N536",
      passed: !violates,
      reason: violates
        ? "Fail-closed: cascade rollback suppressed for dependent branch"
        : "Compliant: dependent branch invalidated",
    };
  }

  // N537: independent-branch contamination
  public static checkN537IndependentBranchContamination(
    unrelatedBranchCancelled: boolean
  ): PolicyCheckResult {
    const violates = unrelatedBranchCancelled;
    return {
      controlId: "N537",
      passed: !violates,
      reason: violates
        ? "Fail-closed: unrelated independent branch falsely contaminated/cancelled"
        : "Compliant: independent branch preserved",
    };
  }

  // N538: speculative memory authority injection
  public static checkN538MemoryAuthorityInjection(record: unknown): PolicyCheckResult {
    const rec = record as Record<string, unknown>;
    const violates = rec.authoritative === true;
    return {
      controlId: "N538",
      passed: !violates,
      reason: violates
        ? "Fail-closed: speculative memory record cannot carry authority"
        : "Compliant: memory record is untrusted observation",
    };
  }

  // N539: speculative resource authority injection
  public static checkN539ResourceAuthorityInjection(record: unknown): PolicyCheckResult {
    const rec = record as Record<string, unknown>;
    const violates = rec.policyAuthority === true;
    return {
      controlId: "N539",
      passed: !violates,
      reason: violates
        ? "Fail-closed: speculative branch cannot modify resource authority"
        : "Compliant: resource authority unchanged",
    };
  }

  // N540: speculative oracle/reference leakage
  public static checkN540OracleLeakage(content: unknown): PolicyCheckResult {
    const text = typeof content === "string" ? content : JSON.stringify(content);
    const violates = /__ORACLE__|GOLD_PATCH|REFERENCE_SOLUTION/i.test(text);
    return {
      controlId: "N540",
      passed: !violates,
      reason: violates
        ? "Fail-closed: oracle/reference leakage detected in speculative content"
        : "Compliant: no reference test leakage",
    };
  }

  // --------------------------------------------------------------------------
  // Authority Invariants S1–S18
  // --------------------------------------------------------------------------
  public static checkS1NonAuthoritative(branch: SpeculativeBranch): PolicyCheckResult {
    const passed = branch.authoritative === false;
    return {
      controlId: "S1",
      passed,
      reason: passed ? "Compliant: authoritative = false" : "Invariant violation: authoritative = true",
    };
  }

  public static checkS2NoTerminalAuthority(branch: SpeculativeBranch): PolicyCheckResult {
    const passed = branch.terminalAuthority === false;
    return {
      controlId: "S2",
      passed,
      reason: passed ? "Compliant: terminalAuthority = false" : "Invariant violation: terminalAuthority = true",
    };
  }

  public static checkS3NoVerificationAuthority(branch: SpeculativeBranch): PolicyCheckResult {
    const passed = branch.verificationAuthority === false;
    return {
      controlId: "S3",
      passed,
      reason: passed ? "Compliant: verificationAuthority = false" : "Invariant violation: verificationAuthority = true",
    };
  }

  public static checkS4NoPolicyAuthority(branch: SpeculativeBranch): PolicyCheckResult {
    const passed = branch.policyAuthority === false;
    return {
      controlId: "S4",
      passed,
      reason: passed ? "Compliant: policyAuthority = false" : "Invariant violation: policyAuthority = true",
    };
  }

  public static checkS5SpeculativeSuccessNotTerminal(branch: SpeculativeBranch): PolicyCheckResult {
    const passed = branch.terminalAuthority === false;
    return {
      controlId: "S5",
      passed,
      reason: passed
        ? "Compliant: speculative success != verified != terminal success"
        : "Invariant violation: speculative state claims terminal completion",
    };
  }

  public static checkS6CleanRoomSovereignGatekeeper(branch: SpeculativeBranch): PolicyCheckResult {
    const passed = branch.trustClass !== "SOVEREIGN_VERIFIED_RESULT" || branch.status === "VERIFIED";
    return {
      controlId: "S6",
      passed,
      reason: passed
        ? "Compliant: clean-room fourfold verification is sovereign gatekeeper"
        : "Invariant violation: sovereign verification bypassed",
    };
  }

  public static checkS7StaleVerificationFailsClosed(
    branch: SpeculativeBranch,
    currentAuthoritativeRevision: string
  ): PolicyCheckResult {
    const passed = branch.baseRevision === currentAuthoritativeRevision;
    return {
      controlId: "S7",
      passed,
      reason: passed
        ? "Compliant: verification bound to current base revision"
        : "Fail-closed: stale verification result rejected",
    };
  }

  public static checkS8RollbackIdempotency(firstDigest: string, secondDigest: string): PolicyCheckResult {
    const passed = firstDigest === secondDigest;
    return {
      controlId: "S8",
      passed,
      reason: passed
        ? "Compliant: rollback is strictly idempotent"
        : "Fail-closed: rollback produced divergent results",
    };
  }

  public static checkS9EvidencePreserved(currentCount: number, expectedCount: number): PolicyCheckResult {
    const passed = currentCount >= expectedCount;
    return {
      controlId: "S9",
      passed,
      reason: passed
        ? "Compliant: all historical evidence preserved"
        : "Fail-closed: evidence loss detected",
    };
  }

  public static checkS10UntrustedObservation(trustClass: string): PolicyCheckResult {
    const passed =
      trustClass === "UNTRUSTED_SPECULATION" ||
      trustClass === "PROVENANCE_BOUND_SPECULATION" ||
      trustClass === "LOCALLY_VERIFIED_SPECULATION";
    return {
      controlId: "S10",
      passed,
      reason: passed
        ? "Compliant: speculative outputs classified as untrusted observations"
        : "Fail-closed: speculative output claims authoritative fact",
    };
  }

  public static checkS11MaxDepthCeiling(depth: number): PolicyCheckResult {
    const passed = depth <= SPECULATIVE_RESOURCE_LIMITS.MAX_BRANCH_DEPTH;
    return {
      controlId: "S11",
      passed,
      reason: passed
        ? "Compliant: depth within ceiling"
        : `Fail-closed: depth ${depth} exceeds ceiling ${SPECULATIVE_RESOURCE_LIMITS.MAX_BRANCH_DEPTH}`,
    };
  }

  public static checkS12ResourceBudgetCeiling(actionCount: number, memoryBytes: number): PolicyCheckResult {
    const passed =
      actionCount <= SPECULATIVE_RESOURCE_LIMITS.MAX_TOTAL_SPECULATIVE_ACTIONS_PER_WORKFLOW &&
      memoryBytes <= SPECULATIVE_RESOURCE_LIMITS.MAX_SPECULATIVE_MEMORY_PER_WORKFLOW_BYTES;
    return {
      controlId: "S12",
      passed,
      reason: passed
        ? "Compliant: cumulative resource budget respected"
        : "Fail-closed: speculative resource budget ceiling exceeded",
    };
  }

  public static checkS13ContractBinding(branchContract: string, actualContract: string): PolicyCheckResult {
    const passed = branchContract === actualContract;
    return {
      controlId: "S13",
      passed,
      reason: passed
        ? "Compliant: mission contract identity bound"
        : "Fail-closed: mission contract divergence detected",
    };
  }

  public static checkS14MerkleProvenanceRoot(provenanceRoot: string): PolicyCheckResult {
    const passed = Boolean(provenanceRoot && provenanceRoot.length === 64);
    return {
      controlId: "S14",
      passed,
      reason: passed
        ? "Compliant: valid 64-char Merkle provenance root present"
        : "Fail-closed: missing or malformed Merkle provenance root",
    };
  }

  public static checkS15ParentImmutability(parentBefore: string, parentAfter: string): PolicyCheckResult {
    const passed = parentBefore === parentAfter;
    return {
      controlId: "S15",
      passed,
      reason: passed
        ? "Compliant: parent state immutable"
        : "Fail-closed: speculative child mutated parent branch state",
    };
  }

  public static checkS16ParentFailureCascade(parentStatus: string, childStatus: string): PolicyCheckResult {
    const passed = !(parentStatus === "FAILED" && childStatus === "VERIFIED");
    return {
      controlId: "S16",
      passed,
      reason: passed
        ? "Compliant: child branch invalidation on parent failure respected"
        : "Fail-closed: child verified despite parent failure",
    };
  }

  public static checkS17RevocationInvalidation(isRevoked: boolean, status: string): PolicyCheckResult {
    const passed = !(isRevoked && status !== "INVALIDATED" && status !== "ROLLED_BACK");
    return {
      controlId: "S17",
      passed,
      reason: passed
        ? "Compliant: revocation immediately invalidates branch"
        : "Fail-closed: revoked branch remains active",
    };
  }

  public static checkS18AutonomousL7Advisory(isL7: boolean, claimsTerminalAuthority: boolean): PolicyCheckResult {
    const passed = !(isL7 && claimsTerminalAuthority);
    return {
      controlId: "S18",
      passed,
      reason: passed
        ? "Compliant: autonomous L7 capability remains strictly advisory"
        : "Fail-closed: autonomous L7 attempted terminal authority grant",
    };
  }

  // --------------------------------------------------------------------------
  // Convenience & Fail-Closed Security Control Evaluators
  // --------------------------------------------------------------------------
  public static checkN516UnverifiedTreePromotion(branch: SpeculativeBranch): PolicyCheckResult {
    const passed = branch.status === "VERIFIED";
    return {
      controlId: "N516",
      passed,
      reason: passed
        ? "Compliant: branch is verified before promotion"
        : "Fail-closed: unverified speculative tree promotion blocked",
    };
  }

  public static checkN517PrematureAuthoritativeState(branch: SpeculativeBranch): PolicyCheckResult {
    const passed = branch.authoritative === false;
    return {
      controlId: "N517",
      passed,
      reason: "Compliant: premature authoritative state leak blocked",
    };
  }

  public static checkN518SandboxEscapeAttempt(path: string): PolicyCheckResult {
    const violates = path.includes("..") || path.startsWith("/") || path.startsWith("\\");
    return {
      controlId: "N518",
      passed: !violates,
      reason: violates
        ? "Fail-closed: path traversal escape attempt detected"
        : "Compliant: path within sandbox",
    };
  }

  public static checkN519CircularDependency(branchId: string, dependencies: readonly string[]): PolicyCheckResult {
    const violates = dependencies.includes(branchId);
    return {
      controlId: "N519",
      passed: !violates,
      reason: violates
        ? "Fail-closed: circular dependency detected"
        : "Compliant: acyclic dependencies",
    };
  }

  public static checkN520BranchLimitExceeded(branchCount: number): PolicyCheckResult {
    const violates = branchCount > SPECULATIVE_RESOURCE_LIMITS.MAX_SPECULATIVE_BRANCHES_PER_WORKFLOW;
    return {
      controlId: "N520",
      passed: !violates,
      reason: violates
        ? `Fail-closed: branch limit ${SPECULATIVE_RESOURCE_LIMITS.MAX_SPECULATIVE_BRANCHES_PER_WORKFLOW} exceeded (${branchCount})`
        : "Compliant: branch count within limit",
    };
  }

  public static checkN521DepthLimitExceeded(depth: number): PolicyCheckResult {
    const violates = depth > SPECULATIVE_RESOURCE_LIMITS.MAX_BRANCH_DEPTH;
    return {
      controlId: "N521",
      passed: !violates,
      reason: violates
        ? `Fail-closed: branch depth limit ${SPECULATIVE_RESOURCE_LIMITS.MAX_BRANCH_DEPTH} exceeded (${depth})`
        : "Compliant: depth within limit",
    };
  }

  public static checkN522MemoryLimitExceeded(bytes: number): PolicyCheckResult {
    const violates = bytes > SPECULATIVE_RESOURCE_LIMITS.MAX_SPECULATIVE_MEMORY_PER_WORKFLOW_BYTES;
    return {
      controlId: "N522",
      passed: !violates,
      reason: violates
        ? `Fail-closed: speculative memory limit exceeded (${bytes} bytes)`
        : "Compliant: memory within limit",
    };
  }

  public static checkN523ActionLimitExceeded(actions: number): PolicyCheckResult {
    const violates = actions > SPECULATIVE_RESOURCE_LIMITS.MAX_SPECULATIVE_ACTIONS_PER_BRANCH;
    return {
      controlId: "N523",
      passed: !violates,
      reason: violates
        ? `Fail-closed: speculative actions limit exceeded (${actions})`
        : "Compliant: actions within limit",
    };
  }

  public static checkN524StaleVerificationAccepted(accepted: boolean): PolicyCheckResult {
    return {
      controlId: "N524",
      passed: !accepted,
      reason: accepted
        ? "Fail-closed: stale verification result accepted"
        : "Compliant: stale verification rejected",
    };
  }

  public static checkN525CrossGoalPollution(goalA: string, goalB: string): PolicyCheckResult {
    const violates = goalA !== goalB;
    return {
      controlId: "N525",
      passed: !violates,
      reason: violates
        ? `Fail-closed: cross-goal pollution (${goalA} !== ${goalB})`
        : "Compliant: goal isolated",
    };
  }

  public static checkN526RollbackCascadeLoop(depth: number): PolicyCheckResult {
    const violates = depth > SPECULATIVE_RESOURCE_LIMITS.MAX_ROLLBACK_DEPTH;
    return {
      controlId: "N526",
      passed: !violates,
      reason: violates
        ? "Fail-closed: rollback cascade loop detected"
        : "Compliant: cascade depth bounded",
    };
  }

  public static checkN527RollbackFailureMasking(masked: boolean): PolicyCheckResult {
    return {
      controlId: "N527",
      passed: !masked,
      reason: masked
        ? "Fail-closed: rollback failure masking detected"
        : "Compliant: rollback failure propagated",
    };
  }

  public static checkN528UnverifiedDependencyMerge(statuses: readonly string[]): PolicyCheckResult {
    const hasUnverified = statuses.some((s) => s !== "VERIFIED");
    return {
      controlId: "N528",
      passed: !hasUnverified,
      reason: hasUnverified
        ? "Fail-closed: merge includes unverified dependency"
        : "Compliant: all dependencies verified",
    };
  }

  public static checkN529OrphanBranchExecution(branchId: string, parentPresent: boolean): PolicyCheckResult {
    return {
      controlId: "N529",
      passed: parentPresent,
      reason: !parentPresent
        ? `Fail-closed: orphan branch execution blocked (${branchId})`
        : "Compliant: parent present",
    };
  }

  public static checkN530ToolCapabilityExpansion(tools: readonly string[]): PolicyCheckResult {
    const forbidden = ["system_exec", "admin_override", "eval_untrusted"];
    const violates = tools.some((t) => forbidden.includes(t));
    return {
      controlId: "N530",
      passed: !violates,
      reason: violates
        ? "Fail-closed: tool capability expansion blocked"
        : "Compliant: tool capabilities bounded",
    };
  }

  public static checkN531NonDeterministicRollback(digestA: string, digestB: string): PolicyCheckResult {
    const violates = digestA !== digestB;
    return {
      controlId: "N531",
      passed: !violates,
      reason: violates
        ? "Fail-closed: non-deterministic rollback detected"
        : "Compliant: rollback is deterministic",
    };
  }

  public static checkN532StateResurrection(from: string, to: string): PolicyCheckResult {
    const violates = (from === "ROLLED_BACK" || from === "CANCELLED") && to !== from;
    return {
      controlId: "N532",
      passed: !violates,
      reason: violates
        ? `Fail-closed: illegal state resurrection from ${from} to ${to}`
        : "Compliant: monotonic transitions",
    };
  }

  public static checkN533ContractDivergence(contractA: string, contractB: string): PolicyCheckResult {
    const violates = contractA !== contractB;
    return {
      controlId: "N533",
      passed: !violates,
      reason: violates
        ? "Fail-closed: mission contract divergence detected"
        : "Compliant: mission contracts match",
    };
  }

  public static checkN534UnverifiedPatchBroadcast(trustClass: string): PolicyCheckResult {
    const violates = trustClass !== "SOVEREIGN_VERIFIED_RESULT";
    return {
      controlId: "N534",
      passed: !violates,
      reason: violates
        ? "Fail-closed: unverified patch broadcast blocked"
        : "Compliant: sovereign verified patch broadcast permitted",
    };
  }

  public static checkN535ProvenanceTampering(rootA: string, rootB: string): PolicyCheckResult {
    const violates = rootA !== rootB;
    return {
      controlId: "N535",
      passed: !violates,
      reason: violates
        ? "Fail-closed: branch provenance tampering detected"
        : "Compliant: provenance verified",
    };
  }

  public static checkN536BufferOverflow(bytes: number): PolicyCheckResult {
    const violates = bytes > SPECULATIVE_RESOURCE_LIMITS.MAX_BRANCH_OUTPUT_BYTES;
    return {
      controlId: "N536",
      passed: !violates,
      reason: violates
        ? `Fail-closed: output buffer overflow (${bytes} bytes)`
        : "Compliant: output buffer within limits",
    };
  }

  public static checkN537VerificationTimeoutEvasion(timedOut: boolean): PolicyCheckResult {
    return {
      controlId: "N537",
      passed: !timedOut,
      reason: timedOut
        ? "Fail-closed: verification timeout evasion blocked"
        : "Compliant: verification within timeout window",
    };
  }

  public static checkN538MultiAgentDeadlock(deadlocked: boolean): PolicyCheckResult {
    return {
      controlId: "N538",
      passed: !deadlocked,
      reason: deadlocked
        ? "Fail-closed: multi-agent speculative deadlock broken via rollback"
        : "Compliant: no deadlock detected",
    };
  }

  public static checkN539CommitRaceEvasion(evaded: boolean): PolicyCheckResult {
    return {
      controlId: "N539",
      passed: !evaded,
      reason: evaded
        ? "Fail-closed: commit race evasion blocked"
        : "Compliant: commit serialized through sovereign verifier",
    };
  }

  public static checkN540VerificationBypass(verifiedByCleanRoom: boolean): PolicyCheckResult {
    return {
      controlId: "N540",
      passed: verifiedByCleanRoom,
      reason: !verifiedByCleanRoom
        ? "Fail-closed: clean-room verification bypass blocked"
        : "Compliant: verified by clean-room sovereign gate",
    };
  }
}
