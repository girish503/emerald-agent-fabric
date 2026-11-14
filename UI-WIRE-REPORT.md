# UI Wire Verification Report — Emerald Web UI Integration

## Executive Summary
This report documents the surgical wiring of the existing static governance web UI (`apps/web`) into the `emerald server` CLI entrypoint, resolving the origin/CORS mismatch where requests were previously routed to port 3001.

---

## 1. Code Changes
- **File**: `src/cli/emerald-cli.ts`
- **Modifications**:
  1. Updated `handleServer` usage string to document `[--web-ui-root <dir>]`.
  2. Registered `--web-ui-root` and its alias `--web-ui` in `parseValueFlags`.
  3. Added strict startup validation:
     - Disallows simultaneously supplying both `--web-ui-root` and `--web-ui`.
     - Fails closed if the provided directory does not exist or is not a directory.
     - Fails closed if the directory does not contain `index.html`.
     - Fails closed if the directory does not contain `dist/bundle.js`.
  4. Passes the resolved absolute path as `webUiRoot` to `buildFastifyServer(...)` only when the flag is present. Without the flag, `webUiRoot` is `undefined` and static UI routes are not registered.
- **Constraints Maintained**: Zero changes to auth, principals, CORS, execution modes, or baseline manifests. No commit, push, or merge performed.

---

## 2. Verification Protocol & Results

### 2.1 Build & Quality Gate
1. **Compilation**:
   - Command: `npm run build`
   - Exit Code: `0`
2. **TypeScript Quality Gate Baseline**:
   - Command: `node scripts/ci/check-tsc-baseline.js`
   - Result:
     - Approved Baseline: 287
     - Current Diagnostics: 255
     - **New Diagnostics: 0**
     - Resolved Diagnostics: 32
     - Status: `[GATE PASSED]`

### 2.2 Startup Validation (Fail-Closed)
1. **Non-Existent Directory**:
   - Command: `node bin/emerald.js server --db ./emerald.db --port 3000 --host 127.0.0.1 --web-ui-root ./nonexistent_dir`
   - Exit Code: `1`
   - Output: `Error: web UI root directory not found: <repoRoot>\nonexistent_dir`
2. **Directory Missing `index.html`**:
   - Command: `node bin/emerald.js server --db ./emerald.db --port 3000 --host 127.0.0.1 --web-ui-root ./src`
   - Exit Code: `1`
   - Output: `Error: web UI root missing index.html: <repoRoot>\src\index.html`
3. **Execution Without `--web-ui-root`**:
   - Command: `node bin/emerald.js server --db ./emerald.db --port 3000 --host 127.0.0.1`
   - Check: `curl.exe -s http://127.0.0.1:3000/`
   - Result: `404 NOT_FOUND` (`{"success":false,"error":{"code":"NOT_FOUND","message":"Resource not found"}}`)

### 2.3 Live Server & Endpoint Verification
Started server with:
```powershell
$env:EMERALD_API_PRINCIPALS = '[{"token":"alpha-operator-token-aaaaaaaa1","principalId":"op-1","tenantId":"tenant-1","role":"operator"}]'
node bin/emerald.js server --db ./emerald.db --port 3000 --host 127.0.0.1 --web-ui-root ./apps/web
```

- **`GET http://127.0.0.1:3000/`**:
  - Status: `HTTP/1.1 200 OK`
  - Content-Type: `text/html; charset=utf-8`
  - Content-Security-Policy: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; connect-src 'self'`
- **`GET http://127.0.0.1:3000/dist/bundle.js`**:
  - Status: `HTTP/1.1 200 OK`
  - Content-Type: `text/javascript; charset=utf-8`
  - Content-Length: `1,587,194 bytes`
- **`GET http://127.0.0.1:3000/health`**:
  - Status: `HTTP/1.1 200 OK`
  - Output: `{"status":"ok","coreStatus":"ok","telemetryStatus":"ok","zeroAuthority":true,...}`
- **`GET http://127.0.0.1:3000/metrics`**:
  - Status: `HTTP/1.1 200 OK`
  - Output: Prometheus metrics stream active.

---

## 3. Browser & Dashboard Audit
- **Subagent**: Browser inspection on `http://127.0.0.1:3000/`
- **Screenshot Path**: `C:/Users/Adusumalli Girish/.gemini/antigravity/brain/22cc3ec1-2247-4c9d-855b-ba8bc4b1274d/browser_evidence/999070d3-2a21-4b6a-b30c-402beb4f9244/final_step_4.png`
- **Network Audit**:
  - All browser API requests target `http://127.0.0.1:3000/api/v1/...` (same origin).
  - Zero 404s for API requests or static assets.
  - `GET /api/v1/tasks?limit=20` returns `401 Unauthorized` without a token, correctly caught by the in-browser authentication handler.
- **Rendered Components**:
  1. Title / Header: `Emerald Agent Fabric` (`Autonomous Software Engineering Governance Dashboard`)
  2. Connection & sync status badges
  3. Operator Bearer Token sign-in input and in-memory auth gate
  4. Architecture callout cards (Session Scope & Sandbox Enforcement)
  5. 6 Governance Metric Cards (Total Tasks, Running Runs, Completed Runs, Verified Successes, False Completions, Verified Rate)
  6. Task Submission Form with OCI/Docker sandboxed execution mode badge
  7. Governed Tasks History with 12 status filters (`CREATED` through `RECOVERING`) and refresh control
  8. Task inspection details container
- **Current UI Gaps / Known Limitations**:
  - No DAG view / pipeline node execution graph.
  - No interactive human-in-the-loop approve/reject buttons in the task viewer.
  - No live container CPU/memory/IO telemetry widgets.
