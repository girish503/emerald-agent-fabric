# Emerald Agent Fabric — Web Frontend (Milestone 2.27)

The **Emerald Agent Fabric Web Frontend** provides an observable, accessible, and securely governed operator dashboard for executing, monitoring, and inspecting autonomous software engineering agents.

Built in strict compliance with the **Master Engineering Constitution**, the frontend adheres to the ₹0-cost project constraint, zero speculative architecture, strictly typed contracts, defense-in-depth security, and reproducible verification.

---

## 1. Architectural Overview

```
apps/web/
├── index.html                           # Accessible, responsive application shell
├── build.js                             # Standalone esbuild bundling script (₹0 external downloads)
├── dist/
│   └── bundle.js                        # Compiled, standalone ESM browser bundle (~309 KB unminified)
├── src/
│   ├── index.ts                         # Public API exports
│   ├── app.ts                           # DOM mounting & native event wiring (mountDashboardApp)
│   ├── client/
│   │   ├── api-client.ts                # Typed Fastify REST API client (Fetch + AbortController)
│   │   ├── sse-client.ts                # Durable SSE streaming client (reconnection + Last-Event-ID)
│   │   └── web-crypto.ts                # Zero-dependency RFC 6234 / FIPS 180-4 SHA-256 Web Crypto adapter
│   ├── components/
│   │   ├── dashboard-controller.ts      # Reactive state management, buffering, and event coordination
│   │   ├── dashboard-view.ts            # Pure functional HTML renderers with strict XSS escaping
│   │   ├── workspace-views.ts           # State transformers, badge formatters, and timeline builders
│   │   ├── artifact-viewer.ts           # Authoritative artifact metadata viewer & category inspector
│   │   └── evidence-viewer.ts           # Authoritative verification and provenance evidence visualizer
│   ├── mocks/
│   │   └── mock-data.ts                 # Offline test fixtures and simulated contracts
│   └── types/
│       └── api.ts                       # Typed frontend contract schemas aligned with backend kernel
```

---

## 2. Core Capabilities

### A. Governed Task Submission & Lifecycle Control
- **Task Submission Form**: Validates task title, prompt instructions, model (`qwen2.5-coder:7b`), provider (`ollama`), and execution timeout.
- **Sandboxed Execution Notice**: Informs the operator that all agent workloads run in non-root OCI/Docker containers with dropped Linux capabilities and `no-new-privileges`.
- **Three-Phase Cancellation**: Supports operator-initiated cancellation (`requesting` → `requested` → `confirmed_stopped`) with authoritative backend state verification.

### B. Durable Real-Time SSE Execution Stream
- **Authenticated Streaming**: Streams execution events from `GET /api/v1/runs/:runId/events` with Bearer authentication.
- **Replay & Gap Detection**: Utilizes `Last-Event-ID` header for seamless stream resumption and detects sequence gaps.
- **Bounded Buffer**: Maintains an in-memory ring buffer strictly capped at **500 events** to prevent memory leaks during long-running agent trials.

### C. Evidence & Artifact Inspection
- **Authoritative Metadata**: Displays artifact ID, run ID, safe relative path, SHA-256 digest, byte size, MIME content type, and creation timestamp.
- **Verified Completion vs Artifacts**: Strictly maintains the architectural distinction between artifact generation and objective workspace verification.
- **Dual-Perspective Evidence**: Separates provider-reported metrics from independent observer evaluations (`VERIFIED_SUCCESS`, `FALSE_COMPLETION`, etc.).

---

## 3. Local Browser Build System

The frontend compiles to a self-contained ES module bundle using the existing locally installed `esbuild` engine:

```bash
# Execute local build
node apps/web/build.js
```

### Transitive `node:crypto` Browser Resolution
Backend domain schemas imported by the frontend transitively reference `canonical-hash.ts`, which imports `node:crypto`. When compiling for the browser, `build.js` aliases `node:crypto` to `apps/web/src/client/web-crypto.ts`.
- Implements bit-exact FIPS 180-4 / RFC 6234 compliant SHA-256 hashing.
- Produces identical hexadecimal digests to Node.js `crypto.createHash("sha256")`.
- Guarantees zero residual `node:*` specifiers or unresolvable imports in `dist/bundle.js`.

---

## 4. Real Browser Validation

The application is validated in real, locally installed headless browser environments:

- **Google Chrome**: `C:\Program Files\Google\Chrome\Application\chrome.exe`
- **Microsoft Edge**: `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`

Validation is executed headlessly using `--headless=new --disable-gpu --virtual-time-budget=3000 --dump-dom`:
- Boots the actual browser process against an ephemeral local HTTP server.
- Fetches and evaluates `index.html` and `dist/bundle.js`.
- Mounts the complete dashboard into `#app`.
- Validates responsive layout across mobile (`360x640`), tablet (`768x1024`), and desktop (`1440x900`) viewports.

---

## 5. Accessibility & UX Hardening (WCAG 2.1 AA)

- **Contrast Ratios**: Verified dark palette with high-contrast text tokens (`#f8fafc` on `#0f172a` yields 15.6:1 contrast; badges and buttons exceed 4.5:1).
- **Visible Focus Rings**: Defined `:focus-visible` ring (`2px solid #38bdf8; outline-offset: 2px`) on all interactive inputs, buttons, and links.
- **Skip-to-Content Link**: Includes `<a href="#main-content" class="skip-link">Skip to main content</a>` targeting `<main id="main-content">`.
- **Polite Live Regions**: Dynamic updates (SSE stream state, run cancellation progression, live execution timeline) use `role="status"` and `aria-live="polite"` to avoid interrupting screen reader navigation.
- **Form Accessibility**: Task submission errors announce via `role="alert"` and associate with inputs via `aria-invalid="true"` and `aria-describedby="task-submission-error"`.
- **Color-Independent Status**: All outcome and task badges feature distinctive labels, descriptive tooltips, and border styling rather than relying on color alone.
- **Defensive Text Overflow**: Monospace hashes, IDs, and file paths enforce `overflow-wrap: anywhere; word-break: break-all;` to prevent layout breaking on mobile devices.

---

## 6. Running Tests

```bash
# Run all frontend tests (unit, contract, integration, real browser validation)
npx vitest run tests/frontend/

# Run real browser validation specifically
npx vitest run tests/frontend/browser-validation.test.ts

# Run production readiness & accessibility regression tests
npx vitest run tests/frontend/production-readiness.test.ts

# Verify TypeScript baseline quality gate (0 new diagnostics)
node scripts/ci/check-tsc-baseline.js
```
