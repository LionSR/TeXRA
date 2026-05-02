# PRD: TeXRA Electron App

**Status:** Draft
**Owner:** TBD
**Date:** 2026-05-02
**Branch:** `claude/texra-electron-prd-bMUQG`

## 1. Summary

Ship TeXRA as a standalone cross-platform desktop application built on Electron, alongside the existing VS Code extension. The Electron app reuses the agent core, model handlers, LaTeX processing, tool implementations, and webview UIs unchanged. Only the host shell — window management, file system, settings, secrets, command surface — is rewritten for Electron. Compilation is fully separate: a new `apps/electron/` build pipeline produces the desktop binary; the existing `npm run build:fast` VSIX pipeline is untouched.

## 2. Goals

- Standalone TeXRA app on macOS, Windows, Linux for users who don't want VS Code.
- Reuse ~90% of existing source unchanged. Concretely: every directory listed as a "VS Code-free zone" in `CLAUDE.md` ships as-is.
- Keep the VS Code extension a first-class target. The Electron app is additive, not a replacement.
- Single source-of-truth for agent definitions, schemas, and webview UIs across both targets.
- Preserve current dev workflow: `npm run build:fast` continues to produce a VSIX; new `npm run build:electron` produces installers.
- Support auto-update, code-signing, and multi-platform installer builds out of the box.

## 3. Non-goals

- **Not** a VS Code fork (we don't reimplement Monaco's full editor surface, language servers, debug protocol, or extension marketplace). The Electron app is a focused LaTeX assistant, not an IDE.
- **Not** a rewrite of the agent core, webview UIs, or LaTeX pipeline. Code already isolated behind `@platform` stays exactly as-is.
- **Not** mobile, web, or PWA. Those are separate efforts.
- **No new agent features** scoped to this PRD. Feature parity with the extension at v1.

## 4. Background

### Why this is tractable

`CLAUDE.md` already mandates a strict separation:

- **VS Code-free zones (must not import `vscode`):** `src/agent/`, `src/model/`, `src/latex/`, `src/tools/`, `src/shared/`, `src/replacement/`, `src/eventBus/`, `src/webview/frontend/`, `src/progressView/frontend/`, `src/settingsView/frontend/`.
- **VS Code-allowed zones:** `src/extension.ts`, `src/commands/`, `src/frontend/`, `src/common/webview/`, `src/common/state/`, `src/utils/config/`, `src/utils/files/workspaceFS.ts`, `src/auth/`.

A grep over the tree confirms this is enforced in practice: of 853 TypeScript files in `src/`, only ~106 import `vscode` directly. The remainder reach host services through `platform()` from `@platform`.

The platform abstraction (`src/platform/platform.ts`) defines exactly the surface a host must provide:

```ts
interface Platform {
  config: ConfigProvider;
  globalState: StateStore;
  workspaceState: StateStore;
  log: LogBackend;
  fs: FileSystemProvider;
  workspace: WorkspaceProvider;
  storage: StorageProvider;
  secrets: PlatformSecrets;
}
```

A fresh host implements seven small interfaces, calls `initPlatform(...)`, and the entire agent core runs unchanged.

### What's VS Code-shaped today

Beyond the platform interfaces, the VS Code extension provides:

1. **Webview hosting** — `BaseViewContentProvider`, `BaseViewMessageHandler`, `MainViewProvider`, the three Vite-built webviews (`webview`, `progressView`, `settingsView`).
2. **Commands** — ~60 commands registered in `package.json` `contributes.commands`, dispatched through `src/commands/`.
3. **Editor surface** — open files, diff approval for tool edits (`texra.toolUse.requireEditApproval`), syntax highlighting for `.tex`.
4. **Auth** — `vscode.AuthenticationProvider` for Supabase + GitHub.
5. **Settings UI** — `package.json` `contributes.configuration` rendered by VS Code's settings page.
6. **Notifications, status bar, menus, walkthroughs.**
7. **File watchers** — `vscode.workspace.fs` watchers backing `WorkspaceProvider`.

Every item here has a clean Electron-native replacement.

## 5. Recommended tech stack

Picks below are optimized for "easiest possible reuse" — i.e., they fit the existing toolchain rather than introducing a parallel one.

| Concern | Pick | Why |
|---|---|---|
| **Bundler / dev server** | [`electron-vite`](https://electron-vite.org/) | Already using Vite for webviews; `electron-vite` extends Vite with main/preload/renderer entry points, HMR, source maps, and `electron-builder` integration. Zero learning curve. |
| **Packaging / installers** | [`electron-builder`](https://www.electron.build/) | DMG/NSIS/AppImage/deb/rpm in one config. Code-signing, notarization, and auto-update channels are first-class. Plays directly with `electron-vite`. |
| **Auto-update** | `electron-updater` (part of `electron-builder`) | Pairs with GitHub Releases or S3; matches our existing `gh release create` flow. |
| **Renderer framework** | Existing Lit + `@lit-labs/signals` + `@vscode-elements/elements` | The webview frontends are already Lit web components. Move them into Electron renderers verbatim. `@vscode-elements/elements` are framework-agnostic web components and render fine outside VS Code. `@vscode/codicons` is a font — also portable. |
| **Window chrome** | Native Electron `BrowserWindow` with custom titlebar | Use `titleBarStyle: 'hiddenInset'` (mac) / overlay (win/linux) so we keep a native feel without owning a full title bar. |
| **Editor surface** | [`monaco-editor`](https://microsoft.github.io/monaco-editor/) (loaded as a webview component for diff preview / tool-edit approval) | Same Monaco that VS Code uses. We don't need full IDE features — just buffer + diff. Already familiar to users. Loaded once per renderer. |
| **Settings persistence** | [`electron-store`](https://github.com/sindresorhus/electron-store) | Drop-in JSON store with schema validation; backs the new `ConfigProvider` impl. Survives upgrades. |
| **Secrets** | Electron `safeStorage` API (built-in) | Uses Keychain (mac), DPAPI (win), libsecret (linux). No native deps — `keytar` is now archived/abandoned. Backs `PlatformSecrets`. |
| **File watching** | `chokidar` | Reliable cross-platform watcher; backs `WorkspaceProvider.onDidChangeFiles`. Already an indirect dependency. |
| **Logging** | `electron-log` + existing `LogBackend` | Pipes our log channels to a file under `app.getPath('logs')` and a dev-tools console. |
| **IPC** | Electron `contextBridge` + typed channels | Strict context isolation. Renderer never touches Node directly. Reuse existing `src/shared/` Zod schemas for IPC validation — they were built for VS Code postMessage but the contract is identical. |
| **Process model** | One main process + N renderer windows + utility process for agent runs | Long agent runs go in a [utility process](https://www.electronjs.org/docs/latest/api/utility-process) so a renderer crash can't kill an in-flight workflow. Equivalent to the VS Code extension host today. |
| **Auth** | Supabase JS SDK + custom protocol handler (`texra://`) | Reuse `SupabaseAuthProvider` flow. Replace `vscode.UriHandler` with `app.setAsDefaultProtocolClient('texra')` + `app.on('open-url')`. GitHub auth uses an in-process OAuth flow with a loopback redirect. |
| **LaTeX / external tools** | Direct `execa` calls (already a dep) | No change from extension. PATH discovery via `app.getPath('exe')` env. |
| **Crash reporting** | Electron `crashReporter` → Sentry (optional) | Out of scope for v1 but the hook is free. |
| **Testing** | Existing Mocha for core; `playwright` for renderer/E2E | Mocha test suites in `src/test/` already run platform-agnostic. Add Playwright only for Electron-specific smoke tests. |

### Stacks explicitly rejected

- **Tauri** — would mean rewriting the Node-heavy agent core (model SDKs, `execa`, `fs-extra`, `pdf2pic`, `tar`) for a Rust/Webview2 runtime. Not "easy reuse."
- **NW.js** — smaller community, no auto-update parity with `electron-builder`.
- **Forge instead of Builder** — fine alternative, but `electron-builder` has stronger auto-update and signing tooling and integrates tighter with `electron-vite`.
- **React/Vue rewrite** — webviews are already Lit. Don't churn working UI.

## 6. Architecture

### 6.1 Directory layout (proposed)

Use **npm workspaces** to keep one repo, two builds. The existing extension stays at the repo root; the Electron app lives under `apps/electron/`.

```
TeXRA/
├── package.json              # workspaces root (dev tools, lint, format)
├── src/                      # ← shared agent core, webviews, etc. (unchanged)
├── apps/
│   ├── extension/            # ← thin re-home for src/extension.ts + commands/
│   │   ├── package.json      # publisher: "texra-ai", main: dist/extension.js
│   │   └── (build glue only — sources still live in /src)
│   └── electron/
│       ├── package.json      # name: "texra-desktop"
│       ├── electron.vite.config.ts
│       ├── electron-builder.yml
│       └── src/
│           ├── main/         # Electron main process
│           │   ├── index.ts          # createWindow, app lifecycle
│           │   ├── platform/         # Electron-backed Platform impls
│           │   │   ├── config.ts     # electron-store
│           │   │   ├── state.ts
│           │   │   ├── log.ts        # electron-log
│           │   │   ├── fs.ts         # node:fs/promises
│           │   │   ├── workspace.ts  # chokidar
│           │   │   ├── storage.ts
│           │   │   └── secrets.ts    # safeStorage
│           │   ├── ipc/              # typed channels (Zod-validated)
│           │   ├── menu.ts           # native app menu (replaces VS Code menus)
│           │   ├── protocol.ts       # texra:// handler (auth callbacks)
│           │   └── updater.ts        # electron-updater
│           ├── preload/
│           │   └── index.ts          # contextBridge → typed API
│           └── renderer/
│               ├── index.html        # shell window
│               ├── main.ts           # mounts MainApp Lit component
│               └── windows/          # progress / settings / dialog windows
└── …
```

**Why workspaces and not a separate repo:** Single source of truth, atomic refactors across `src/` and the Electron host, one CI job. Two repos means every agent-core change becomes a coordination problem.

### 6.2 Reuse boundary

Concretely, what the Electron app imports verbatim from `src/`:

| Path | What it provides | Status |
|---|---|---|
| `src/agent/` | Core, implementations, model handlers, runtime, toolUse, output, storage, remote, node | Reused 1:1 via `@agent/*` |
| `src/model/` | Model registry, capabilities, pricing | 1:1 |
| `src/latex/` | LaTeX processing, formatting, diff, TikZ, PDF | 1:1 |
| `src/tools/` | Tool implementations | 1:1 (already uses `@common/files/fsEntryType`) |
| `src/shared/` | IPC schemas, message types | 1:1 — also doubles as Electron IPC contract |
| `src/replacement/` | Text cleanup rules | 1:1 |
| `src/eventBus/` | Progress events | 1:1 |
| `src/webview/frontend/` | Main view Lit app | Mounted in Electron renderer |
| `src/progressView/frontend/` | Progress board | Mounted in Electron renderer |
| `src/settingsView/frontend/` | Settings dashboard | Mounted in Electron renderer |
| `src/auth/SupabaseClient.ts`, `tier/`, `serverKeys/` | Supabase client + tier logic | 1:1 |
| `src/utils/` (non-VS Code parts) | Generic utilities | 1:1 |
| `resources/agents/` | Agent YAML definitions | Bundled as app resources |

What we **do not** import:

- `src/extension.ts` — replaced by `apps/electron/src/main/index.ts`.
- `src/commands/` — VS Code command handlers; replaced by Electron menu actions and renderer-initiated IPC calls. Most commands are thin wrappers around `@agent/*` calls and translate trivially.
- `src/common/webview/`, `src/frontend/` — VS Code webview hosting; replaced by Electron `BrowserWindow` + `contextBridge`.
- `src/auth/UriHandler.ts` — replaced by Electron protocol handler.
- `src/auth/SupabaseAuthProvider.ts` — replaced by an Electron-native auth flow that calls the same Supabase client.

### 6.3 Platform interface implementations (Electron)

| Interface | VS Code impl (today) | Electron impl |
|---|---|---|
| `ConfigProvider` | `vscode.workspace.getConfiguration` | `electron-store` keyed by `texra.*`; schema mirrors the JSON-schema today in `package.json` `contributes.configuration` |
| `StateStore` (global) | `ExtensionContext.globalState` | `electron-store` (separate file: `state.global.json`) |
| `StateStore` (workspace) | `ExtensionContext.workspaceState` | `electron-store` instance scoped per opened project: `<project>/.texra/state.json` |
| `LogBackend` | `vscode.OutputChannel` | `electron-log` writing to `userData/logs/` plus a renderer log viewer pane |
| `FileSystemProvider` | `vscode.workspace.fs` | `node:fs/promises` + `fs-extra` (already a dep) |
| `WorkspaceProvider` | `vscode.workspace.*` (root, watchers) | Project-folder model + `chokidar`. "Open Project" replaces "Open Folder." |
| `StorageProvider` | `ExtensionContext.storageUri` etc. | `app.getPath('userData')` and per-project `<project>/.texra/` |
| `PlatformSecrets` | `vscode.SecretStorage` | Electron `safeStorage.encryptString` over an `electron-store` blob |

Each implementation is a single file. Total new code for the platform layer: ~600–900 lines.

### 6.4 IPC contract

Renderer ↔ main IPC reuses the same Zod schemas already in `src/shared/`. The `BaseViewMessageHandler` pattern that today routes `postMessage` calls in webviews maps 1:1 to `ipcRenderer.invoke` / `ipcMain.handle`. We add a thin adapter (`src/shared/transport/electron.ts`) that conforms to the same `MessageTransport` interface VS Code uses. Frontend code is unchanged.

```
Today:   webview ─postMessage─▶ MainViewMessageHandler ─▶ @agent/*
Electron: renderer ─contextBridge─▶ ipcMain handler ─▶ @agent/*
```

### 6.5 Process model

- **Main process** — app lifecycle, window management, native menu, auto-update, protocol handlers.
- **Renderer (one per window)** — Lit UI, sandboxed, `nodeIntegration: false`, `contextIsolation: true`. Talks to main via the preload bridge.
- **Utility process** — long agent runs. Spawned from main on `texra:execute`, streams events back via `MessagePort`. Crashes are recoverable; the renderer survives. (Phase 2 — Phase 1 runs agents in main for simplicity.)

### 6.6 Replacing VS Code-specific UX

| VS Code feature | Electron replacement |
|---|---|
| Activity bar view (`texra.mainView`) | Default `BrowserWindow` with the main Lit app |
| Editor diff for tool-edit approval | Monaco diff editor in a modal renderer |
| `vscode.window.showInformationMessage` etc. | Already returns through platform; new impl uses `dialog.showMessageBox` from main, or in-app toast for non-blocking |
| Status bar | Footer region in main window (already mocked in webview frontend) |
| Walkthrough (`getting-started.md`) | First-run modal that renders the same markdown |
| Command palette | In-app palette (Ctrl/Cmd+P) — small Lit component over the existing command registry |
| Keybindings (`package.json` `keybindings`) | `globalShortcut` for app-level + `electron-localshortcut` (or pure key handlers) inside renderers |
| Authentication (`AuthenticationProvider`) | OAuth flow through `texra://` protocol handler; tokens land in `safeStorage` |
| Settings UI (`contributes.configuration`) | Existing `settingsView` already renders settings as a Lit form. Point it at `electron-store` instead of `vscode.workspace.getConfiguration`. |

## 7. Build & compilation

### 7.1 Separate, additive

- **Existing extension build:** `npm run build:fast` → unchanged.
- **New Electron build:** `npm run build:electron` (root script delegating to `apps/electron`). Runs `electron-vite build` then `electron-builder --mac --win --linux`.
- **Dev:** `npm run dev:electron` → `electron-vite dev` with HMR for renderers and main-process restart.
- Both share the same `tsconfig.json` paths and the same `node_modules` (workspace hoisting).

### 7.2 Path aliases

`apps/electron/tsconfig.json` extends the root and inherits the existing `@agent/*`, `@platform`, `@webview/*`, etc. `electron-vite` reads the same aliases via `vite-tsconfig-paths`. No alias drift.

### 7.3 Native dependencies

Audit pass on first build:

- `pdf2pic` — uses `gm`/ImageMagick subprocess; already shells out, no rebuild needed. Document install in setup.
- `@cantoo/pdf-lib`, `tar`, `katex`, `markdown-it`, `lit` — all pure JS.
- `keytar` — **not used**; we use Electron's built-in `safeStorage` instead.
- `@xterm/xterm` — works in Electron renderers as-is (it already runs in browsers).
- Confirm no stray `vscode` imports leak into Electron bundles via a build-time guard (custom esbuild plugin: any import of `vscode` in `apps/electron/` fails the build).

### 7.4 Resources

`resources/agents/`, `resources/walkthroughs/`, `resources/logo-128x128.png`, replacement rules — copied into the asar via `electron-builder` `extraResources`. Loaded through `app.getAppPath()` at runtime; existing code reads via `platform().fs.readFile` so no path code changes.

## 8. Migration phases

Each phase is independently reviewable and ships behind feature flags so the extension never breaks.

### Phase 0 — Scaffolding (1 week)

- Convert root to npm workspaces.
- Move `src/` references behind workspace alias resolution; verify `npm run build:fast` still produces a working VSIX byte-identical (modulo timestamps).
- Create `apps/electron/` with `electron-vite` skeleton, blank window, "Hello TeXRA."
- Wire `npm run dev:electron`.
- **Exit criteria:** `npm run build:fast` and `npm run dev:electron` both succeed in CI.

### Phase 1 — Platform implementations (2 weeks)

- Implement all eight platform interfaces against Electron primitives.
- Wire `initPlatform()` in `apps/electron/src/main/index.ts`.
- Smoke-test: load an agent definition, list models, no UI yet.
- **Exit criteria:** A Mocha test suite (reused from `src/test/`) runs green inside the Electron main process.

### Phase 2 — Renderer + main view (2 weeks)

- Mount the existing main-view Lit app in an Electron `BrowserWindow`.
- Wire IPC adapter so existing `MessageHandler` types route through `contextBridge`.
- Stub out file picker, agent execute, model dropdown — first end-to-end "run an agent" flow.
- **Exit criteria:** Run the Direct agent on a `.tex` file from open folder. See output in the renderer.

### Phase 3 — Progress view, settings, command palette (2 weeks)

- Mount `progressView` and `settingsView` Lit apps in their own `BrowserWindow`s (or as routes in the main window — TBD by UX).
- Implement in-app command palette over the existing command registry.
- Native menu with the most-used commands.
- **Exit criteria:** Feature parity for the top 20 commands in `commandPalette` from `package.json`.

### Phase 4 — Auth, secrets, and remote agents (1 week)

- `texra://` protocol handler wired to Supabase OAuth.
- `safeStorage`-backed `PlatformSecrets`.
- API key set/remove dialogs.
- **Exit criteria:** Sign in, run a remote agent, sign out.

### Phase 5 — Editor surface for diff approval (1 week)

- Monaco-based diff modal for `texra.toolUse.requireEditApproval`.
- File preview for non-edit cases.
- **Exit criteria:** Tool-use agent that edits a file shows a diff, user approves, file changes on disk.

### Phase 6 — Packaging, signing, auto-update (1 week)

- `electron-builder.yml` with mac/win/linux targets.
- Code-signing certs procured (mac developer ID, win EV cert).
- Notarization for mac.
- `electron-updater` pointed at GitHub Releases (existing channel).
- **Exit criteria:** Signed installers produced in CI; auto-update from v0.0.1 to v0.0.2 works on all three platforms.

### Phase 7 — Beta, polish, docs (2 weeks)

- Onboarding walkthrough.
- Crash reporter (optional).
- Telemetry parity (or explicit opt-out).
- Documentation site updates.

**Total:** ~11 weeks for v1, single engineer.

## 9. Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Hidden `vscode` imports in "agnostic" zones break Electron build | Medium | Medium | Build-time guard plugin; CI check |
| `@vscode-elements/elements` styling assumes VS Code CSS variables | Medium | Low | The library ships its own CSS variables; we override the few VS Code-only ones with our theme tokens. Already partially done in webview styles. |
| Electron context-isolation breaks something the webview relied on | Low | Medium | We never used `nodeIntegration` in webviews anyway — same constraints apply |
| Supabase OAuth without VS Code's auth provider | Low | Medium | Standard loopback-redirect flow; many Electron apps do this |
| Agent runs blocking renderer | Medium | Low | Phase 2 utility-process split |
| Native deps require per-platform rebuild | Low | Medium | Audit confirms only pure-JS deps; `safeStorage` over `keytar` removes the main offender |
| User confusion: two TeXRAs on same machine sharing/colliding settings | Medium | Low | Use distinct `userData` paths; document migration path; offer one-time import from VS Code extension globalState |
| Auto-update certificate management | Medium | Medium | Use existing GitHub Releases channel; document signing key handoff |

## 10. Success criteria

- v1 ships signed installers for macOS (Universal), Windows (x64, arm64), Linux (deb, AppImage).
- A user can: sign in, open a project folder, pick an agent and model, execute, view progress, approve tool edits, see final output. End-to-end without VS Code installed.
- No regression in the VS Code extension. Same `npm run build:fast` produces a working VSIX from the same `src/`.
- Total `src/` diff for the Electron port < 500 lines (excluding new files in `apps/electron/`). Anything more means the abstraction layer leaked.
- Cold start < 2s. Memory at idle < 250MB. (Baseline: VS Code extension activation < 500ms.)

## 11. Open questions

- **Multi-window model:** does the Electron app open one window per project (like VS Code) or always a single window with project-switching? Recommend single-window + recent-projects; multi-window can come later.
- **Marketplace / discovery:** distribution via texra.ai download page, GitHub Releases, or also Mac App Store / Microsoft Store? Recommend direct download + GitHub Releases for v1; stores are a separate compliance project.
- **Pricing / tier gating:** unchanged from extension (Supabase tier checks), but confirm sign-in flow handles "no internet on first run" gracefully.
- **Bundled LaTeX:** ship without a TeX distribution (current model — user installs MacTeX/MikTeX) or bundle `tectonic`? Recommend no bundle for v1 — same UX as extension. Reconsider for v2 with `tectonic` (~30MB, statically linked).
- **Codex / external CLI agents:** Electron can spawn `@openai/codex-sdk` as today; verify PATH discovery works for non-shell-launched apps on macOS (common gotcha — fix with `fix-path` package).
- **Workspaces vs separate repo:** PRD assumes single-repo workspaces. Alternative is publishing `@texra/core` as a private npm package consumed by both targets. Workspaces preferred — simpler atomic refactors.

## 12. Appendix: tech stack one-liner

```
electron-vite + electron-builder + electron-store + safeStorage + chokidar
+ Monaco (diff only) + existing Lit/signals webviews + existing @platform
```

That's the whole story. Every other line of code already exists.
