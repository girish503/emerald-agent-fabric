/**
 * Emerald Agent Fabric — Dashboard Controller (Milestone 2.27 / Phase 2)
 *
 * Centralized, stateful controller managing:
 * - Connection and backend API health state
 * - Governed task submission with strict validation and sandboxed execution enforcement
 * - In-memory local task history (avoiding duplicate IDs and polling individual tasks)
 * - Run inspection and detailed state tracking
 * - 3-phase cancellation workflow (requesting -> requested -> confirmed_stopped)
 * - Subscriber notification pattern for reactive UI updates
 */

import type {
  CreateTaskRequest,
  TaskResponse,
  CancelRunResponse,
  TaskStatus,
  ExecutionMode,
  TrialFinalOutcome,
  SseEventEnvelope,
  ArtifactRecord,
  ArtifactContentResponse,
} from "../types/api.js";
import {
  EmeraldApiClient,
  ApiClientError,
  type RequestOptions,
} from "../client/api-client.js";
import {
  EmeraldSseClient,
  type SseConnectionStatus,
} from "../client/sse-client.js";
import {
  validateTaskSubmissionInput,
  summarizeDashboardState,
  buildTimelineSteps,
  type TimelineStepView,
} from "./workspace-views.js";
import type {
  VerificationCompletedView,
  VerificationRejectedView,
  UnverifiedCompletionAuthorizedView,
  RecordedEvidenceView,
} from "./evidence-viewer.js";

export type ConnectionStatus = "idle" | "connected" | "error" | "unavailable";

export type CancellationPhase =
  | "idle"
  | "requesting"
  | "requested"
  | "confirmed_stopped"
  | "failed";

export interface CancellationState {
  readonly phase: CancellationPhase;
  readonly reason?: string;
  readonly message?: string;
  readonly error?: string;
  readonly requestedAt?: string;
}

export interface AuthState {
  readonly authenticated: boolean;
  readonly isAuthenticating: boolean;
  readonly principalId?: string;
  readonly tenantId?: string;
  readonly role?: string;
  readonly authError?: string;
  readonly hasToken?: boolean;
}

export interface LocalTaskEntry {
  readonly taskId: string;
  readonly title: string;
  readonly prompt?: string;
  readonly status: TaskStatus;
  readonly executionMode: ExecutionMode;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly contractId: string | null;
  readonly runId?: string;
  readonly parentTaskId?: string | null;
  readonly childTaskCount?: number;
  readonly fetchError?: string;
  readonly lastRefreshedAt?: string;
}

export interface LocalRunEntry {
  readonly runId: string;
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly attemptNumber: number;
  readonly currentStepIndex: number;
  readonly leaseExpiresAt: string | null;
  readonly finalOutcome: TrialFinalOutcome | null;
  readonly metrics: {
    readonly wallClockMs: number;
    readonly stepCount: number;
    readonly toolCallCount: number;
  };
  readonly createdAt: string;
  readonly completedAt: string | null;
  readonly fetchError?: string;
  readonly lastRefreshedAt?: string;
}

export interface TaskSubmissionFormState {
  title: string;
  prompt: string;
  repoPath?: string;
  requiredCapabilities?: string[];
  modelName?: string;
  provider?: string;
  temperature?: number;
  contextWindow?: number;
  timeoutSeconds?: number;
  maxSteps?: number;
  maxOutputBytes?: number;
  verificationSpecs?: Array<{
    name: string;
    command: string;
    timeoutMs?: number;
    expectedExitCode?: number;
  }>;
}

export interface DashboardState {
  readonly connectionStatus: ConnectionStatus;
  readonly connectionError?: string;
  readonly isSubmitting: boolean;
  readonly lastSubmissionError?: string;
  readonly lastSubmittedTaskId?: string;
  readonly tasks: readonly LocalTaskEntry[];
  readonly selectedTaskId?: string;
  readonly selectedRun?: LocalRunEntry;
  readonly runsById?: Readonly<Record<string, LocalRunEntry>>;
  readonly cancellation: Readonly<Record<string, CancellationState>>;
  readonly auth?: AuthState;
  readonly sseConnectionStatus?: SseConnectionStatus;
  readonly sseError?: string;
  readonly sseEventCount?: number;
  readonly lastEventSequence?: number;
  readonly timelineSteps?: readonly TimelineStepView[];
  readonly rawEvents?: readonly SseEventEnvelope[];
  readonly artifacts?: readonly ArtifactRecord[];
  readonly artifactsLoading?: boolean;
  readonly artifactsError?: string;
  readonly selectedArtifactId?: string;
  readonly artifactPreview?: ArtifactContentResponse | null;
  readonly artifactPreviewLoading?: boolean;
  readonly artifactPreviewError?: string;
  readonly completedVerifications?: readonly VerificationCompletedView[];
  readonly rejections?: readonly VerificationRejectedView[];
  readonly unverifiedOverrides?: readonly UnverifiedCompletionAuthorizedView[];
  readonly recordedEvidence?: readonly RecordedEvidenceView[];
  readonly isHistoryLoading?: boolean;
  readonly historyError?: string;
  readonly nextCursor?: string | null;
  readonly statusFilter?: TaskStatus | "ALL";
  readonly hasMoreTasks?: boolean;
}

export type DashboardListener = (state: DashboardState) => void;

export class DashboardController {
  private readonly client: EmeraldApiClient;
  private state: DashboardState;
  private readonly listeners = new Set<DashboardListener>();
  private activeSseClient?: EmeraldSseClient;
  private activeRunId?: string;
  private activeArtifactsAbortController?: AbortController;
  private activeArtifactsRunId?: string;
  private activeArtifactPreviewAbortController?: AbortController;
  private activeArtifactPreviewId?: string;
  private activeHistoryAbortController?: AbortController;
  private currentHistoryRequestId = 0;
  private readonly maxBufferedEvents = 500;

  constructor(client: EmeraldApiClient, initialState?: Partial<DashboardState>) {
    this.client = client;
    this.state = {
      connectionStatus: "idle",
      isSubmitting: false,
      tasks: [],
      runsById: {},
      cancellation: {},
      auth: {
        authenticated: false,
        isAuthenticating: false,
        hasToken: false,
      },
      sseConnectionStatus: "idle",
      sseEventCount: 0,
      lastEventSequence: 0,
      timelineSteps: [],
      rawEvents: [],
      artifacts: [],
      artifactsLoading: false,
      artifactPreview: null,
      artifactPreviewLoading: false,
      artifactPreviewError: undefined,
      completedVerifications: [],
      rejections: [],
      unverifiedOverrides: [],
      recordedEvidence: [],
      isHistoryLoading: false,
      nextCursor: null,
      statusFilter: "ALL",
      hasMoreTasks: false,
      ...initialState,
    };
  }

  /**
   * Authenticates using an explicit operator-provided bearer token stored strictly in-memory.
   */
  async signInWithToken(token: string, options: RequestOptions = {}): Promise<boolean> {
    const trimmed = token.trim();
    if (!trimmed) {
      this.updateState({
        auth: {
          authenticated: false,
          isAuthenticating: false,
          hasToken: false,
          authError: "Bearer token is required.",
        },
      });
      return false;
    }

    this.client.setAuthToken(trimmed);
    this.updateState({
      auth: {
        authenticated: false,
        isAuthenticating: true,
        hasToken: true,
        authError: undefined,
      },
    });

    try {
      const response = await this.client.whoami(options);
      const id = response.data;
      this.updateState({
        connectionStatus: "connected",
        connectionError: undefined,
        auth: {
          authenticated: true,
          isAuthenticating: false,
          principalId: id.principalId,
          tenantId: id.tenantId,
          role: id.role,
          authError: undefined,
          hasToken: true,
        },
      });
      await this.loadTaskHistory({ reset: true }).catch(() => {});
      return true;
    } catch (err) {
      this.client.clearAuthToken();
      const errorMsg = (err as Error)?.message ?? "Authentication failed";
      this.updateState({
        auth: {
          authenticated: false,
          isAuthenticating: false,
          hasToken: false,
          authError: errorMsg,
        },
      });
      this.handleConnectionError(err);
      return false;
    }
  }

  /**
   * Probes GET /api/v1/auth/whoami when the client already holds an in-memory bearer token.
   */
  async authenticateCurrentToken(options: RequestOptions = {}): Promise<boolean> {
    const existingToken = await this.client.getToken();
    if (!existingToken) {
      return false;
    }
    this.updateState({
      auth: {
        ...(this.state.auth ?? { authenticated: false }),
        isAuthenticating: true,
        hasToken: true,
        authError: undefined,
      },
    });
    try {
      const response = await this.client.whoami(options);
      const id = response.data;
      this.updateState({
        auth: {
          authenticated: true,
          isAuthenticating: false,
          principalId: id.principalId,
          tenantId: id.tenantId,
          role: id.role,
          authError: undefined,
          hasToken: true,
        },
      });
      return true;
    } catch (err) {
      if (err instanceof ApiClientError && (err.statusCode === 401 || err.statusCode === 403)) {
        this.client.clearAuthToken();
      }
      const remainingToken = await this.client.getToken();
      const errorMsg = (err as Error)?.message ?? "Token verification failed";
      this.updateState({
        auth: {
          authenticated: false,
          isAuthenticating: false,
          hasToken: Boolean(remainingToken),
          authError: errorMsg,
        },
      });
      return false;
    }
  }

  /**
   * Clears in-memory credentials, aborts active requests/streams, and resets session data.
   */
  signOut(): void {
    this.client.clearAuthToken();
    if (this.activeHistoryAbortController) {
      this.activeHistoryAbortController.abort();
      this.activeHistoryAbortController = undefined;
    }
    if (this.activeArtifactsAbortController) {
      this.activeArtifactsAbortController.abort();
      this.activeArtifactsAbortController = undefined;
    }
    if (this.activeArtifactPreviewAbortController) {
      this.activeArtifactPreviewAbortController.abort();
      this.activeArtifactPreviewAbortController = undefined;
    }
    this.activeArtifactsRunId = undefined;
    this.activeArtifactPreviewId = undefined;
    this.disconnectSse();
    this.updateState({
      connectionStatus: "idle",
      connectionError: undefined,
      tasks: [],
      selectedTaskId: undefined,
      selectedRun: undefined,
      runsById: {},
      lastSubmittedTaskId: undefined,
      lastSubmissionError: undefined,
      historyError: undefined,
      nextCursor: null,
      hasMoreTasks: false,
      artifacts: [],
      artifactsLoading: false,
      artifactsError: undefined,
      selectedArtifactId: undefined,
      artifactPreview: null,
      artifactPreviewLoading: false,
      artifactPreviewError: undefined,
      completedVerifications: [],
      rejections: [],
      unverifiedOverrides: [],
      recordedEvidence: [],
      timelineSteps: [],
      rawEvents: [],
      auth: {
        authenticated: false,
        isAuthenticating: false,
        hasToken: false,
        authError: undefined,
      },
    });
  }

  /**
   * Returns current immutable snapshot of dashboard state.
   */
  getState(): DashboardState {
    return this.state;
  }

  /**
   * Subscribes a listener to dashboard state mutations.
   * Returns an unsubscription callback.
   */
  subscribe(listener: DashboardListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Internal helper to atomically update state and notify all active listeners.
   */
  private updateState(
    updater: Partial<DashboardState> | ((prev: DashboardState) => Partial<DashboardState>)
  ): void {
    if (typeof updater === "function") {
      this.state = { ...this.state, ...updater(this.state) };
    } else {
      this.state = { ...this.state, ...updater };
    }
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch {
        // Prevent listener exceptions from breaking controller operation
      }
    }
  }

  /**
   * Loads task history from the authoritative backend endpoint GET /api/v1/tasks.
   * Supports resetting to page 1, cursor-based pagination, deduplication, and stale response protection.
   */
  async loadTaskHistory(options: { reset?: boolean } = {}): Promise<void> {
    const reset = options.reset ?? false;

    // Prevent concurrent duplicate pagination requests if already loading
    if (this.state.isHistoryLoading && !reset) {
      return;
    }

    if (!reset && !this.state.nextCursor) {
      return;
    }

    // Cancel previous in-flight history request if resetting
    if (this.activeHistoryAbortController) {
      this.activeHistoryAbortController.abort();
      this.activeHistoryAbortController = undefined;
    }

    const abortController = new AbortController();
    this.activeHistoryAbortController = abortController;
    const requestId = ++this.currentHistoryRequestId;

    const currentFilter = this.state.statusFilter ?? "ALL";
    const cursorToUse = reset ? undefined : (this.state.nextCursor ?? undefined);

    this.updateState({
      isHistoryLoading: true,
      historyError: undefined,
      ...(reset ? { nextCursor: null, hasMoreTasks: false } : {}),
    });

    try {
      const response = await this.client.listTasks({
        limit: 20,
        cursor: cursorToUse,
        status: currentFilter === "ALL" ? undefined : currentFilter,
        signal: abortController.signal,
      });

      // Guard against stale response
      if (this.currentHistoryRequestId !== requestId) {
        return;
      }

      const incomingTasks: LocalTaskEntry[] = response.data.map((item) => ({
        taskId: item.taskId,
        title: item.title,
        status: item.status,
        executionMode: item.executionMode,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        contractId: item.contractId,
        runId: item.runId,
        parentTaskId: item.parentTaskId,
        childTaskCount: item.childTaskCount,
      }));

      let mergedTasks: LocalTaskEntry[];
      if (reset) {
        mergedTasks = incomingTasks;
      } else {
        // Deduplicate against existing tasks
        const existingIds = new Set(this.state.tasks.map((t) => t.taskId));
        const filteredIncoming = incomingTasks.filter((t) => !existingIds.has(t.taskId));
        mergedTasks = [...this.state.tasks, ...filteredIncoming];
      }

      this.updateState({
        tasks: mergedTasks,
        nextCursor: response.nextCursor,
        hasMoreTasks: Boolean(response.nextCursor),
        isHistoryLoading: false,
        historyError: undefined,
        connectionStatus: "connected",
        connectionError: undefined,
      });
    } catch (err: unknown) {
      // If aborted, do nothing
      if (abortController.signal.aborted || (err as any)?.name === "AbortError") {
        return;
      }
      if (this.currentHistoryRequestId !== requestId) {
        return;
      }
      const errorMessage = err instanceof Error ? err.message : "Failed to load task history";
      const isAuthErr = err instanceof ApiClientError && (err.statusCode === 401 || err.statusCode === 403);
      this.updateState({
        isHistoryLoading: false,
        historyError: errorMessage,
        connectionStatus: isAuthErr ? "error" : this.state.connectionStatus,
        connectionError: isAuthErr ? errorMessage : this.state.connectionError,
        ...(isAuthErr
          ? {
              auth: {
                ...(this.state.auth ?? { isAuthenticating: false }),
                authenticated: false,
                isAuthenticating: false,
                hasToken: this.state.auth?.hasToken ?? false,
                authError: errorMessage,
              },
            }
          : {}),
      });
      throw err;
    } finally {
      if (this.activeHistoryAbortController === abortController) {
        this.activeHistoryAbortController = undefined;
      }
    }
  }

  /**
   * Updates status filter, resets cursor, clears list, and triggers a fresh load.
   */
  async setStatusFilter(status: TaskStatus | "ALL"): Promise<void> {
    if (this.state.statusFilter === status) return;

    if (this.activeHistoryAbortController) {
      this.activeHistoryAbortController.abort();
      this.activeHistoryAbortController = undefined;
    }

    this.updateState({
      statusFilter: status,
      tasks: [],
      nextCursor: null,
      hasMoreTasks: false,
      historyError: undefined,
    });

    try {
      await this.loadTaskHistory({ reset: true });
    } catch {
      // Error captured in state
    }
  }

  /**
   * Refreshes task history from the beginning for the current filter.
   */
  async refreshHistory(): Promise<void> {
    return this.loadTaskHistory({ reset: true });
  }

  /**
   * Requests the next page of task history using the stored server cursor.
   */
  async loadNextPage(): Promise<void> {
    if (!this.state.nextCursor || this.state.isHistoryLoading) {
      return;
    }
    return this.loadTaskHistory({ reset: false });
  }

  /**
   * Submits a governed agent task to the backend.
   * Strictly enforces sandboxed execution and validates payload before submission.
   */
  async submitTask(
    form: TaskSubmissionFormState,
    options: RequestOptions = {}
  ): Promise<TaskResponse> {
    if (this.state.isSubmitting) {
      throw new Error("Task submission is already in progress.");
    }

    // Input validation check
    const validation = validateTaskSubmissionInput({
      title: form.title,
      prompt: form.prompt,
      executionMode: "sandboxed",
    });

    if (!validation.valid) {
      const errorMsg = validation.errors.join("; ");
      this.updateState({ lastSubmissionError: errorMsg });
      throw new ApiClientError({
        message: errorMsg,
        statusCode: 400,
        code: "BAD_REQUEST",
      });
    }

    // Construct authoritative CreateTaskRequest strictly enforcing sandboxed execution
    const request: CreateTaskRequest = {
      title: form.title.trim(),
      prompt: form.prompt.trim(),
      repoPath: form.repoPath?.trim() || undefined,
      requiredCapabilities: form.requiredCapabilities ?? [],
      executionMode: "sandboxed",
      modelConfig: {
        provider: form.provider || "ollama",
        modelName: form.modelName || "qwen2.5-coder:7b",
        temperature: form.temperature ?? 0.2,
        contextWindow: form.contextWindow ?? 32768,
      },
      resourceLimits: {
        timeoutSeconds: form.timeoutSeconds ?? 600,
        maxSteps: form.maxSteps ?? 50,
        maxOutputBytes: form.maxOutputBytes ?? 1048576,
      },
      verificationSpecs: (form.verificationSpecs ?? []).map((spec) => ({
        name: spec.name,
        command: spec.command,
        timeoutMs: spec.timeoutMs ?? 30000,
        expectedExitCode: spec.expectedExitCode ?? 0,
      })),
    };

    this.updateState({
      isSubmitting: true,
      lastSubmissionError: undefined,
    });

    try {
      const response = await this.client.submitTask(request, options);
      const taskData = response.data;
      const returnedRunId = taskData.runId;

      const newEntry: LocalTaskEntry = {
        taskId: taskData.taskId,
        title: taskData.title,
        prompt: form.prompt.trim(),
        status: taskData.status,
        executionMode: taskData.executionMode,
        createdAt: taskData.createdAt,
        updatedAt: taskData.updatedAt,
        contractId: taskData.contractId ?? null,
        runId: returnedRunId,
        lastRefreshedAt: new Date().toISOString(),
      };

      // Deduplicate: If taskId already in local tasks, replace it; otherwise prepend (newest first)
      const existingIdx = this.state.tasks.findIndex((t) => t.taskId === taskData.taskId);
      let updatedTasks: LocalTaskEntry[];
      if (existingIdx >= 0) {
        updatedTasks = [...this.state.tasks];
        updatedTasks[existingIdx] = newEntry;
      } else {
        updatedTasks = [newEntry, ...this.state.tasks];
      }

      this.updateState({
        connectionStatus: "connected",
        connectionError: undefined,
        isSubmitting: false,
        lastSubmittedTaskId: taskData.taskId,
        selectedTaskId: taskData.taskId,
        tasks: updatedTasks,
      });

      // If run was assigned, start event stream and refresh run details
      if (returnedRunId) {
        this.startEventStream(returnedRunId);
        void this.refreshRun(returnedRunId).catch(() => {});
      }

      return response;
    } catch (err) {
      const apiErr = err instanceof ApiClientError ? err : undefined;
      const errorMsg = (err as Error)?.message ?? "Task submission failed";
      const connectionStatus: ConnectionStatus =
        apiErr?.statusCode === 503 || apiErr?.isTransient
          ? "unavailable"
          : apiErr?.statusCode === 401 || apiErr?.statusCode === 403
          ? "error"
          : this.state.connectionStatus;

      this.updateState({
        isSubmitting: false,
        lastSubmissionError: errorMsg,
        connectionStatus,
        connectionError:
          connectionStatus === "error" || connectionStatus === "unavailable"
            ? errorMsg
            : this.state.connectionError,
      });

      throw err;
    }
  }

  /**
   * Selects a task from local history to inspect details and linked run.
   */
  selectTask(taskId: string): void {
    const task = this.state.tasks.find((t) => t.taskId === taskId);
    const targetRunId = task?.runId;
    const prevRunId = this.state.selectedRun?.runId;
    const isNewRun = targetRunId !== prevRunId;

    if (this.activeArtifactsAbortController) {
      this.activeArtifactsAbortController.abort();
      this.activeArtifactsAbortController = undefined;
    }
    if (isNewRun && this.activeArtifactPreviewAbortController) {
      this.activeArtifactPreviewAbortController.abort();
      this.activeArtifactPreviewAbortController = undefined;
      this.activeArtifactPreviewId = undefined;
    }

    this.updateState({
      selectedTaskId: taskId,
      selectedRun:
        targetRunId && prevRunId === targetRunId
          ? this.state.selectedRun
          : targetRunId
          ? this.state.runsById?.[targetRunId]
          : undefined,
      artifacts: isNewRun ? [] : this.state.artifacts,
      artifactsLoading: isNewRun && Boolean(targetRunId),
      artifactsError: isNewRun ? undefined : this.state.artifactsError,
      selectedArtifactId: isNewRun ? undefined : this.state.selectedArtifactId,
      artifactPreview: isNewRun ? null : this.state.artifactPreview,
      artifactPreviewLoading: isNewRun ? false : this.state.artifactPreviewLoading,
      artifactPreviewError: isNewRun ? undefined : this.state.artifactPreviewError,
      completedVerifications: isNewRun ? [] : this.state.completedVerifications,
      rejections: isNewRun ? [] : this.state.rejections,
      unverifiedOverrides: isNewRun ? [] : this.state.unverifiedOverrides,
      recordedEvidence: isNewRun ? [] : this.state.recordedEvidence,
    });

    // Fetch full authoritative task specification and check for newly attached runs
    void this.refreshTask(taskId).catch(() => {});

    if (targetRunId) {
      if (this.activeRunId !== targetRunId) {
        this.startEventStream(targetRunId);
      }
      void this.refreshRun(targetRunId).catch(() => {});
      void this.loadArtifacts(targetRunId).catch(() => {});
    } else {
      this.disconnectSse();
      this.updateState({
        sseConnectionStatus: "idle",
        sseError: undefined,
        sseEventCount: 0,
        lastEventSequence: 0,
        timelineSteps: [],
        rawEvents: [],
        artifacts: [],
        artifactsLoading: false,
        artifactsError: undefined,
        selectedArtifactId: undefined,
        artifactPreview: null,
        artifactPreviewLoading: false,
        artifactPreviewError: undefined,
        completedVerifications: [],
        rejections: [],
        unverifiedOverrides: [],
        recordedEvidence: [],
      });
    }
  }

  /**
   * Refreshes a specific task's lifecycle state via GET /api/v1/tasks/:taskId.
   */
  async refreshTask(taskId: string, options: RequestOptions = {}): Promise<LocalTaskEntry> {
    try {
      const response = await this.client.getTask(taskId, options);
      const taskData = response.data;
      const returnedRunId = taskData.runId;

      const existing = this.state.tasks.find((t) => t.taskId === taskId);
      const updatedEntry: LocalTaskEntry = {
        taskId: taskData.taskId,
        title: taskData.title,
        prompt: existing?.prompt,
        status: taskData.status,
        executionMode: taskData.executionMode,
        createdAt: taskData.createdAt,
        updatedAt: taskData.updatedAt,
        contractId: taskData.contractId ?? null,
        runId: returnedRunId ?? existing?.runId,
        parentTaskId: taskData.parentTaskId ?? existing?.parentTaskId,
        childTaskCount: taskData.childTaskCount ?? existing?.childTaskCount,
        fetchError: undefined,
        lastRefreshedAt: new Date().toISOString(),
      };

      const existingIdx = this.state.tasks.findIndex((t) => t.taskId === taskId);
      let updatedTasks: LocalTaskEntry[];
      if (existingIdx >= 0) {
        updatedTasks = [...this.state.tasks];
        updatedTasks[existingIdx] = updatedEntry;
      } else {
        updatedTasks = [updatedEntry, ...this.state.tasks];
      }

      this.updateState({
        connectionStatus: "connected",
        connectionError: undefined,
        tasks: updatedTasks,
      });

      if (this.state.selectedTaskId === taskId && updatedEntry.runId) {
        if (this.activeRunId !== updatedEntry.runId) {
          this.startEventStream(updatedEntry.runId);
        }
        void this.refreshRun(updatedEntry.runId).catch(() => {});
        void this.loadArtifacts(updatedEntry.runId).catch(() => {});
      }

      return updatedEntry;
    } catch (err) {
      const errorMsg = (err as Error)?.message ?? "Failed to refresh task";
      const existingIdx = this.state.tasks.findIndex((t) => t.taskId === taskId);
      if (existingIdx >= 0) {
        const updatedTasks = [...this.state.tasks];
        const prev = updatedTasks[existingIdx];
        if (prev) {
          updatedTasks[existingIdx] = {
            ...prev,
            fetchError: errorMsg,
            lastRefreshedAt: new Date().toISOString(),
          };
          this.updateState({ tasks: updatedTasks });
        }
      }
      this.handleConnectionError(err);
      throw err;
    }
  }

  /**
   * Refreshes run execution state, step progress, lease, and authoritative outcome.
   * If cancellation was in "requested" phase and run reached "CANCELLED",
   * automatically transitions phase to "confirmed_stopped".
   */
  async refreshRun(runId: string, options: RequestOptions = {}): Promise<LocalRunEntry> {
    try {
      const response = await this.client.getRun(runId, options);
      const r = response.data;

      const runEntry: LocalRunEntry = {
        runId: r.runId,
        taskId: r.taskId,
        status: r.status,
        attemptNumber: r.attemptNumber,
        currentStepIndex: r.currentStepIndex,
        leaseExpiresAt: r.leaseExpiresAt,
        finalOutcome: r.finalOutcome,
        metrics: {
          wallClockMs: r.metrics.wallClockMs,
          stepCount: r.metrics.stepCount,
          toolCallCount: r.metrics.toolCallCount,
        },
        createdAt: r.createdAt,
        completedAt: r.completedAt,
        fetchError: undefined,
        lastRefreshedAt: new Date().toISOString(),
      };

      // Check cancellation state:
      // If cancellation was requested and run is now CANCELLED, confirm stopped
      const currentCancel = this.state.cancellation[runId];
      let updatedCancel = this.state.cancellation;
      if (currentCancel && currentCancel.phase === "requested" && r.status === "CANCELLED") {
        updatedCancel = {
          ...this.state.cancellation,
          [runId]: {
            ...currentCancel,
            phase: "confirmed_stopped",
            message: "Cancellation confirmed: run transitioned to CANCELLED",
          },
        };
      }

      // Sync task status in local history if matching task exists
      const taskIdx = this.state.tasks.findIndex((t) => t.taskId === r.taskId);
      let updatedTasks = this.state.tasks;
      if (taskIdx >= 0) {
        const existingTask = this.state.tasks[taskIdx];
        if (existingTask && (existingTask.status !== r.status || existingTask.runId !== r.runId)) {
          const newTasks = [...this.state.tasks];
          newTasks[taskIdx] = {
            ...existingTask,
            status: r.status,
            runId: r.runId,
            updatedAt: r.completedAt || new Date().toISOString(),
          };
          updatedTasks = newTasks;
        }
      }

      this.updateState((prev) => ({
        connectionStatus: "connected",
        connectionError: undefined,
        selectedRun: runEntry,
        runsById: {
          ...(prev.runsById ?? {}),
          [runEntry.runId]: runEntry,
        },
        cancellation: updatedCancel,
        tasks: updatedTasks,
      }));

      return runEntry;
    } catch (err) {
      const errorMsg = (err as Error)?.message ?? "Failed to refresh run";
      if (this.state.selectedRun && this.state.selectedRun.runId === runId) {
        this.updateState({
          selectedRun: {
            ...this.state.selectedRun,
            fetchError: errorMsg,
            lastRefreshedAt: new Date().toISOString(),
          },
        });
      }
      this.handleConnectionError(err);
      throw err;
    }
  }

  /**
   * Cancels an in-flight run following the 3-phase cancellation workflow:
   * 1. requesting -> 2. requested -> 3. confirmed_stopped
   */
  async cancelRun(
    runId: string,
    reason: string,
    options: RequestOptions = {}
  ): Promise<CancelRunResponse> {
    if (!reason || reason.trim().length === 0) {
      throw new Error("Cancellation reason is required.");
    }

    const trimmedReason = reason.trim();
    const reqTimestamp = new Date().toISOString();

    // Phase 1: requesting
    this.updateState((prev) => ({
      cancellation: {
        ...prev.cancellation,
        [runId]: {
          phase: "requesting",
          reason: trimmedReason,
          requestedAt: reqTimestamp,
        },
      },
    }));

    try {
      const response = await this.client.cancelRun(runId, { reason: trimmedReason }, options);
      const cancelData = response.data;

      // Phase 2: requested
      this.updateState((prev) => ({
        cancellation: {
          ...prev.cancellation,
          [runId]: {
            phase: "requested",
            reason: trimmedReason,
            message: cancelData.note ?? `Run cancellation requested for ${runId}`,
            requestedAt: reqTimestamp,
          },
        },
        connectionStatus: "connected",
      }));

      // Immediately query run state to determine if it has already reached CANCELLED
      try {
        const runRes = await this.client.getRun(runId, options);
        if (runRes.data.status === "CANCELLED") {
          // Sync corresponding task status in local history
          const taskIdx = this.state.tasks.findIndex((t) => t.taskId === runRes.data.taskId);
          let updatedTasks = this.state.tasks;
          if (taskIdx >= 0) {
            const existingTask = this.state.tasks[taskIdx];
            if (existingTask) {
              const newTasks = [...this.state.tasks];
              newTasks[taskIdx] = {
                ...existingTask,
                status: "CANCELLED",
                updatedAt: runRes.data.completedAt || new Date().toISOString(),
              };
              updatedTasks = newTasks;
            }
          }

          // Sync selectedRun status if it matches cancelled run
          let updatedSelectedRun = this.state.selectedRun;
          if (updatedSelectedRun && updatedSelectedRun.runId === runId) {
            updatedSelectedRun = {
              ...updatedSelectedRun,
              status: "CANCELLED",
              finalOutcome: runRes.data.finalOutcome,
              completedAt: runRes.data.completedAt,
              metrics: runRes.data.metrics,
              lastRefreshedAt: new Date().toISOString(),
            };
          }

          const prevMappedRun = this.state.runsById?.[runId];
          const updatedMappedRun: LocalRunEntry | undefined =
            updatedSelectedRun && updatedSelectedRun.runId === runId
              ? updatedSelectedRun
              : prevMappedRun
              ? {
                  ...prevMappedRun,
                  status: "CANCELLED",
                  finalOutcome: runRes.data.finalOutcome,
                  completedAt: runRes.data.completedAt,
                  metrics: runRes.data.metrics,
                  lastRefreshedAt: new Date().toISOString(),
                }
              : undefined;

          // Phase 3: confirmed_stopped
          this.updateState({
            cancellation: {
              ...this.state.cancellation,
              [runId]: {
                phase: "confirmed_stopped",
                reason: trimmedReason,
                message: "Cancellation confirmed: run transitioned to CANCELLED",
                requestedAt: reqTimestamp,
              },
            },
            tasks: updatedTasks,
            selectedRun: updatedSelectedRun,
            ...(updatedMappedRun
              ? {
                  runsById: {
                    ...(this.state.runsById ?? {}),
                    [runId]: updatedMappedRun,
                  },
                }
              : {}),
          });
        }
      } catch {
        // If immediate getRun query fails, remain in "requested" phase awaiting subsequent refresh
      }

      return response;
    } catch (err) {
      const errorMsg = (err as Error)?.message ?? "Cancellation request failed";
      this.updateState((prev) => ({
        cancellation: {
          ...prev.cancellation,
          [runId]: {
            phase: "failed",
            reason: trimmedReason,
            error: errorMsg,
            requestedAt: reqTimestamp,
          },
        },
      }));
      this.handleConnectionError(err);
      throw err;
    }
  }

  /**
   * Concurrently refreshes all tasks in the local session history.
   */
  async refreshAll(options: RequestOptions = {}): Promise<void> {
    const taskIds = this.state.tasks.map((t) => t.taskId);
    await Promise.allSettled(taskIds.map((id) => this.refreshTask(id, options)));
    if (this.state.selectedRun?.runId) {
      await this.refreshRun(this.state.selectedRun.runId, options).catch(() => {});
    }
  }

  /**
   * Computes dashboard summary statistics across local tasks and known runs.
   */
  getSummary() {
    return summarizeDashboardState(this.state);
  }

  /**
   * Resets the client session history.
   */
  clearHistory(): void {
    if (this.activeSseClient) {
      this.activeSseClient.abort();
      this.activeSseClient = undefined;
    }
    if (this.activeArtifactsAbortController) {
      this.activeArtifactsAbortController.abort();
      this.activeArtifactsAbortController = undefined;
    }
    if (this.activeArtifactPreviewAbortController) {
      this.activeArtifactPreviewAbortController.abort();
      this.activeArtifactPreviewAbortController = undefined;
    }
    this.activeRunId = undefined;
    this.activeArtifactsRunId = undefined;
    this.activeArtifactPreviewId = undefined;
    this.updateState({
      tasks: [],
      selectedTaskId: undefined,
      selectedRun: undefined,
      runsById: {},
      lastSubmittedTaskId: undefined,
      lastSubmissionError: undefined,
      sseConnectionStatus: "idle",
      sseError: undefined,
      sseEventCount: 0,
      lastEventSequence: 0,
      timelineSteps: [],
      rawEvents: [],
      artifacts: [],
      artifactsLoading: false,
      artifactsError: undefined,
      selectedArtifactId: undefined,
      artifactPreview: null,
      artifactPreviewLoading: false,
      artifactPreviewError: undefined,
      completedVerifications: [],
      rejections: [],
      unverifiedOverrides: [],
      recordedEvidence: [],
    });
  }

  /**
   * Loads artifact metadata for a specified run.
   * Employs an AbortController to cleanly abort obsolete requests on task/run switching.
   */
  async loadArtifacts(runId: string, options: RequestOptions = {}): Promise<readonly ArtifactRecord[]> {
    if (this.activeArtifactsAbortController) {
      this.activeArtifactsAbortController.abort();
      this.activeArtifactsAbortController = undefined;
    }

    this.activeArtifactsRunId = runId;
    const abortCtrl = new AbortController();
    this.activeArtifactsAbortController = abortCtrl;

    this.updateState({
      artifactsLoading: true,
      artifactsError: undefined,
      selectedArtifactId: undefined,
      artifactPreview: null,
      artifactPreviewLoading: false,
      artifactPreviewError: undefined,
    });

    try {
      const response = await this.client.getArtifacts(runId, {
        ...options,
        signal: abortCtrl.signal,
      });

      if (this.activeArtifactsRunId === runId && !abortCtrl.signal.aborted) {
        this.updateState({
          artifacts: response.data,
          artifactsLoading: false,
          artifactsError: undefined,
        });
        return response.data;
      }
      return [];
    } catch (err) {
      if (abortCtrl.signal.aborted || (err as any)?.name === "AbortError" || (err as any)?.statusCode === 499) {
        // Obsolete or aborted request; do not mutate state
        return [];
      }
      if (this.activeArtifactsRunId === runId) {
        const errorMsg = (err as Error)?.message ?? "Failed to load artifacts";
        this.updateState({
          artifacts: [],
          artifactsLoading: false,
          artifactsError: errorMsg,
        });
        this.handleConnectionError(err);
      }
      throw err;
    } finally {
      if (this.activeArtifactsAbortController === abortCtrl) {
        this.activeArtifactsAbortController = undefined;
      }
    }
  }

  /**
   * Selects an artifact for inspection and fetches its bounded text/diff preview when a runId is active.
   */
  selectArtifact(artifactId: string | undefined): void {
    if (this.activeArtifactPreviewAbortController) {
      this.activeArtifactPreviewAbortController.abort();
      this.activeArtifactPreviewAbortController = undefined;
    }
    this.activeArtifactPreviewId = artifactId;

    if (!artifactId) {
      this.updateState({
        selectedArtifactId: undefined,
        artifactPreview: null,
        artifactPreviewLoading: false,
        artifactPreviewError: undefined,
      });
      return;
    }

    const selectedTask = this.state.selectedTaskId
      ? this.state.tasks.find((t) => t.taskId === this.state.selectedTaskId)
      : undefined;
    const targetRunId = this.state.selectedRun?.runId ?? selectedTask?.runId;

    if (!targetRunId) {
      this.updateState({
        selectedArtifactId: artifactId,
        artifactPreview: null,
        artifactPreviewLoading: false,
        artifactPreviewError: undefined,
      });
      return;
    }

    const abortCtrl = new AbortController();
    this.activeArtifactPreviewAbortController = abortCtrl;
    this.updateState({
      selectedArtifactId: artifactId,
      artifactPreview: null,
      artifactPreviewLoading: true,
      artifactPreviewError: undefined,
    });

    void this.fetchArtifactPreview(targetRunId, artifactId, abortCtrl);
  }

  private async fetchArtifactPreview(
    runId: string,
    artifactId: string,
    abortCtrl: AbortController
  ): Promise<void> {
    try {
      const preview = await this.client.getArtifactContent(runId, artifactId, {
        signal: abortCtrl.signal,
      });
      if (
        abortCtrl.signal.aborted ||
        this.activeArtifactPreviewId !== artifactId ||
        this.state.selectedArtifactId !== artifactId
      ) {
        return;
      }
      this.updateState({
        artifactPreview: preview,
        artifactPreviewLoading: false,
        artifactPreviewError: undefined,
      });
    } catch (err) {
      if (abortCtrl.signal.aborted || (err as any)?.name === "AbortError") {
        return;
      }
      if (
        this.activeArtifactPreviewId === artifactId &&
        this.state.selectedArtifactId === artifactId
      ) {
        const errorMsg = (err as Error)?.message ?? "Failed to load artifact content preview";
        this.updateState({
          artifactPreview: null,
          artifactPreviewLoading: false,
          artifactPreviewError: errorMsg,
        });
        this.handleConnectionError(err);
      }
    } finally {
      if (this.activeArtifactPreviewAbortController === abortCtrl) {
        this.activeArtifactPreviewAbortController = undefined;
      }
    }
  }

  /**
   * Connects to the SSE execution event stream for the specified run.
   * If an active stream exists for another run, it is aborted and its event buffer cleared.
   */
  startEventStream(runId: string): void {
    if (this.activeRunId === runId && this.activeSseClient && this.activeSseClient.isConnected()) {
      return;
    }

    // Teardown previous stream
    if (this.activeSseClient) {
      this.activeSseClient.abort();
      this.activeSseClient = undefined;
    }

    this.activeRunId = runId;

    // Clear stale events for the new run
    this.updateState({
      sseConnectionStatus: "connecting",
      sseError: undefined,
      sseEventCount: 0,
      lastEventSequence: 0,
      timelineSteps: [],
      rawEvents: [],
    });

    const sseClient = this.client.openEventStream(runId, {
      onEvent: (envelope) => {
        this.handleSseEvent(envelope);
      },
      onStatusChange: (status, err) => {
        this.updateState({
          sseConnectionStatus: status,
          sseError: err?.message,
        });
      },
      onGap: () => {
        // Gap detected: non-fatal warning
      },
      onControlEvent: () => {
        // Transport control event handled
      },
      onTerminal: () => {
        // Terminal run event received: optionally refresh run details one final time
        void this.refreshRun(runId).catch(() => {});
      },
      onError: (err) => {
        this.updateState({ sseError: err.message });
      },
    });

    this.activeSseClient = sseClient;
    void sseClient.connect();
  }

  /**
   * Internal processor for incoming SSE event envelopes.
   */
  private handleSseEvent(envelope: SseEventEnvelope): void {
    // 1. Maintain bounded event queue (max 500 events)
    let events = [...(this.state.rawEvents ?? []), envelope];
    if (events.length > this.maxBufferedEvents) {
      events = events.slice(events.length - this.maxBufferedEvents);
    }

    // 2. Compute timeline steps
    const timelineSteps = buildTimelineSteps(events);

    // 3. Extract verification & evidence data
    let newCompletedVerifications = this.state.completedVerifications ?? [];
    let newRejections = this.state.rejections ?? [];
    let newUnverifiedOverrides = this.state.unverifiedOverrides ?? [];
    let newRecordedEvidence = this.state.recordedEvidence ?? [];

    const rawData = (envelope.data ?? {}) as Record<string, unknown>;

    if (envelope.event === "verification.completed") {
      const v: VerificationCompletedView = {
        verifierId: String(rawData.verifierId ?? envelope.producer ?? "verifier"),
        specId: String(rawData.specId ?? "spec"),
        status: rawData.status === "VERIFIED" ? "VERIFIED" : "FAILED",
        evidenceIds: Array.isArray(rawData.evidenceIds) ? rawData.evidenceIds.map(String) : [],
        reasonCode: rawData.reasonCode ? String(rawData.reasonCode) : undefined,
        message: String(rawData.message ?? "Verification check completed"),
        details: rawData.details && typeof rawData.details === "object" ? (rawData.details as Record<string, unknown>) : undefined,
        verifiedAt: String(rawData.verifiedAt ?? envelope.timestamp),
      };
      newCompletedVerifications = [...newCompletedVerifications, v];
    } else if (envelope.event === "verification.rejected") {
      const r: VerificationRejectedView = {
        status: "COMPLETION_REJECTED",
        reason: "UNVERIFIED_COMPLETION_CLAIM",
        message: String(rawData.message ?? "Completion claim rejected"),
        requirements: rawData.requirements && typeof rawData.requirements === "object" ? (rawData.requirements as Record<string, string>) : {},
        outstandingRequirements: Array.isArray(rawData.outstandingRequirements) ? rawData.outstandingRequirements.map(String) : [],
        rejectedAt: String(rawData.rejectedAt ?? envelope.timestamp),
      };
      newRejections = [...newRejections, r];
    } else if (envelope.event === "verification.unverified_completion_authorized") {
      const u: UnverifiedCompletionAuthorizedView = {
        authorizedAt: String(rawData.authorizedAt ?? envelope.timestamp),
        operatorNote: rawData.operatorNote ? String(rawData.operatorNote) : undefined,
      };
      newUnverifiedOverrides = [...newUnverifiedOverrides, u];
    } else if (envelope.event === "evidence.recorded") {
      const e: RecordedEvidenceView = {
        evidenceId: String(rawData.evidenceId ?? envelope.id),
        runId: String(rawData.runId ?? envelope.runId),
        source: rawData.source === "INDEPENDENT_OBSERVER" ? "INDEPENDENT_OBSERVER" : "PROVIDER_REPORTED",
        kind: String(rawData.kind ?? "evidence"),
        contentHash: String(rawData.contentHash ?? ""),
        summary: rawData.summary && typeof rawData.summary === "object" ? (rawData.summary as Record<string, unknown>) : undefined,
        observedAt: String(rawData.observedAt ?? envelope.timestamp),
      };
      newRecordedEvidence = [...newRecordedEvidence, e];
    } else if (
      (envelope.event === "workspace.disposed" ||
        envelope.event === "run.completed" ||
        (envelope.event === "workspace.cleaning" && Boolean(rawData.artifactExport))) &&
      this.activeRunId === envelope.runId
    ) {
      // Re-query artifacts when workspace disposal or run completion confirms that artifact export has finished
      void this.loadArtifacts(envelope.runId).catch(() => {});
    }

    // 4. Update state
    this.updateState({
      rawEvents: events,
      timelineSteps,
      sseEventCount: (this.state.sseEventCount ?? 0) + 1,
      lastEventSequence: envelope.sequence,
      completedVerifications: newCompletedVerifications,
      rejections: newRejections,
      unverifiedOverrides: newUnverifiedOverrides,
      recordedEvidence: newRecordedEvidence,
    });

    // 5. If this is a terminal or status-changing event, sync run state
    if (
      envelope.event === "run.completed" ||
      envelope.event === "run.failed" ||
      envelope.event === "run.cancelled" ||
      envelope.event === "run.timed_out"
    ) {
      const terminalStatus: TaskStatus =
        envelope.event === "run.completed"
          ? "COMPLETED"
          : envelope.event === "run.failed"
          ? "FAILED"
          : envelope.event === "run.cancelled"
          ? "CANCELLED"
          : "TIMED_OUT";

      // Sync selectedRun and runsById if matches
      const updatedRunFromSelected =
        this.state.selectedRun && this.state.selectedRun.runId === envelope.runId
          ? {
              ...this.state.selectedRun,
              status: terminalStatus,
              completedAt: envelope.timestamp,
              lastRefreshedAt: new Date().toISOString(),
            }
          : undefined;
      const prevMapped = this.state.runsById?.[envelope.runId];
      const updatedMapped = updatedRunFromSelected
        ? updatedRunFromSelected
        : prevMapped
        ? {
            ...prevMapped,
            status: terminalStatus,
            completedAt: envelope.timestamp,
            lastRefreshedAt: new Date().toISOString(),
          }
        : undefined;

      if (updatedRunFromSelected || updatedMapped) {
        this.updateState({
          ...(updatedRunFromSelected ? { selectedRun: updatedRunFromSelected } : {}),
          ...(updatedMapped
            ? {
                runsById: {
                  ...(this.state.runsById ?? {}),
                  [envelope.runId]: updatedMapped,
                },
              }
            : {}),
        });
      }

      // Sync task in tasks list
      const taskIdx = this.state.tasks.findIndex((t) => t.runId === envelope.runId);
      if (taskIdx >= 0) {
        const updated = [...this.state.tasks];
        const prevTask = updated[taskIdx];
        if (prevTask) {
          updated[taskIdx] = {
            ...prevTask,
            status: terminalStatus,
            updatedAt: envelope.timestamp,
          };
          this.updateState({ tasks: updated });
        }
      }
    }
  }

  /**
   * Disconnects the active SSE stream without clearing existing timeline events.
   */
  disconnectSse(): void {
    if (this.activeSseClient) {
      this.activeSseClient.abort();
      this.activeSseClient = undefined;
    }
    this.activeRunId = undefined;
    if (this.state.sseConnectionStatus !== "idle") {
      this.updateState({ sseConnectionStatus: "idle" });
    }
  }

  /**
   * Disposes the controller, aborting any active SSE stream and clearing all listeners.
   */
  dispose(): void {
    if (this.activeHistoryAbortController) {
      this.activeHistoryAbortController.abort();
      this.activeHistoryAbortController = undefined;
    }
    if (this.activeArtifactsAbortController) {
      this.activeArtifactsAbortController.abort();
      this.activeArtifactsAbortController = undefined;
    }
    if (this.activeArtifactPreviewAbortController) {
      this.activeArtifactPreviewAbortController.abort();
      this.activeArtifactPreviewAbortController = undefined;
    }
    this.activeArtifactsRunId = undefined;
    this.activeArtifactPreviewId = undefined;
    this.disconnectSse();
    this.listeners.clear();
  }

  /**
   * Classifies API errors into connection states.
   */
  private handleConnectionError(err: unknown): void {
    if (err instanceof ApiClientError) {
      if (err.statusCode === 503 || err.isTransient) {
        this.updateState({ connectionStatus: "unavailable", connectionError: err.message });
      } else if (err.statusCode === 401 || err.statusCode === 403) {
        this.updateState({
          connectionStatus: "error",
          connectionError: err.message,
          auth: {
            ...(this.state.auth ?? { isAuthenticating: false }),
            authenticated: false,
            isAuthenticating: false,
            hasToken: this.state.auth?.hasToken ?? false,
            authError: err.message,
          },
        });
      }
    }
  }
}
