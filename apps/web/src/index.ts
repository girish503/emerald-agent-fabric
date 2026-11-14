/**
 * Emerald Agent Fabric — Web Frontend Module Exports (Milestone 2.27)
 */

export {
  mountDashboardApp,
  type AppMountOptions,
  type MountedApp,
  type DOMElement,
} from "./app.js";

export {
  DashboardController,
  type DashboardState,
  type DashboardListener,
  type AuthState,
  type LocalTaskEntry,
  type LocalRunEntry,
  type CancellationState,
  type CancellationPhase,
  type ConnectionStatus,
  type TaskSubmissionFormState,
} from "./components/dashboard-controller.js";

export {
  renderDashboardHtml,
  renderAuthGatePanel,
  renderTaskSubmissionForm,
  renderTaskList,
  renderTaskItem,
  renderSelectedTaskDetails,
  renderCancellationControls,
  renderConnectionStatusBadge,
  renderSummaryCards,
  renderSseConnectionBadge,
  renderExecutionTimeline,
  escapeHtml,
} from "./components/dashboard-view.js";

export {
  buildTimelineSteps,
  isLegacyTimelineEvent,
  formatOutcomeBadge,
  computeDashboardSummary,
  summarizeDashboardState,
  formatTaskStatusBadge,
  formatExecutionModeBadge,
  validateTaskSubmissionInput,
  type TimelineStepView,
  type OutcomeBadge,
} from "./components/workspace-views.js";

export {
  renderArtifactViewer,
  categorizeArtifact,
  formatByteSize,
  formatShortSha,
  type ArtifactCategory,
  type ArtifactCategoryInfo,
  type ArtifactViewerRenderOptions,
} from "./components/artifact-viewer.js";

export {
  renderEvidenceViewer,
  type VerificationCompletedView,
  type VerificationRejectedView,
  type UnverifiedCompletionAuthorizedView,
  type RecordedEvidenceView,
  type EvidenceViewerState,
} from "./components/evidence-viewer.js";

export {
  EmeraldApiClient,
  ApiClientError,
  type ApiClientConfig,
  type RequestOptions,
} from "./client/api-client.js";

export {
  EmeraldSseClient,
  SseLineParser,
  type SseClientConfig,
  type SseConnectionStatus,
  type SseRawFrame,
  type StreamOverflowPayload,
  type StreamErrorPayload,
} from "./client/sse-client.js";

export type {
  TrialFinalOutcome,
  TaskStatus,
  ExecutionMode,
  CreateTaskRequest,
  TaskResponse,
  RunResponse,
  CancelRunRequest,
  CancelRunResponse,
  ArtifactResponse,
  ListArtifactsResponse,
  ApiErrorResponse,
  ApiErrorCode,
  TaskRecord,
  RunRecord,
  CreateTaskInput,
  SseEventEnvelope,
  WhoamiIdentity,
  WhoamiResponse,
  ArtifactContentResponse,
} from "./types/api.js";

export {
  SSE_EVENT_TYPES,
  SSE_TERMINAL_EVENT_TYPES,
  SSE_CONTROL_EVENT_TYPES,
} from "./types/api.js";

import { mountDashboardApp, type DOMElement } from "./app.js";
import { EmeraldApiClient } from "./client/api-client.js";

/**
 * CSP-safe browser entry point invoked by dist/bundle.js when loaded in a DOM environment.
 */
export function bootstrapBrowserDashboard(): void {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return;
  }

  const mountTarget = () => {
    const container = document.getElementById("app") as unknown as DOMElement | null;
    if (!container) return;
    if (typeof container.querySelector === "function" && container.querySelector(".emerald-dashboard-app")) {
      return;
    }
    const apiClient = new EmeraldApiClient({
      baseUrl: window.location.origin,
    });
    mountDashboardApp({
      container,
      apiClient,
      autoLoadHistory: false,
    });
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mountTarget);
  } else {
    mountTarget();
  }
}

bootstrapBrowserDashboard();
