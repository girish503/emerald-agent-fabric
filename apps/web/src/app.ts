/**
 * Emerald Agent Fabric — Web Application Entry Point & DOM Mounting (Milestone 2.27)
 *
 * Connects the stateful DashboardController with the rendered DOM/UI:
 * 1. Mounts into a target container element (e.g. document.getElementById("app")).
 * 2. Renders the complete dashboard view using renderDashboardHtml(state).
 * 3. Binds native DOM event handlers:
 *    - Form submission -> controller.submitTask(...)
 *    - Task selection -> controller.selectTask(...)
 *    - Task refresh -> controller.refreshTask(...)
 *    - Run cancellation -> controller.cancelRun(...)
 * 4. Subscribes to controller state mutations to automatically re-render the UI.
 * 5. Provides an unmount() lifecycle function for clean teardown.
 */

import {
  DashboardController,
  type DashboardState,
} from "./components/dashboard-controller.js";
import { renderDashboardHtml } from "./components/dashboard-view.js";
import { EmeraldApiClient } from "./client/api-client.js";

/**
 * Structural interface matching standard browser HTMLElement / Element.
 * Allows mounting in both real browser DOM and headless test containers without external packages.
 */
export interface DOMElement {
  innerHTML: string;
  querySelector<E extends DOMElement = DOMElement>(selector: string): E | null;
  querySelectorAll<E extends DOMElement = DOMElement>(selector: string): Iterable<E> | E[];
  addEventListener(event: string, handler: (e: any) => void, options?: any): void;
  removeEventListener?(event: string, handler: (e: any) => void, options?: any): void;
  dispatchEvent(event: any): boolean;
  getAttribute(name: string): string | null;
  value?: string;
}

export interface AppMountOptions {
  /** Target container element into which the dashboard is rendered */
  readonly container: DOMElement;
  /** Typed API client configured to communicate with the Emerald backend */
  readonly apiClient: EmeraldApiClient;
  /** Optional initial dashboard state override */
  readonly initialState?: Partial<DashboardState>;
  /**
   * Whether to trigger initial task history load immediately on mount.
   * Defaults to true for programmatic/test mounts; browser bootstrap sets false
   * until an in-memory bearer token is explicitly supplied.
   */
  readonly autoLoadHistory?: boolean;
}

export interface MountedApp {
  readonly controller: DashboardController;
  readonly unmount: () => void;
  readonly getContainer: () => DOMElement;
}

/**
 * Mounts the Emerald Dashboard Web Application into the specified container element.
 */
export function mountDashboardApp(options: AppMountOptions): MountedApp {
  const { container, apiClient, initialState, autoLoadHistory = true } = options;
  if (!container) {
    throw new Error("mountDashboardApp requires a valid container element");
  }
  if (!apiClient) {
    throw new Error("mountDashboardApp requires a valid EmeraldApiClient instance");
  }

  const controller = new DashboardController(apiClient, initialState);
  let isMounted = true;

  function bindEvents() {
    if (!isMounted) return;

    // 1. Task Submission Form
    const form = container.querySelector("#task-submission-form");
    if (form) {
      form.addEventListener("submit", async (e: any) => {
        if (e && typeof e.preventDefault === "function") {
          e.preventDefault();
        }

        const titleInput = container.querySelector("#task-title-input");
        const promptInput = container.querySelector("#task-prompt-input");
        const modelInput = container.querySelector("#task-model-input");
        const providerInput = container.querySelector("#task-provider-input");
        const repoInput = container.querySelector("#task-repo-input");
        const timeoutInput = container.querySelector("#task-timeout-input");

        const title = titleInput?.value ?? "";
        const prompt = promptInput?.value ?? "";
        const modelName = modelInput?.value || "qwen2.5-coder:7b";
        const provider = providerInput?.value || "ollama";
        const repoPath = repoInput?.value?.trim() || undefined;
        const timeoutSeconds = timeoutInput?.value ? parseInt(timeoutInput.value, 10) : 600;

        try {
          await controller.submitTask({
            title,
            prompt,
            modelName,
            provider,
            repoPath,
            timeoutSeconds,
          });
        } catch {
          // Failure sets controller.lastSubmissionError, which automatically triggers reactive re-render
        }
      });
    }

    // 2. Task Selection Buttons
    const selectButtons = container.querySelectorAll('[data-action="select"]');
    if (selectButtons) {
      for (const btn of selectButtons) {
        btn.addEventListener("click", (e: any) => {
          if (e && typeof e.preventDefault === "function") {
            e.preventDefault();
          }
          const taskId = btn.getAttribute("data-task-id");
          if (taskId) {
            controller.selectTask(taskId);
          }
        });
      }
    }

    // 3. Task Refresh Buttons
    const refreshButtons = container.querySelectorAll('[data-action="refresh-task"]');
    if (refreshButtons) {
      for (const btn of refreshButtons) {
        btn.addEventListener("click", async (e: any) => {
          if (e && typeof e.preventDefault === "function") {
            e.preventDefault();
          }
          const taskId = btn.getAttribute("data-task-id");
          if (taskId) {
            try {
              await controller.refreshTask(taskId);
            } catch {
              // Failure is recorded in task.fetchError and reactive re-render reflects it
            }
          }
        });
      }
    }

    // 4. Run Cancellation Controls
    const cancelBtn = container.querySelector("#cancel-run-button");
    if (cancelBtn) {
      cancelBtn.addEventListener("click", async (e: any) => {
        if (e && typeof e.preventDefault === "function") {
          e.preventDefault();
        }
        const runId = cancelBtn.getAttribute("data-run-id");
        const reasonInput = container.querySelector("#cancel-reason-input");
        const reason = reasonInput?.value?.trim() || "Operator initiated abort";
        if (runId) {
          try {
            await controller.cancelRun(runId, reason);
          } catch {
            // Failure is recorded in cancellation state and reactive re-render reflects it
          }
        }
      });
    }

    // 5. Artifact Selection Buttons
    const artifactButtons = container.querySelectorAll('[data-action="select-artifact"]');
    if (artifactButtons) {
      for (const btn of artifactButtons) {
        btn.addEventListener("click", (e: any) => {
          if (e && typeof e.preventDefault === "function") {
            e.preventDefault();
          }
          const artifactId = btn.getAttribute("data-artifact-id");
          if (artifactId) {
            const currentSelected = controller.getState().selectedArtifactId;
            controller.selectArtifact(currentSelected === artifactId ? undefined : artifactId);
          }
        });
      }
    }

    // 6. Task Status Filter Dropdown
    const statusFilter = container.querySelector("#task-status-filter");
    if (statusFilter) {
      statusFilter.addEventListener("change", (e: any) => {
        const val = e?.target?.value || statusFilter.value;
        if (val) {
          void controller.setStatusFilter(val).catch(() => {});
        }
      });
    }

    // 7. Refresh History Button
    const refreshHistoryBtn = container.querySelector('[data-action="refresh-history"]');
    if (refreshHistoryBtn) {
      refreshHistoryBtn.addEventListener("click", (e: any) => {
        if (e && typeof e.preventDefault === "function") {
          e.preventDefault();
        }
        void controller.refreshHistory().catch(() => {});
      });
    }

    // 8. Load More Tasks Button
    const loadMoreBtn = container.querySelector('[data-action="load-more"]');
    if (loadMoreBtn) {
      loadMoreBtn.addEventListener("click", (e: any) => {
        if (e && typeof e.preventDefault === "function") {
          e.preventDefault();
        }
        void controller.loadNextPage().catch(() => {});
      });
    }

    // 9. Retry History Buttons
    const retryButtons = container.querySelectorAll('[data-action="retry-history"]');
    if (retryButtons) {
      for (const btn of retryButtons) {
        btn.addEventListener("click", (e: any) => {
          if (e && typeof e.preventDefault === "function") {
            e.preventDefault();
          }
          void controller.loadTaskHistory({ reset: true }).catch(() => {});
        });
      }
    }

    // 10. Operator Bearer Token Authentication Form (in-memory only)
    const authForm = container.querySelector("#auth-token-form");
    if (authForm) {
      authForm.addEventListener("submit", async (e: any) => {
        if (e && typeof e.preventDefault === "function") {
          e.preventDefault();
        }
        const tokenInput = container.querySelector("#auth-token-input");
        const token = tokenInput?.value ?? "";
        if (tokenInput) {
          tokenInput.value = "";
        }
        await controller.signInWithToken(token);
      });
    }

    // 11. Operator Sign-Out Button
    const signOutBtn = container.querySelector("#auth-signout-btn");
    if (signOutBtn) {
      signOutBtn.addEventListener("click", (e: any) => {
        if (e && typeof e.preventDefault === "function") {
          e.preventDefault();
        }
        controller.signOut();
      });
    }
  }

  function render(state: DashboardState) {
    if (!isMounted) return;
    container.innerHTML = renderDashboardHtml(state);
    bindEvents();
  }

  // Initial render with current state
  render(controller.getState());

  // Subscribe to controller mutations for reactive updates
  const unsubscribe = controller.subscribe((newState) => {
    render(newState);
  });

  // Trigger initial task history loading when enabled (and probe identity if token exists)
  void (async () => {
    try {
      const existingToken = await apiClient.getToken();
      if (existingToken && isMounted) {
        await controller.authenticateCurrentToken().catch(() => {});
      }
      if (autoLoadHistory && isMounted) {
        await controller.loadTaskHistory({ reset: true }).catch(() => {});
      }
    } catch {
      // Handled inside controller state
    }
  })();

  return {
    controller,
    unmount: () => {
      isMounted = false;
      unsubscribe();
      controller.dispose();
      container.innerHTML = "";
    },
    getContainer: () => container,
  };
}
