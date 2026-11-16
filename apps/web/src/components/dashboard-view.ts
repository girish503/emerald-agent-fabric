/**
 * Emerald Agent Fabric — Dashboard View Renderer (Milestone 2.27 / Phase 2)
 *
 * Implements pure functional HTML rendering for:
 * - Connection and backend API status banner
 * - Governed task submission form with client validation feedback
 * - Local session task history list and status badges
 * - Selected task and run details drawer with authoritative outcome badges
 * - 3-phase run cancellation controls and state indicator
 *
 * Security & Ergonomics:
 * - HTML escaping applied to all dynamic content (defense against XSS)
 * - Clear disclosure notices for local session storage and sandboxed execution
 */

import type {
  DashboardState,
  LocalTaskEntry,
  LocalRunEntry,
  CancellationState,
  ConnectionStatus,
} from "./dashboard-controller.js";
import {
  formatTaskStatusBadge,
  formatOutcomeBadge,
  formatExecutionModeBadge,
  summarizeDashboardState,
  type TimelineStepView,
} from "./workspace-views.js";
import { renderArtifactViewer } from "./artifact-viewer.js";
import { renderEvidenceViewer } from "./evidence-viewer.js";
import type { SseConnectionStatus } from "../client/sse-client.js";

/**
 * Escapes HTML control characters in dynamic strings to prevent injection.
 */
export function escapeHtml(unsafe: string | null | undefined): string {
  if (unsafe == null) return "";
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/**
 * Renders the connection status badge.
 */
export function renderConnectionStatusBadge(status: ConnectionStatus, error?: string): string {
  let badgeColor = "gray";
  let label = "Idle";
  let description = "No requests sent yet";

  switch (status) {
    case "connected":
      badgeColor = "green";
      label = "Connected";
      description = "Backend REST API reachable";
      break;
    case "error":
      badgeColor = "red";
      label = "Auth / Client Error";
      description = error ? escapeHtml(error) : "Unauthorized or forbidden request";
      break;
    case "unavailable":
      badgeColor = "yellow";
      label = "Service Unavailable";
      description = error ? escapeHtml(error) : "Backend service or network unreachable";
      break;
    case "idle":
    default:
      badgeColor = "gray";
      label = "Idle";
      description = "Ready to connect";
      break;
  }

  return `
    <div class="connection-status-badge badge-${badgeColor}" id="connection-status-badge" role="status" aria-live="polite" title="${escapeHtml(description)}">
      <span class="status-dot"></span>
      <span class="status-label">${escapeHtml(label)}</span>
    </div>
  `.trim();
}

/**
 * Renders the SSE execution stream connection badge.
 */
export function renderSseConnectionBadge(
  status: SseConnectionStatus,
  eventCount: number,
  lastSequence: number,
  error?: string
): string {
  let badgeColor = "gray";
  let label = "Stream Idle";
  let description = "Event stream not started";

  switch (status) {
    case "connected":
      badgeColor = "green";
      label = `Live (${eventCount} events, seq ${lastSequence})`;
      description = `Connected to live SSE execution stream. Sequence: ${lastSequence}`;
      break;
    case "connecting":
      badgeColor = "blue";
      label = "Connecting Stream...";
      description = "Establishing SSE event stream connection";
      break;
    case "reconnecting":
      badgeColor = "yellow";
      label = `Reconnecting... (seq ${lastSequence})`;
      description = error ? `Reconnecting: ${error}` : `Reconnecting stream from sequence ${lastSequence}`;
      break;
    case "error":
      badgeColor = "red";
      label = "Stream Error";
      description = error ? `Stream error: ${error}` : "SSE connection failed";
      break;
    case "unavailable":
      badgeColor = "yellow";
      label = "Stream Unavailable";
      description = error ? `Stream unavailable: ${error}` : "SSE endpoint unreachable";
      break;
    case "idle":
    default:
      badgeColor = "gray";
      label = "Stream Idle";
      description = "Execution stream idle";
      break;
  }

  return `
    <div class="sse-status-badge badge-${badgeColor}" id="sse-status-badge" role="status" aria-live="polite" title="${escapeHtml(description)}">
      <span class="status-dot"></span>
      <span class="sse-status-label">${escapeHtml(label)}</span>
    </div>
  `.trim();
}

/**
 * Renders the dashboard metrics summary cards.
 */
export function renderSummaryCards(state: DashboardState): string {
  const summary = summarizeDashboardState(state);
  const verifiedPercent = Math.round(summary.verifiedRate * 100);

  return `
    <div class="dashboard-summary-grid">
      <div class="summary-card">
        <span class="summary-label">Total Tasks</span>
        <span class="summary-value" id="summary-total-tasks">${summary.totalTasks}</span>
      </div>
      <div class="summary-card">
        <span class="summary-label">Running Runs</span>
        <span class="summary-value" id="summary-running-runs">${summary.runningRuns}</span>
      </div>
      <div class="summary-card">
        <span class="summary-label">Completed Runs</span>
        <span class="summary-value" id="summary-completed-runs">${summary.completedRuns}</span>
      </div>
      <div class="summary-card">
        <span class="summary-label">Verified Successes</span>
        <span class="summary-value color-green" id="summary-verified-successes">${summary.verifiedSuccesses}</span>
      </div>
      <div class="summary-card">
        <span class="summary-label">False Completions</span>
        <span class="summary-value color-red" id="summary-false-completions">${summary.falseCompletions}</span>
      </div>
      <div class="summary-card">
        <span class="summary-label">Verified Rate</span>
        <span class="summary-value" id="summary-verified-rate">${verifiedPercent}%</span>
      </div>
    </div>
  `.trim();
}

/**
 * Renders the task submission form.
 */
export function renderTaskSubmissionForm(state: DashboardState): string {
  const isSubmitting = state.isSubmitting;
  const hasError = Boolean(state.lastSubmissionError);
  const errorBanner = state.lastSubmissionError
    ? `<div class="error-banner" role="alert" id="task-submission-error">${escapeHtml(state.lastSubmissionError)}</div>`
    : "";
  const errorAttrs = hasError ? ' aria-invalid="true" aria-describedby="task-submission-error"' : "";

  return `
    <section class="task-submission-section" aria-labelledby="form-heading">
      <div class="section-header">
        <h2 id="form-heading">Submit Governed Task</h2>
        <span class="badge badge-green">Execution Mode: Sandboxed (OCI/Docker)</span>
      </div>
      ${errorBanner}
      <form id="task-submission-form" class="task-form">
        <div class="form-group">
          <label for="task-title-input">Task Title <span class="required">*</span></label>
          <input
            type="text"
            id="task-title-input"
            name="title"
            required
            aria-required="true"
            maxlength="256"
            placeholder="e.g. Implement parser error recovery"
            ${isSubmitting ? "disabled" : ""}${errorAttrs}
          />
        </div>

        <div class="form-group">
          <label for="task-prompt-input">Task Prompt / Instructions <span class="required">*</span></label>
          <textarea
            id="task-prompt-input"
            name="prompt"
            required
            aria-required="true"
            rows="4"
            maxlength="65536"
            placeholder="Specific instructions for the autonomous agent..."
            ${isSubmitting ? "disabled" : ""}${errorAttrs}
          ></textarea>
        </div>

        <div class="form-row">
          <div class="form-group form-group-half">
            <label for="task-model-input">Model Name</label>
            <input
              type="text"
              id="task-model-input"
              name="modelName"
              value="qwen2.5-coder:7b"
              placeholder="e.g. qwen2.5-coder:7b"
              ${isSubmitting ? "disabled" : ""}
            />
          </div>
          <div class="form-group form-group-half">
            <label for="task-provider-input">Model Provider</label>
            <input
              type="text"
              id="task-provider-input"
              name="provider"
              value="ollama"
              placeholder="ollama"
              ${isSubmitting ? "disabled" : ""}
            />
          </div>
        </div>

        <div class="form-row">
          <div class="form-group form-group-half">
            <label for="task-repo-input">Repository Path (Optional)</label>
            <input
              type="text"
              id="task-repo-input"
              name="repoPath"
              placeholder="/workspace/target-repo"
              ${isSubmitting ? "disabled" : ""}
            />
          </div>
          <div class="form-group form-group-half">
            <label for="task-timeout-input">Timeout (Seconds)</label>
            <input
              type="number"
              id="task-timeout-input"
              name="timeoutSeconds"
              value="600"
              min="10"
              max="7200"
              ${isSubmitting ? "disabled" : ""}
            />
          </div>
        </div>

        <div class="form-actions">
          <button
            type="submit"
            id="task-submit-button"
            class="button button-primary"
            ${isSubmitting ? "disabled" : ""}
          >
            ${isSubmitting ? '<span class="spinner"></span> Submitting...' : "Submit Governed Task"}
          </button>
        </div>
      </form>
    </section>
  `.trim();
}

/**
 * Renders an individual task row item.
 */
export function renderTaskItem(task: LocalTaskEntry, isSelected: boolean): string {
  const statusBadge = formatTaskStatusBadge(task.status);
  const modeBadge = formatExecutionModeBadge(task.executionMode);
  const selectedClass = isSelected ? "task-item-selected" : "";
  const errorNotice = task.fetchError
    ? `<div class="task-item-error" title="${escapeHtml(task.fetchError)}">Sync warning: ${escapeHtml(task.fetchError)}</div>`
    : "";
  const runIdMeta = task.runId
    ? `<span class="task-run-id font-mono">Run: ${escapeHtml(task.runId)}</span>`
    : "";
  const updatedAtMeta =
    task.updatedAt && task.updatedAt !== task.createdAt
      ? `<span class="task-updated-time">Updated: ${escapeHtml(task.updatedAt)}</span>`
      : "";

  return `
    <li class="task-item ${selectedClass}" data-task-id="${escapeHtml(task.taskId)}">
      <div class="task-item-header">
        <button class="task-select-trigger" data-action="select" data-task-id="${escapeHtml(task.taskId)}">
          <span class="task-title">${escapeHtml(task.title)}</span>
        </button>
        <button class="task-refresh-btn" data-action="refresh-task" data-task-id="${escapeHtml(task.taskId)}" title="Refresh task status">
          Refresh
        </button>
        <span class="badge badge-${statusBadge.color}" title="${escapeHtml(statusBadge.description)}">
          ${escapeHtml(statusBadge.label)}
        </span>
      </div>
      <div class="task-item-meta">
        <span class="task-id font-mono">ID: ${escapeHtml(task.taskId)}</span>
        ${runIdMeta}
        <span class="badge badge-${modeBadge.color}">${escapeHtml(modeBadge.label)}</span>
        <span class="task-time">${escapeHtml(task.createdAt)}</span>
        ${updatedAtMeta}
      </div>
      ${errorNotice}
    </li>
  `.trim();
}

/**
 * Renders the server-backed task history list with status filtering and cursor pagination.
 */
export function renderTaskList(state: DashboardState): string {
  const currentFilter = state.statusFilter ?? "ALL";
  const filterOptions = [
    { value: "ALL", label: "All Statuses" },
    { value: "CREATED", label: "CREATED" },
    { value: "QUEUED", label: "QUEUED" },
    { value: "LEASED", label: "LEASED" },
    { value: "RUNNING", label: "RUNNING" },
    { value: "VERIFYING", label: "VERIFYING" },
    { value: "WAITING_APPROVAL", label: "WAITING_APPROVAL" },
    { value: "COMPLETED", label: "COMPLETED" },
    { value: "FAILED", label: "FAILED" },
    { value: "CANCELLED", label: "CANCELLED" },
    { value: "TIMED_OUT", label: "TIMED_OUT" },
    { value: "RECOVERING", label: "RECOVERING" },
  ];

  const filterSelectHtml = `
    <div class="task-history-controls">
      <div class="filter-group">
        <label for="task-status-filter" class="filter-label">Status Filter:</label>
        <select id="task-status-filter" data-action="filter-status" class="status-select" aria-label="Filter tasks by status">
          ${filterOptions
            .map(
              (opt) =>
                `<option value="${escapeHtml(opt.value)}" ${opt.value === currentFilter ? "selected" : ""}>${escapeHtml(opt.label)}</option>`
            )
            .join("")}
        </select>
      </div>
      <button class="task-refresh-history-btn" id="refresh-history-btn" data-action="refresh-history" aria-label="Refresh task history" title="Refresh task history">
        ↻ Refresh History
      </button>
    </div>
  `.trim();

  let contentHtml = "";
  if (state.tasks.length === 0) {
    const errorNotice = state.historyError
      ? `
        <div class="task-history-error" id="task-history-error" role="alert">
          <p>Sync notice: ${escapeHtml(state.historyError)}</p>
          <button class="retry-btn" id="task-history-retry-btn" data-action="retry-history">Retry</button>
        </div>
      `.trim()
      : "";

    const loadingNotice = state.isHistoryLoading
      ? `
        <div class="task-history-loading" id="task-history-loading" role="status" aria-live="polite" aria-busy="true">
          <span class="loading-spinner"></span>
          <span>Loading governed task history...</span>
        </div>
      `.trim()
      : "";

    contentHtml = `
      <div class="empty-state" id="task-list-empty">
        <p>No tasks submitted in this session.</p>
        <p class="empty-subtitle">Submit a governed task using the form above or select a different filter.</p>
      </div>
      ${errorNotice}
      ${loadingNotice}
    `.trim();
  } else {
    const itemsHtml = state.tasks
      .map((task) => renderTaskItem(task, task.taskId === state.selectedTaskId))
      .join("\n");

    let paginationHtml = "";
    if (state.isHistoryLoading) {
      paginationHtml = `
        <div class="task-pagination-loading" id="task-pagination-loading" role="status" aria-live="polite" aria-busy="true">
          <span class="loading-spinner"></span>
          <span>Loading more tasks...</span>
        </div>
      `.trim();
    } else if (state.nextCursor) {
      paginationHtml = `
        <div class="task-pagination-controls">
          <button id="load-more-tasks-btn" data-action="load-more" class="load-more-btn" aria-label="Load more tasks">
            Load More Tasks
          </button>
        </div>
      `.trim();
    } else if (state.tasks.length > 0) {
      paginationHtml = `
        <div class="end-of-history-notice" id="end-of-history-notice" role="status">
          <span>All tasks loaded for current filter.</span>
        </div>
      `.trim();
    }

    if (state.historyError) {
      paginationHtml += `
        <div class="task-history-error" id="task-history-pagination-error" role="alert">
          <span>Failed to load next page: ${escapeHtml(state.historyError)}</span>
          <button class="retry-btn" id="task-history-retry-btn" data-action="retry-history">Retry</button>
        </div>
      `.trim();
    }

    contentHtml = `
      <ul class="task-list" id="task-list" role="list">
        ${itemsHtml}
      </ul>
      ${paginationHtml}
    `.trim();
  }

  return `
    <section class="task-history-section" aria-labelledby="task-history-heading">
      <div class="task-history-header">
        <h2 id="task-history-heading">Governed Tasks History</h2>
        ${filterSelectHtml}
      </div>
      ${contentHtml}
    </section>
  `.trim();
}

/**
 * Renders cancellation controls and 3-phase status.
 */
export function renderCancellationControls(
  run: LocalRunEntry,
  cancellation?: CancellationState
): string {
  const isTerminal =
    run.status === "COMPLETED" ||
    run.status === "FAILED" ||
    run.status === "CANCELLED" ||
    run.status === "TIMED_OUT";

  let statusHtml = "";
  if (cancellation) {
    switch (cancellation.phase) {
      case "requesting":
        statusHtml = `<div class="cancellation-status status-yellow" role="status" aria-live="polite">Cancellation requested... contacting backend</div>`;
        break;
      case "requested":
        statusHtml = `<div class="cancellation-status status-blue" role="status" aria-live="polite">Cancellation request accepted by server. Awaiting worker stop confirmation.</div>`;
        break;
      case "confirmed_stopped":
        statusHtml = `<div class="cancellation-status status-green" role="status" aria-live="polite">Cancellation confirmed: Run has stopped (status: CANCELLED).</div>`;
        break;
      case "failed":
        statusHtml = `<div class="cancellation-status status-red" role="status" aria-live="polite">Cancellation failed: ${escapeHtml(cancellation.error)}</div>`;
        break;
      case "idle":
      default:
        break;
    }
  }

  if (isTerminal) {
    return `
      <div class="run-cancellation-box">
        <span class="terminal-run-notice">Run reached terminal state (${escapeHtml(run.status)}). Cancellation unavailable.</span>
        ${statusHtml}
      </div>
    `.trim();
  }

  const isRequesting = cancellation?.phase === "requesting";

  return `
    <div class="run-cancellation-box" id="run-cancellation-controls">
      <h4>Cancel Execution</h4>
      <div class="cancel-form">
        <input
          type="text"
          id="cancel-reason-input"
          placeholder="Reason for cancellation (required)..."
          ${isRequesting ? "disabled" : ""}
        />
        <button
          type="button"
          id="cancel-run-button"
          class="button button-danger"
          data-run-id="${escapeHtml(run.runId)}"
          ${isRequesting ? "disabled" : ""}
        >
          ${isRequesting ? "Requesting..." : "Cancel Run"}
        </button>
      </div>
      ${statusHtml}
    </div>
  `.trim();
}

/**
 * Renders the live execution timeline.
 */
export function renderExecutionTimeline(steps: readonly TimelineStepView[]): string {
  if (!steps || steps.length === 0) {
    return `
      <div class="execution-timeline-empty" id="execution-timeline-empty">
        <p>Awaiting execution events from live stream...</p>
      </div>
    `.trim();
  }

  const stepsHtml = steps
    .map((step) => {
      const toolCallsHtml = step.toolCalls
        .map((tool) => {
          const approvedClass = tool.approved ? "color-green" : "color-yellow";
          const statusText = tool.approved ? "Authorized" : "Pending / Denied";
          const exitCodeText =
            tool.exitCode !== undefined ? `Exit: ${tool.exitCode}` : "";
          const durationText =
            tool.durationMs !== undefined ? `${tool.durationMs}ms` : "";

          return `
            <div class="timeline-tool-call">
              <div class="tool-call-header">
                <span class="tool-name font-mono">${escapeHtml(tool.toolName)}</span>
                <span class="tool-approval ${approvedClass}">${escapeHtml(statusText)}</span>
                ${durationText ? `<span class="tool-duration">${escapeHtml(durationText)}</span>` : ""}
                ${exitCodeText ? `<span class="tool-exit font-mono">${escapeHtml(exitCodeText)}</span>` : ""}
              </div>
              <pre class="tool-args font-mono">${escapeHtml(JSON.stringify(tool.args, null, 2))}</pre>
            </div>
          `.trim();
        })
        .join("\n");

      return `
        <div class="timeline-step-item" id="timeline-step-${step.stepIndex}">
          <div class="step-header">
            <span class="step-index">Step ${step.stepIndex}</span>
            <span class="step-timestamp font-mono">${escapeHtml(step.timestamp)}</span>
          </div>
          ${step.thought ? `<div class="step-thought">${escapeHtml(step.thought)}</div>` : ""}
          <div class="step-tool-calls">
            ${toolCallsHtml}
          </div>
        </div>
      `.trim();
    })
    .join("\n");

  return `
    <div class="execution-timeline" id="execution-timeline" aria-live="polite" aria-atomic="false">
      <h4>Live Execution Timeline (${steps.length} step${steps.length === 1 ? "" : "s"})</h4>
      <div class="timeline-steps-list">
        ${stepsHtml}
      </div>
    </div>
  `.trim();
}

/**
 * Renders the detail drawer for the currently selected task and run.
 */
export function renderSelectedTaskDetails(state: DashboardState): string {
  if (!state.selectedTaskId) {
    return `
      <div class="empty-state-details" id="task-details-empty">
        <p>Select a task from the session history to inspect its contract, run state, and verification outcome.</p>
      </div>
    `.trim();
  }

  const task = state.tasks.find((t) => t.taskId === state.selectedTaskId);
  if (!task) {
    return `
      <div class="empty-state-details" id="task-details-missing">
        <p>Selected task (ID: <code>${escapeHtml(state.selectedTaskId)}</code>) was not found in local session history.</p>
      </div>
    `.trim();
  }

  const taskStatusBadge = formatTaskStatusBadge(task.status);
  const modeBadge = formatExecutionModeBadge(task.executionMode);
  const sseBadge = renderSseConnectionBadge(
    state.sseConnectionStatus ?? "idle",
    state.sseEventCount ?? 0,
    state.lastEventSequence ?? 0,
    state.sseError
  );
  const timelineHtml = renderExecutionTimeline(state.timelineSteps ?? []);

  let runDetailsHtml = "";
  if (state.selectedRun) {
    const run = state.selectedRun;
    const outcomeBadge = formatOutcomeBadge(run.finalOutcome);
    const cancellation = state.cancellation[run.runId];
    const cancellationControls = renderCancellationControls(run, cancellation);
    const evidenceHtml = renderEvidenceViewer({
      finalOutcome: run.finalOutcome,
      isTerminal:
        run.status === "COMPLETED" ||
        run.status === "FAILED" ||
        run.status === "CANCELLED" ||
        run.status === "TIMED_OUT",
      completedVerifications: state.completedVerifications,
      rejections: state.rejections,
      unverifiedOverrides: state.unverifiedOverrides,
      recordedEvidence: state.recordedEvidence,
    });
    const artifactHtml = renderArtifactViewer({
      artifacts: state.artifacts,
      isLoading: state.artifactsLoading,
      error: state.artifactsError,
      selectedArtifactId: state.selectedArtifactId,
      previewContent: state.artifactPreview,
      previewLoading: state.artifactPreviewLoading,
      previewError: state.artifactPreviewError,
    });

    runDetailsHtml = `
      <div class="run-details-card" id="run-details-card">
        <div class="run-card-header">
          <h3>Run Execution Details</h3>
          ${sseBadge}
        </div>
        <div class="details-grid">
          <div class="detail-row">
            <span class="detail-label">Run ID:</span>
            <span class="detail-value font-mono" id="detail-run-id">${escapeHtml(run.runId)}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Status:</span>
            <span class="detail-value badge badge-${taskStatusBadge.color}">${escapeHtml(run.status)}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Attempt:</span>
            <span class="detail-value">${run.attemptNumber}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Step Index:</span>
            <span class="detail-value">${run.currentStepIndex}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Authoritative Outcome:</span>
            <span class="detail-value badge badge-${outcomeBadge.color}" title="${escapeHtml(outcomeBadge.description)}">
              ${escapeHtml(outcomeBadge.label)}
            </span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Wall Clock:</span>
            <span class="detail-value">${run.metrics.wallClockMs} ms</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Steps Executed:</span>
            <span class="detail-value">${run.metrics.stepCount}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Tool Calls:</span>
            <span class="detail-value">${run.metrics.toolCallCount}</span>
          </div>
        </div>
        ${cancellationControls}
        ${timelineHtml}
        ${evidenceHtml}
        ${artifactHtml}
      </div>
    `.trim();
  } else if (task.runId) {
    const artifactHtml = renderArtifactViewer({
      artifacts: state.artifacts,
      isLoading: state.artifactsLoading,
      error: state.artifactsError,
      selectedArtifactId: state.selectedArtifactId,
      previewContent: state.artifactPreview,
      previewLoading: state.artifactPreviewLoading,
      previewError: state.artifactPreviewError,
    });

    runDetailsHtml = `
      <div class="run-details-loading" id="run-details-loading">
        <p>Loading run details for <code>${escapeHtml(task.runId)}</code>...</p>
        ${sseBadge}
        ${timelineHtml}
        ${artifactHtml}
      </div>
    `.trim();
  } else {
    runDetailsHtml = `
      <div class="run-details-none" id="run-details-none">
        <p>No run assigned yet. Task is currently ${escapeHtml(task.status)}.</p>
      </div>
    `.trim();
  }

  return `
    <div class="task-details-panel" id="task-details-panel">
      <div class="panel-header">
        <h2>${escapeHtml(task.title)}</h2>
        <div class="panel-badges">
          <span class="badge badge-${taskStatusBadge.color}">${escapeHtml(taskStatusBadge.label)}</span>
          <span class="badge badge-${modeBadge.color}">${escapeHtml(modeBadge.label)}</span>
        </div>
      </div>

      <div class="details-grid">
        <div class="detail-row">
          <span class="detail-label">Task ID:</span>
          <span class="detail-value font-mono">${escapeHtml(task.taskId)}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Contract ID:</span>
          <span class="detail-value font-mono">${escapeHtml(task.contractId ?? "N/A")}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Created:</span>
          <span class="detail-value">${escapeHtml(task.createdAt)}</span>
        </div>
        <div class="detail-row">
          <span class="detail-label">Last Updated:</span>
          <span class="detail-value">${escapeHtml(task.updatedAt)}</span>
        </div>
      </div>

      ${runDetailsHtml}
    </div>
  `.trim();
}

/**
 * Renders the in-memory operator authentication gate / principal identity panel.
 * Tokens are kept strictly in JavaScript memory and never written to browser storage.
 */
export function renderAuthGatePanel(state: DashboardState): string {
  const auth = state.auth;
  if (auth?.authenticated && auth.principalId) {
    return `
      <section class="auth-gate-panel auth-authenticated" id="auth-gate-panel" aria-label="Authenticated Session">
        <div class="auth-identity-summary">
          <span class="badge badge-green">Authenticated</span>
          <span class="auth-principal font-mono" id="auth-principal-id">${escapeHtml(auth.principalId)}</span>
          <span class="auth-tenant font-mono" id="auth-tenant-id">Tenant: ${escapeHtml(auth.tenantId ?? "unknown")}</span>
          <span class="badge badge-blue" id="auth-role-badge">${escapeHtml(auth.role ?? "OPERATOR")}</span>
        </div>
        <button type="button" class="btn btn-secondary" id="auth-signout-btn" data-action="sign-out">Sign Out</button>
      </section>
    `.trim();
  }

  const errorHtml = auth?.authError
    ? `<div class="auth-error-banner error-banner" id="auth-error-banner" role="alert">${escapeHtml(auth.authError)}</div>`
    : "";
  const isBusy = Boolean(auth?.isAuthenticating);

  return `
    <section class="auth-gate-panel auth-unauthenticated" id="auth-gate-panel" aria-label="Operator Authentication">
      <form class="auth-token-form" id="auth-token-form">
        <label for="auth-token-input">Operator Bearer Token (stored in-memory only)</label>
        <div class="auth-input-row">
          <input
            type="password"
            id="auth-token-input"
            name="token"
            autocomplete="off"
            placeholder="Paste Emerald API Bearer token..."
            ${isBusy ? "disabled" : ""}
            required
          />
          <button type="submit" class="btn btn-primary" id="auth-signin-btn" ${isBusy ? "disabled" : ""}>
            ${isBusy ? "Verifying..." : "Sign In"}
          </button>
        </div>
        ${errorHtml}
      </form>
    </section>
  `.trim();
}

/**
 * Renders the live Multi-Agent DAG Execution Workspace card:
 * 1. Visual pipeline graph with live status colors and role badges
 * 2. Real Human-in-the-Loop Approve / Reject controls for WAITING_APPROVAL nodes
 * 3. Sovereign Verification Proof Card with verifier name, status, and evidence file links
 * 4. Tool-Activity + Bounded Repair History chronological timeline
 */
export function renderDagWorkspaceCard(state: DashboardState): string {
  const dag = state.dagSnapshot;
  if (!dag || !dag.nodes || dag.nodes.length === 0) {
    return "";
  }

  const selectedNodeId = state.selectedDagNodeId || dag.activeNodeId || dag.nodes[0]?.id;
  const selectedNode = dag.nodes.find((n) => n.id === selectedNodeId) || dag.nodes[0];

  const pipelineNodesHtml = dag.nodes
    .map((node, idx) => {
      const isSelected = node.id === selectedNodeId;
      const isLast = idx === dag.nodes.length - 1;

      let stateClass = "node-pending";
      let statusBadgeColor = "gray";
      let statusLabel = node.state.toUpperCase();

      if (node.state === "verified" || node.rawStatus === "COMPLETED") {
        stateClass = "node-verified";
        statusBadgeColor = "green";
        statusLabel = "VERIFIED";
      } else if (node.state === "waiting-approval" || node.rawStatus === "WAITING_APPROVAL") {
        stateClass = "node-waiting-approval";
        statusBadgeColor = "yellow";
        statusLabel = "WAITING APPROVAL";
      } else if (node.state === "running" || node.rawStatus === "RUNNING") {
        stateClass = "node-running";
        statusBadgeColor = "blue";
        statusLabel = "RUNNING";
      } else if (node.state === "failed" || node.rawStatus === "FAILED") {
        stateClass = "node-failed";
        statusBadgeColor = "red";
        statusLabel = "FAILED";
      }

      const connectorHtml = !isLast ? `<div class="dag-connector" aria-hidden="true">&rarr;</div>` : "";

      return `
        <button
          type="button"
          class="dag-node-btn ${stateClass} ${isSelected ? "node-selected" : ""}"
          data-action="select-dag-node"
          data-node-id="${escapeHtml(node.id)}"
          title="Click to inspect [${escapeHtml(node.role)}] details"
        >
          <div class="node-role-tag">${escapeHtml(node.role)}</div>
          <div class="node-title-label">${escapeHtml(node.id)}</div>
          <div class="node-footer">
            <span class="badge badge-${statusBadgeColor}">${escapeHtml(statusLabel)}</span>
            <span class="node-duration font-mono">${node.durationMs > 0 ? (node.durationMs / 1000).toFixed(1) + "s" : ""}</span>
          </div>
        </button>
        ${connectorHtml}
      `;
    })
    .join("");

  let approvalSectionHtml = "";
  if (selectedNode?.approval) {
    const appr = selectedNode.approval;
    const isPending = appr.status === "PENDING" || selectedNode.state === "waiting-approval";

    if (isPending) {
      approvalSectionHtml = `
        <div class="approval-gate-card" id="approval-gate-card">
          <h4>
            <span class="status-dot"></span>
            HUMAN OPERATOR AUTHORIZATION REQUIRED
          </h4>
          <p style="margin: 6px 0; font-size: 13px;">
            <strong>Operation:</strong> <code>${escapeHtml(appr.operation)}</code><br/>
            <strong>Justification:</strong> ${escapeHtml(appr.justification || "Human approval required")}<br/>
            <strong>Approval ID:</strong> <span class="font-mono">${escapeHtml(appr.approvalId)}</span>
          </p>
          <div class="approval-actions">
            <button
              type="button"
              class="btn btn-approve"
              data-action="approve-node"
              data-approval-id="${escapeHtml(appr.approvalId)}"
              ${state.approvalBusy ? "disabled" : ""}
            >
              ${state.approvalBusy ? "Approving..." : "Approve Execution"}
            </button>
            <button
              type="button"
              class="btn btn-reject"
              data-action="reject-node"
              data-approval-id="${escapeHtml(appr.approvalId)}"
              ${state.approvalBusy ? "disabled" : ""}
            >
              ${state.approvalBusy ? "Rejecting..." : "Reject & Fail Closed"}
            </button>
          </div>
          ${state.approvalError ? `<div class="error-banner" style="margin-top:8px;">${escapeHtml(state.approvalError)}</div>` : ""}
        </div>
      `;
    } else {
      const badgeColor = appr.status === "APPROVED" ? "green" : "red";
      approvalSectionHtml = `
        <div class="approval-gate-card" style="border-color: var(--${badgeColor}); background: rgba(74, 222, 128, 0.05);">
          <h4>APPROVAL RECORD: <span class="badge badge-${badgeColor}">${escapeHtml(appr.status)}</span></h4>
          <p style="margin: 4px 0; font-size: 12px;">
            <strong>Decided By:</strong> <span class="font-mono">${escapeHtml(appr.approver || "Operator")}</span> at ${escapeHtml(appr.decidedAt || "N/A")}<br/>
            <strong>Operation:</strong> <code>${escapeHtml(appr.operation)}</code>
          </p>
        </div>
      `;
    }
  }

  let proofSectionHtml = "";
  if (selectedNode?.verification) {
    const v = selectedNode.verification;
    if (v.unverifiedOverride) {
      proofSectionHtml = `
        <div class="proof-card" style="border-color: var(--yellow); background: rgba(250, 204, 21, 0.08);">
          <h4 style="color: var(--yellow);">OPERATOR OVERRIDE RECORD (UNVERIFIED COMPLETION)</h4>
          <div class="proof-grid">
            <div><strong>Authorized By:</strong> <span class="font-mono">${escapeHtml(v.operator || "Operator")}</span></div>
            <div><strong>Timestamp:</strong> <span>${escapeHtml(v.timestamp || "N/A")}</span></div>
            <div style="grid-column: 1 / -1;"><strong>Audit Note:</strong> <span>${escapeHtml(v.note || "Explicit override")}</span></div>
          </div>
        </div>
      `;
    } else {
      const isPassed = v.status === "PASSED" || v.status === "VERIFIED";
      const badgeColor = isPassed ? "green" : "red";
      const evidenceTags = (v.evidencePaths && v.evidencePaths.length > 0)
        ? v.evidencePaths.map((p) => `<span class="evidence-tag">${escapeHtml(p)}</span>`).join(" ")
        : `<span class="evidence-tag">output payload validated</span>`;

      proofSectionHtml = `
        <div class="proof-card" id="verification-proof-card">
          <h4>SOVEREIGN VERIFICATION PROOF</h4>
          <div class="proof-grid">
            <div><strong>Verifier:</strong> <span class="font-mono">${escapeHtml(v.verifierId || "DeterministicVerifier")}</span></div>
            <div><strong>Verdict:</strong> <span class="badge badge-${badgeColor}">${escapeHtml(v.status || "PASSED")}</span> (Exit code: ${v.exitCode ?? 0})</div>
            <div><strong>Spec ID:</strong> <span class="font-mono">${escapeHtml(v.specId || "N/A")}</span></div>
            <div><strong>Timestamp:</strong> <span>${escapeHtml(v.timestamp || "N/A")}</span></div>
            <div style="grid-column: 1 / -1;"><strong>Summary:</strong> <span>${escapeHtml(v.summary || "Specification validated")}</span></div>
            <div style="grid-column: 1 / -1;"><strong>Evidence Files:</strong> ${evidenceTags}</div>
          </div>
        </div>
      `;
    }
  }

  let timelineItemsHtml = "";
  if (selectedNode?.timeline && selectedNode.timeline.length > 0) {
    timelineItemsHtml = selectedNode.timeline
      .map((item) => {
        let itemClass = "item-tool";
        if (item.type === "repair") itemClass = "item-repair";
        else if (item.type === "approval") itemClass = "item-approval";
        else if (item.type === "verification") itemClass = "item-verification";

        const timeStr = item.timestamp ? new Date(item.timestamp).toLocaleTimeString() : "";

        return `
          <div class="timeline-stream-item ${itemClass}">
            <div class="timeline-stream-time">${escapeHtml(timeStr)}</div>
            <div class="timeline-stream-content">
              <div class="timeline-stream-title">${escapeHtml(item.title)}</div>
              <div class="timeline-stream-desc">${escapeHtml(item.description)}</div>
            </div>
          </div>
        `;
      })
      .join("");
  } else {
    timelineItemsHtml = `<p class="empty-hint" style="color:var(--text-muted); font-size:12px; margin: 4px 0;">No activity events recorded yet for this node.</p>`;
  }

  const sseStatusLabel = state.dagStreamStatus === "connected"
    ? `<span class="badge badge-green">DAG Stream Live</span>`
    : `<span class="badge badge-gray">DAG Stream ${state.dagStreamStatus ?? "Connecting"}</span>`;

  return `
    <section class="dag-workspace-card" id="dag-workspace-card" aria-label="Multi-Agent Execution Pipeline">
      <div class="dag-header">
        <div class="dag-title-area">
          <h2>Mission Execution Workspace: ${escapeHtml(dag.missionTitle)}</h2>
          <p class="dag-description">${escapeHtml(dag.missionDescription)}</p>
        </div>
        <div class="dag-header-badges" style="display:flex; gap:8px; align-items:center;">
          <span class="badge badge-blue">Mission Task: ${escapeHtml(dag.rootTaskId)}</span>
          <span class="badge badge-yellow">Status: ${escapeHtml(dag.rootStatus)}</span>
          ${sseStatusLabel}
        </div>
      </div>

      <div class="dag-pipeline-flow" id="dag-pipeline-flow">
        ${pipelineNodesHtml}
      </div>

      ${selectedNode ? `
        <div class="dag-node-detail-panel" id="dag-node-detail-panel">
          <div class="dag-node-detail-header">
            <div>
              <h3 style="margin:0; font-size:15px; color:var(--text-main);">
                [${escapeHtml(selectedNode.role)}] ${escapeHtml(selectedNode.title)}
              </h3>
              <span style="font-size:12px; color:var(--text-muted);">
                Objective: ${escapeHtml(selectedNode.objective)}
              </span>
            </div>
            <div style="font-size:12px; color:var(--text-subtle);">
              Dependencies: ${selectedNode.dependencies.length > 0 ? selectedNode.dependencies.map((d) => `<code>${escapeHtml(d)}</code>`).join(", ") : "None (Root)"}
            </div>
          </div>

          ${approvalSectionHtml}
          ${proofSectionHtml}

          <div class="timeline-stream" id="dag-timeline-stream">
            <h4>Tool Activity &amp; Repair History Timeline (${selectedNode.timeline?.length ?? 0} events)</h4>
            <div class="timeline-stream-list">
              ${timelineItemsHtml}
            </div>
          </div>
        </div>
      ` : ""}
    </section>
  `.trim();
}

/**
 * Main Pure View Renderer: Generates complete dashboard HTML from current state.
 */
export function renderDashboardHtml(state: DashboardState): string {
  const connectionBadge = renderConnectionStatusBadge(state.connectionStatus, state.connectionError);
  const authGate = renderAuthGatePanel(state);
  const dagWorkspace = renderDagWorkspaceCard(state);
  const summaryCards = renderSummaryCards(state);
  const submissionForm = renderTaskSubmissionForm(state);
  const taskList = renderTaskList(state);
  const selectedDetails = renderSelectedTaskDetails(state);

  return `
    <div class="emerald-dashboard-app">
      <a href="#main-content" class="skip-link">Skip to main content</a>
      <header class="dashboard-header">
        <div class="brand">
          <h1>Emerald Agent Fabric</h1>
          <span class="subtitle">Autonomous Software Engineering Governance Dashboard</span>
        </div>
        <div class="header-status">
          ${connectionBadge}
        </div>
      </header>

      ${authGate}

      <div class="notices-container">
        <div class="notice-card notice-info">
          <strong>Session Scope & Durable History:</strong> Task history is loaded from authoritative backend storage (<code>/api/v1/tasks</code>) with cursor pagination and status filtering.
        </div>
        <div class="notice-card notice-secure">
          <strong>Sandbox Enforcement:</strong> All agent tasks execute inside non-root OCI/Docker containers with dropped Linux capabilities and <code>no-new-privileges</code>.
        </div>
      </div>

      <main class="dashboard-main-content" id="main-content">
        ${dagWorkspace}

        ${summaryCards}

        <div class="dashboard-layout-columns">
          <div class="column-left">
            ${submissionForm}
          </div>

          <div class="column-right">
            <section class="session-history-section" aria-labelledby="history-heading">
              <div class="section-header">
                <h2 id="history-heading">Local Session History (${state.tasks.length})</h2>
              </div>
              ${taskList}
            </section>

            <section class="task-details-section" aria-labelledby="details-heading">
              ${selectedDetails}
            </section>
          </div>
        </div>
      </main>
    </div>
  `.trim();
}
