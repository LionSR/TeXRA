# PRD: TeXRA Electron App

**Status:** Draft (v2 — grounded in codebase scout)
**Owner:** TBD
**Date:** 2026-05-02
**Branch:** `claude/texra-electron-prd-bMUQG`

## 1. Summary

Ship TeXRA as a standalone cross-platform desktop application built on Electron, alongside the existing VS Code extension. The Electron app reuses the agent core, model handlers, LaTeX processing, tool implementations, and webview UIs unchanged. Only the host shell — window management, file system, settings, secrets, command surface, edit-approval UI — is rewritten for Electron. Compilation is fully separate: the existing `npm run build:fast` pipeline keeps producing a VSIX from the same `src/`, while a new `pnpm --filter desktop build` pipeline produces signed installers.

Per a parallel codebase scout, ~88% of source files (754 of 860 TS/TSX files) have **zero** `vscode` imports. Of the remaining ~106 coupled files, the heavy hitters are localized to `src/commands/`, `src/progressView/`, `src/settingsView/`, and `src/frontend/`. The Electron port is fundamentally a host-shell rewrite, not a core rewrite.

## 2. Goals

- Standalone TeXRA app on macOS, Windows, Linux for users who don't want or can't install VS Code.
- Reuse every "VS Code-free zone" listed in `CLAUDE.md` byte-for-byte. Concretely: `src/agent/`, `src/model/`, `src/latex/`, `src/tools/`, `src/shared/`, `src/replacement/`, `src/eventBus/`, `src/webview/frontend/`, `src/progressView/frontend/`, `src/settingsView/frontend/`. Confirmed clean by scout.
- Keep the VS Code extension a first-class target. Same source tree, same agent definitions, same Zod schemas. The Electron app is additive.
- Single source of truth for agent YAMLs, IPC schemas, and the three Lit webview UIs across both targets.
- Preserve current dev workflow: `npm run build:fast` continues to produce a VSIX. New `pnpm --filter desktop dev` and `pnpm --filter desktop build` for the desktop app.
- Auto-update, code-signing, and multi-platform installers from day one of v1.

## 3. Non-goals

- **Not** a VS Code fork. We don't reimplement Monaco's full editor surface, language servers, debug protocol, or extension marketplace. The Electron app is a focused LaTeX assistant, not an IDE.
- **Not** a rewrite of the agent core, the Lit webview UIs, or the LaTeX pipeline. Code already abstracted behind `@platform` stays exactly as-is.
- **Not** mobile, web, or PWA. Separate efforts.
- **No new agent features** scoped to this PRD. Feature parity with the extension at v1.

## 4. Background

### 4.1 Why this is tractable — measured

A six-front parallel scout of the codebase confirmed:

- **853 TypeScript files** in `src/`. Only **106** import `vscode`. The remainder access host services through `platform()` from `@platform`.
- **The `Platform` interface is tiny.** Total surface across `config`, `state`, `log`, `filesystem`, `workspace`, `storage`, `secrets`: ~470 LOC of interfaces. The existing VS Code implementation is ~300 LOC across 6 files (`src/frontend/vscode/`). The Electron-side mirror is ~200–300 LOC of glue.
- **Webviews are pure Lit.** No React/Vue/Svelte. All three (`webview`, `progressView`, `settingsView`) extend `LitElement`, use `@lit-labs/signals`, communicate via Zod-validated message schemas in `src/shared/`. The transport wrapper at `src/shared/vscode.ts` already includes a fallback API for non-webview contexts — the Electron transport is essentially a one-file swap.
- **Agent runtime is `vscode`-free.** All ~141 files in `src/agent/` confirmed. Streaming uses callbacks; cancellation uses standard `AbortController`; persistence is filesystem-based JSON validated by Zod. Drops into an Electron main or utility process unchanged.
- **Diff infrastructure already exists.** `src/agent/output/diffComputation.ts` + `src/progressView/frontend/formatters/wordDiff.ts` already implement word-level inline diff over `diff-match-patch`. Reused as the Electron tool-edit approval UI — no Monaco needed.

### 4.2 Coupling inventory (the 106 files)

Categorized by VS Code API surface:

| Category                                                              | Files | Uses | Effort           | Replacement                                                                  |
| --------------------------------------------------------------------- | ----- | ---- | ---------------- | ---------------------------------------------------------------------------- |
| Window/UX (`showInformationMessage`, `withProgress`, `OutputChannel`) | 54    | 96+  | small–medium     | `dialog.showMessageBox` + in-app toast component                             |
| Workspace (`workspace.fs`, `getConfiguration`, `workspaceFolders`)    | 4–5   | 20   | small            | Already wrapped — Electron impls of `FileSystemProvider`/`WorkspaceProvider` |
| Editor (`TextDocument`, `Range`, `showTextDocument`, `vscode.diff`)   | 10+   | 56+  | **medium-large** | Lit diff component + Monaco-free preview pane                                |
| Commands (`registerCommand`, `executeCommand`)                        | 56    | 152+ | medium           | Custom command registry + IPC dispatch                                       |
| Webviews (`WebviewView`, `WebviewPanel`, `asWebviewUri`)              | 14+   | 37   | small–medium     | `BrowserWindow` + `contextBridge`                                            |
| Auth/Secrets (`authentication`, `SecretStorage`, `UriHandler`)        | 20    | 15+  | **large**        | `safeStorage` + custom protocol handler; reuse 80% of `SupabaseAuthProvider` |
| Memento (`globalState`, `workspaceState`)                             | 25    | 77   | small            | `conf`-backed `StateStore`                                                   |
| URIs/External (`Uri`, `env.openExternal`)                             | 6+    | 26   | small            | Node `URL` + `shell.openExternal`                                            |

**Two specific gotchas surfaced by the scout that aren't visible in the table:**

1. **`src/utils/config/configUtils.ts` is not platform-abstracted.** It calls `vscode.workspace.getConfiguration()` directly with a 3-namespace fallback (`x.y.z` → `texra` prefix → full `texra.x.y.z`). The Electron port either reimplements this against `conf` or — better — moves it behind `ConfigProvider`. ~126 LOC; one of the few real refactors needed in shared code.
2. **`vscode.EventEmitter`** is used in `src/auth/tier/` and `src/auth/serverKeys/`. Trivial swap to Node `EventEmitter`, but it's a real cross-cutting change.

### 4.3 What's VS Code-shaped today

Beyond platform interfaces:

1. **Webview hosting** — `BaseViewContentProvider`, `BaseViewMessageHandler`, three Vite-built Lit apps.
2. **Commands** — ~60 commands in `package.json` `contributes.commands`, dispatched through `src/commands/`.
3. **Editor surface** — open files, diff approval (`texra.toolUse.requireEditApproval`) using `vscode.commands.executeCommand('vscode.diff', ...)` in `src/frontend/approval/nativeToolEditApproval.ts:277-282`. **This is the single highest-effort port surface.**
4. **Auth** — `vscode.AuthenticationProvider` for Supabase. Custom `UriHandler` at `src/auth/UriHandler.ts` already isolates the URI-callback shape.
5. **Settings UI** — `package.json` `contributes.configuration` rendered by VS Code's settings page. (We also have a richer settings webview at `src/settingsView/` that we'll reuse.)
6. **Notifications, status bar, menus, walkthroughs.**
7. **File watchers** — `vscode.workspace.fs` watchers backing `WorkspaceProvider`.

Every item has a clean Electron-native replacement.

### 4.4 Webview reuse — measured

A deep scout enumerated every Lit component, every host-bridge call, every CSS token, and every third-party UI dep in the three frontends. The key numbers:

| Metric                                                               | Value                                                                                                          |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Total frontend LOC across the three webviews                         | 30,631                                                                                                         |
| Webview frontend LOC by view                                         | main 5,596 / progress 16,471 / settings 8,564                                                                  |
| Custom elements (`@customElement`)                                   | 62 (main 11 / progress 33 / settings 18)                                                                       |
| Abstract LitElement base classes                                     | 2 (`BaseRequestPanel`, `BaseFeedbackPanel`)                                                                    |
| Direct `acquireVsCodeApi` calls in components                        | **0** (single seam at `src/shared/vscode.ts:28`)                                                               |
| Raw `vscode.postMessage` calls bypassing the wrapper                 | **0** (36+ calls all go through `postMessage()` helper)                                                        |
| Raw `window.addEventListener('message', ...)` outside the dispatcher | 1 (in `BaseWebviewApp.ts:91`, inherited by all three)                                                          |
| Unique `--vscode-*` CSS tokens referenced                            | 53 (all have fallback values)                                                                                  |
| Hardcoded colors outside `var(--vscode-*, ...)` fallbacks            | 2 (terminal default `#1e1e1e`, markdown error `#cc0000`)                                                       |
| Components from `@vscode-elements/elements` used                     | 19 distinct (`vscode-toolbar-button` ×95, `vscode-checkbox` ×17, etc.) — all framework-agnostic web components |
| `@vscode/codicons` glyphs referenced                                 | ~50 unique, all present in the npm package's CSS                                                               |
| Monaco usage in frontends today                                      | **0** (confirmed)                                                                                              |

**Reuse breakdown across all 30,631 LOC:**

| Bucket                                                                               | LOC    | %     |
| ------------------------------------------------------------------------------------ | ------ | ----- |
| Byte-for-byte reusable                                                               | 29,550 | 96.5% |
| Token rename (`--vscode-*` → `--texra-*` mapping layer)                              | 450    | 1.5%  |
| API swap (`postMessage` wrapper transport)                                           | 490    | 1.6%  |
| Reimplementation (terminal font init, markdown error color, HTML token substitution) | 141    | 0.5%  |

**The minimum Electron-side changeset to mount all three frontends:**

- 1 file modified: `src/shared/vscode.ts` (~45 LOC) — feature-detect Electron, route through `window.electron` instead of `acquireVsCodeApi`. Component code unchanged.
- 4 new files (~250 LOC total) in `desktop/src/`: preload script, IPC bridge, window manager, per-view bootstrap.
- 1 new file: `desktop/src/renderer/themeTokens.css` defining the 53 `--vscode-*` token values for light/dark/high-contrast themes (the existing fallbacks document the defaults).
- 0 component template changes, 0 signal/context-architecture changes, 0 changes to message dispatchers.

**Pop-out machinery is preserved but unused at v1.** The existing `POP_OUT`/`POP_BACK` plumbing in `ProgressApp.ts:697-701` and `ProgressViewProvider.ts:525-571` lets the Lit app render in two contexts. We deliberately don't activate it for the desktop app — see §4.5 for the agent-native architecture. The code stays so the extension build keeps working; the Electron renderer simply ignores the messages.

**Theme detection is host-driven, not browser-driven.** Frontends don't read `prefers-color-scheme` or `data-vscode-theme-kind`; they wait for a `COMMON_COMMANDS.SET_THEME` message and update `document.body.className` (`BaseWebviewApp.ts:69-71`). Electron just sends the same message from main when its `nativeTheme.shouldUseDarkColors` changes. Zero frontend code change.

**One inconsistency worth flagging.** Main and progress views have separate dispatcher files (`mainViewDispatcher.ts`, `messageDispatcher.ts`). Settings inlines its dispatch in a switch statement inside `SettingsApp.handleMessage()`. Cleaning this up — extracting a `settingsViewDispatcher.ts` mirroring the others — is a small Tier 2 pre-refactoring (added to §9 as item #13).

**Bottom line:** webview reuse is essentially complete. The Electron port's renderer work is bridge-and-bootstrap, not UI rewriting.

### 4.5 Agent-native architecture (v1)

The Electron app is **agent-view native**: the main window is the agent surface — what users actually came to do. We deliberately do **not** mirror VS Code's activity-bar / multi-view / pop-out structure.

**Concretely:**

- **One `BrowserWindow`.** Internal routing between three modes — *launcher* (today's main view: file/agent/model picker), *progress* (today's progress view: streams, logs, approvals), *settings* (today's settings view). The existing `texra.toggleView` command already implements this routing for the extension; we reuse the same Lit components and the same routing state.
- **No pop-out, no separate progress window, no separate settings window.** Settings is a route in the same window. Diff approval renders inline inside the progress view (the existing `ToolEditRequestPanel` is the natural anchor).
- **File preview / edit defers to the OS.** `shell.openPath(filePath)` opens the file in the user's default app — TeXShop, Overleaf desktop, VS Code, whatever they prefer. We don't ship an in-app editor at v1. This was already a non-goal (§3); making it explicit here means we don't accidentally build half of one for the diff modal.
- **Drag-and-drop in:** dropping a `.tex` or folder onto the window opens it in the launcher. Native Electron event, ~20 LOC.
- **No "open in new window" affordances** for v1. Single window keeps cold-start fast, IPC simple, memory low.

**What this drops from earlier drafts:**

- The "modal `BrowserWindow` for diff approval" idea — replaced by inline rendering in the progress view.
- The pop-out branch of the progress view — code stays, message ignored.
- Per-project windows — single instance, project switcher in the launcher route.

**What it preserves:**

- Pixel-faithful Lit rendering of the existing main, progress, and settings views.
- All 62 components, all 30,631 LOC of frontend, no template changes.
- The pop-out plumbing in `ProgressApp.ts` (still used by the VS Code extension).

**If the model diverges in the future** — multi-window for power users, embedded Monaco file editor, project-switcher windows, drag-out diff to second monitor — those go in §13 as future work, not v1 scope.

## 5. Decisions (the 12 stack picks)

The "what you choose now" picks. Each is grounded in current (May 2026) state-of-the-art research and the actual TeXRA codebase. One-line rationale here; deeper justification in §6.

| #   | Concern         | Pick                                                                                                                                      | Why in one line                                                                                                                                                                                |
| --- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Bundler / dev   | **electron-vite**                                                                                                                         | Purpose-built for the Vite + esbuild split we already run; Forge's Vite plugin is officially experimental as of 7.5.0                                                                          |
| 2   | Packaging       | **electron-builder**                                                                                                                      | Best-in-class signed mac universal + signed Windows NSIS + AppImage/deb/rpm in one config; integrates with `electron-updater`                                                                  |
| 3   | Auto-update     | **electron-updater → public release repo** (separate from source repo)                                                                    | A separate public `texra-ai/texra-desktop-releases` repo unblocks `update.electronjs.org` and avoids `GH_TOKEN`-baked-into-build with the private source repo                                  |
| 4   | Settings store  | **`conf` + Zod schemas** (NOT `electron-store`)                                                                                           | `electron-store`'s validator is AJV; `conf` (its parent) lets us reuse Zod schemas as the single source of truth, matching the codebase's existing pattern                                     |
| 5   | Secrets         | **Electron `safeStorage` + `conf` blob** (NOT `keytar`)                                                                                   | `keytar` was archived Dec 2022; VS Code itself migrated to `safeStorage`                                                                                                                       |
| 6   | File watcher    | **chokidar 4**                                                                                                                            | Pure JS — `@parcel/watcher` is faster on huge trees but adds a native module under asar; LaTeX project sizes don't justify the operational cost                                                |
| 7   | Diff/preview UI | **Monaco Editor** (`monaco-editor` standalone, lazy-loaded, diff + read-only modes only)                                                  | Same diff engine VS Code uses — keeps visual + behavioral parity with the extension; bundle cost (~5–10MB) is acceptable for a desktop app and is recouped via Vite code-splitting / lazy load |
| 8   | Menu + palette  | **Native `Menu` + custom Lit palette over existing `src/commands.ts` registry**                                                           | Avoids React/cmdk; ~150 LOC reuses what's there                                                                                                                                                |
| 9   | OAuth deep-link | **Roll own** with `setAsDefaultProtocolClient` + `requestSingleInstanceLock` + `open-url` + `second-instance` + `process.argv` cold-start | Logic mirrors existing `src/auth/UriHandler.ts`; `electron-deeplink` adds 200 LOC of indirection over a 40-LOC implementation                                                                  |
| 10  | macOS PATH fix  | **`fix-path`** (cached at startup) + explicit PATH augmentation belt-and-suspenders                                                       | LaTeX/pandoc binaries live in `/Library/TeX/texbin`, `/opt/homebrew/bin`; Finder-launched apps don't see these by default                                                                      |
| 11  | Repo structure  | **pnpm workspaces, three packages** (`core`, `extension`, `desktop`)                                                                      | `workspace:*` protocol, `--filter` builds, single `tsconfig.base.json`; Turborepo is overkill for three packages                                                                               |
| 12  | Crash reporting | **Sentry Electron SDK, opt-in, native crashes only at v1**                                                                                | Free tier sufficient; opt-in matters for academic users; performance tracing off (noisy)                                                                                                       |

### Stacks explicitly rejected

- **Tauri** — would force rewriting `@anthropic-ai/sdk`, `@google/genai`, `openai`, `execa`, `pdf2pic`, `tar` for a Rust/WebView2 runtime. Not "easy reuse."
- **Electron Forge instead of electron-builder** — Forge's Vite plugin is experimental; mixing Forge makers with electron-vite means two config dialects.
- **`update.electronjs.org` directly against the source repo** — source repo is private. We sidestep this by publishing builds to a separate public `texra-ai/texra-desktop-releases` repo (see §6.2.5).
- **`electron-store`** — wraps `conf` and adds AJV; we want `conf` direct + Zod.
- **`keytar`** / **`@napi-rs/keyring`** — archived; `safeStorage` ships in Electron.
- **`@parcel/watcher`** — native deps under asar packing; not justified for our tree size.
- **CodeMirror 6** — smaller than Monaco but means a different codebase from VS Code's diff editor; we want behavioral parity, not size optimization.
- **In-house `<texra-diff-view>` over `diff-match-patch`** — earlier draft pick. Rejected after stakeholder preference for VS Code parity over bundle size; Monaco is what users expect. We keep `diff-match-patch` for the inline word-diffs in the progress view (already in `wordDiff.ts`) and use Monaco only for the side-by-side approval surface.
- **`electron-deeplink`** — wrapper over a 40-LOC built-in pattern.
- **React/Vue rewrite of webviews** — they're already Lit and work fine in Electron renderer.
- **npm workspaces** — pnpm is 2-3× faster, has `workspace:*`, has `--filter`.

## 6. Tech stack rationale (highlights)

### 6.1 Why `conf` + Zod, not `electron-store`

`electron-store` is a thin Electron wrapper on `conf` (same author, Sindre Sorhus). It adds a renderer IPC bridge and uses `app.getPath('userData')` automatically. The catch: its built-in validator is AJV. The TeXRA codebase mandates Zod as the single source of truth (`CLAUDE.md` § "Schema and Type Guidelines") and uses `z.union([New, Legacy.transform(...)])` for backward-compat (`CLAUDE.md` § "Backward Compatibility with Zod"). Going one level deeper to `conf` lets us validate at read/write with our own Zod schemas, run migrations through the same `.transform()` pipeline we already use, and avoid a second validation framework. The renderer IPC bridge isn't a loss — the renderer should never write config directly anyway; it's a `platform()` consumer.

### 6.2 Why Monaco for diff/preview

VS Code's diff editor is what TeXRA users already know — same gutters, same minimap, same keybindings. Behavioral parity matters more than bundle savings for a desktop app where users have committed to a download. We adopt `monaco-editor` (the standalone npm package, not `@monaco-editor/react`) directly, used in three constrained modes:

- **Diff editor** (`monaco.editor.createDiffEditor`) — for tool-edit approval, replacing the `vscode.commands.executeCommand('vscode.diff', ...)` call site at `src/frontend/approval/nativeToolEditApproval.ts:277-282`.
- **Read-only viewer** (`createEditor` with `readOnly: true`) — for file preview when previewing without an active diff.
- **No editing surface** — we don't expose write-mode Monaco to users in v1; that's an IDE feature we intentionally don't ship.

Bundle integration:

- Use Vite's `?worker` syntax + Monaco's standard worker setup. Workers (TS, JSON, CSS, HTML, editor) ship as separate chunks, not in the main renderer bundle.
- Lazy-load Monaco itself: the Lit component that hosts the diff (`<texra-diff-view>`) does `await import('monaco-editor')` on mount. Cold-start of the main window stays fast; first-diff opens with a brief load.
- Drop unused languages — register only `latex`, `markdown`, `plaintext`, `bibtex`, `typescript`, `python` (the ones our users actually edit). Monarch token configs for `latex` and `bibtex` are well-known recipes; we can crib them from VS Code's `texlive`/`vscode-LaTeX-Workshop` ecosystem under MIT.
- We keep `diff-match-patch` and `wordDiff.ts` for the **inline** word-diffs already shown in the progress view — Monaco isn't loaded for those.

This is essentially the pattern Sourcegraph used pre-2023 and that VS Code uses today; well-trodden.

### 6.2.5 Release-repo separation

The TeXRA source repo is private. Two complications follow:

1. **`electron-updater` against a private GitHub repo** requires a `GH_TOKEN` baked into every client at build time. That token is harvestable from any installed binary; even if it's read-only-on-releases-only, it's a bad pattern.
2. **`update.electronjs.org`** (the free CDN/redirector that handles thundering-herd traffic on releases) refuses private repos outright.

We solve both by publishing builds to a **separate public repo**, e.g. `texra-ai/texra-desktop-releases`. The release repo contains only signed installers, `latest-mac.yml` / `latest.yml` / `latest-linux.yml` manifests, and a license. The source repo's CI workflow uses a release-repo-scoped PAT (or a GitHub App with `contents: write` on just that repo) to push artifacts. Clients embed only the release-repo URL; no token in the binary.

This is a one-time setup task in Phase 6:

- Create the release repo. Add LICENSE, README pointing back to texra.ai.
- Provision a GitHub App (preferred) or fine-grained PAT scoped to the release repo only.
- Add a publish job to the source-repo CI that runs after `electron-builder` and uploads via `gh release create` with the release-repo URL.
- `electron-builder.yml` `publish.provider: github` with `owner: texra-ai`, `repo: texra-desktop-releases`.

### 6.3 Why `safeStorage` over `keytar`

`keytar` was archived Dec 2022; VS Code itself migrated off it (microsoft/vscode #185677). `safeStorage` (Electron 30+) gives Keychain (mac), DPAPI (win), libsecret/kwallet (linux when available), and `getSelectedStorageBackend()` to detect the Linux fallback to "basic" mode (encrypted with a hardcoded key). Combine with `conf` for storage of the encrypted blob, and surface a one-time "your secrets are stored with reduced security on this Linux configuration; install gnome-keyring for full protection" warning when `getSelectedStorageBackend() === 'basic'`.

### 6.4 Why pnpm workspaces, three packages

The current single-package structure makes a one-binary VSIX easy but prevents shipping a second host without dragging the whole `src/` tree into both builds. Migration to:

```
packages/
  core/        # ← src/agent, src/model, src/latex, src/tools, src/shared, src/replacement,
               #   src/eventBus, src/webview/frontend, src/progressView/frontend,
               #   src/settingsView/frontend, src/platform/*, src/utils (non-vscode)
  extension/   # ← src/extension.ts, src/commands/, src/frontend/, src/common/webview/,
               #   src/auth/, package.json contributes
  desktop/     # ← new: Electron main, preload, renderer shell
```

`pnpm` over npm: 2–3× installs, `workspace:*` protocol pins internal versions cleanly, `--filter desktop` and `--filter extension` for targeted builds. Turborepo's task pipeline is overkill for three packages — we run two parallel build commands and that's enough. Project references via `composite: true` in TS keep type-checking incremental.

This split is the **largest mechanical change** in the project. Do it before the desktop host has any code, not after.

### 6.5 Why roll-own deep-link

Existing `src/auth/UriHandler.ts` already handles the `vscode://vscode.texra/auth-callback?code=...&state=...` parse-and-dispatch logic. The Electron equivalent registers `texra://` and reuses the same parse/dispatch on the URL. Three platform-specific gotchas worth budgeting:

- **macOS:** `app.on('open-url')` fires for already-running app; for cold-start the URL arrives in `process.argv`. Capture synchronously at module top.
- **Windows:** Single-instance lock + `second-instance` event for warm starts. Cold starts have the URL in `process.argv` _before_ `ready` fires (electron/electron #40173). In dev, must pass executable path explicitly: `app.setAsDefaultProtocolClient('texra', process.execPath, [path.resolve(process.argv[1])])`.
- **Linux:** Same pattern but desktop-environment specific. Test on GNOME, KDE.

`electron-deeplink` adds ~200 LOC of indirection. Roll our own at ~40 LOC.

## 7. Architecture

### 7.1 Repo layout (proposed)

```
TeXRA/
├── package.json              # workspaces root (dev tools, lint, format, scripts)
├── pnpm-workspace.yaml
├── tsconfig.base.json        # path aliases live here, all packages extend
├── packages/
│   ├── core/                 # @texra/core
│   │   ├── package.json
│   │   ├── tsconfig.json     # composite: true, references base
│   │   └── src/              # ← agent/, model/, latex/, tools/, shared/, replacement/,
│   │                         #   eventBus/, platform/, webview/frontend/,
│   │                         #   progressView/frontend/, settingsView/frontend/,
│   │                         #   utils/ (non-vscode parts)
│   ├── extension/            # @texra/extension (publisher: texra-ai)
│   │   ├── package.json      # main: dist/extension.js
│   │   ├── esbuild.config.mjs
│   │   ├── vite.config.ts    # the existing webview-build config
│   │   └── src/              # ← extension.ts, commands/, frontend/, common/webview/,
│   │                         #   auth/, common/state/
│   └── desktop/              # @texra/desktop (Electron app)
│       ├── package.json
│       ├── electron.vite.config.ts
│       ├── electron-builder.yml
│       └── src/
│           ├── main/
│           │   ├── index.ts          # app lifecycle, window mgmt, fix-path()
│           │   ├── platform/         # Electron-backed Platform impls (8 files)
│           │   ├── ipc/              # typed channels, Zod-validated
│           │   ├── menu.ts           # native app menu
│           │   ├── protocol.ts       # texra:// handler
│           │   ├── updater.ts        # electron-updater wiring
│           │   └── pathFix.ts        # fix-path + augmentation
│           ├── preload/
│           │   └── index.ts          # contextBridge → typed renderer API
│           └── renderer/
│               ├── index.html        # main shell window
│               ├── main.ts           # mounts <main-app> Lit component from @texra/core
│               ├── windows/          # progress / settings / diff modal entrypoints
│               └── components/
│                   └── TexraDiffView.ts  # Lit wrapper around lazy-loaded Monaco diff editor
└── (no src/ at root — moved into packages/)
```

### 7.2 Code-reuse boundary

What `desktop/` imports from `core/` verbatim:

| Path under core             | What it provides                                              | LOC (approx)  |
| --------------------------- | ------------------------------------------------------------- | ------------- |
| `agent/`                    | Core, implementations, runtime, toolUse, model handlers       | ~141 files    |
| `model/`                    | Registry, capabilities, pricing                               | small         |
| `latex/`                    | Processing, formatting, diff, TikZ, PDF                       | ~20 files     |
| `tools/`                    | Tool implementations (~120 files)                             | large         |
| `shared/`                   | IPC schemas, message types — doubles as Electron IPC contract | ~75 files     |
| `replacement/`              | Text cleanup rules                                            | ~23 files     |
| `eventBus/`                 | Progress events                                               | ~2 files      |
| `webview/frontend/`         | Main Lit app                                                  | mounted as-is |
| `progressView/frontend/`    | Progress board Lit app                                        | mounted as-is |
| `settingsView/frontend/`    | Settings dashboard Lit app                                    | mounted as-is |
| `platform/`                 | The interfaces themselves                                     | ~470 LOC      |
| `utils/` (non-vscode parts) | Generic helpers                                               | varies        |

What `desktop/` does **not** import from `extension/`:

- `extension.ts` — replaced by `desktop/src/main/index.ts`.
- `commands/` — VS Code command handlers; replaced by Electron menu actions and renderer-initiated IPC.
- `common/webview/` and `frontend/` — VS Code webview hosting; replaced by `BrowserWindow` + `contextBridge`.
- `frontend/approval/nativeToolEditApproval.ts` — replaced by `desktop/src/main/ipc/editApproval.ts` + `<texra-diff-view>`.
- `frontend/vscode/` — replaced by `desktop/src/main/platform/`.
- `auth/UriHandler.ts` — replaced by `desktop/src/main/protocol.ts` (mirrors logic).
- `auth/SupabaseAuthProvider.ts` — replaced by an Electron-native version (~80% logic reuse).

### 7.3 Platform impls (Electron)

Eight files, ~250–400 LOC total. Each mirrors an existing VS Code impl in `src/frontend/vscode/`.

| Interface                | VS Code (today)                                             | Electron                                                                          |
| ------------------------ | ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `ConfigProvider`         | `vscode.workspace.getConfiguration` w/ 3-namespace fallback | `conf` instance + Zod schema mirroring `package.json` `contributes.configuration` |
| `StateStore` (global)    | `ExtensionContext.globalState`                              | `conf` (file: `state.global.json`) under `app.getPath('userData')`                |
| `StateStore` (workspace) | `ExtensionContext.workspaceState`                           | `conf` per-project: `<project>/.texra/state.json`                                 |
| `LogBackend`             | `vscode.OutputChannel`                                      | `electron-log` to `app.getPath('logs')/` + in-app log viewer pane                 |
| `FileSystemProvider`     | `vscode.workspace.fs`                                       | `node:fs/promises` + `fs-extra` (already a dep)                                   |
| `WorkspaceProvider`      | `workspace.workspaceFolders[0]` + `asRelativePath`          | Project-folder model + `chokidar`. "Open Project" replaces "Open Folder."         |
| `StorageProvider`        | `context.storageUri`, `context.globalStorageUri`            | `app.getPath('userData')` + per-project `<project>/.texra/`                       |
| `PlatformSecrets`        | `context.secrets`                                           | `safeStorage.encryptString` over a `conf`-backed JSON blob                        |

`initPlatform()` is called once at top of `main/index.ts`, before any agent code runs. Mirrors the call site in `src/extension.ts:144-153`.

### 7.4 IPC contract

Renderer ↔ main IPC reuses the Zod schemas already in `src/shared/`. The existing `BaseViewMessageHandler` pattern (which routes `postMessage` → handler in webviews today) maps 1:1 to `ipcRenderer.invoke` / `ipcMain.handle`. We add one transport adapter (`packages/core/src/shared/transport/electron.ts`) that conforms to the existing `MessageTransport` shape. The webview-side wrapper at `src/shared/vscode.ts` already includes a fallback API for non-webview contexts — we drop the Electron transport in there.

```
Today:    webview ─postMessage→ BaseViewMessageHandler → @agent/*
Electron: renderer ─contextBridge→ ipcMain handler → @agent/*
```

Net change to message-handling code: zero. Net change to transport code: one new file.

### 7.5 Process model

- **Main process** — app lifecycle, window mgmt, native menu, auto-update, protocol handler, platform impls.
- **Renderer (one per window)** — Lit UI; `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`. Talks to main via preload bridge.
- **Utility process** (Phase 4+) — long agent runs spawned from main on `texra:execute`, streaming progress events back via `MessagePort`. Crashes recoverable; renderer survives. Phase 1–3 runs agents in main for simplicity.

### 7.6 Replacing VS Code-specific UX

| VS Code feature                                                             | Electron replacement                                                                                                                                         |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Activity bar view (`texra.mainView`)                                        | Default `BrowserWindow` mounting `<main-app>`                                                                                                                |
| `vscode.commands.executeCommand('vscode.diff', ...)` for tool-edit approval | `<texra-diff-view>` Lit component wrapping `monaco.editor.createDiffEditor`, lazy-loaded; rendered in a modal `BrowserWindow` (or embedded in progress view) |
| `vscode.window.showInformationMessage` (et al.)                             | `dialog.showMessageBox` from main; in-app toast for non-blocking                                                                                             |
| Status bar                                                                  | Footer in main window (already mocked in webview frontend)                                                                                                   |
| Walkthrough (`getting-started.md`)                                          | First-run modal rendering the same markdown                                                                                                                  |
| Command palette                                                             | Lit palette (Cmd/Ctrl-Shift-P) over the existing `src/commands.ts` registry; `globalShortcut` only when window focused                                       |
| Keybindings (`package.json` `keybindings`)                                  | `app.on('browser-window-focus')` + key handlers in renderer; native menu accelerators for app-level shortcuts                                                |
| `vscode.AuthenticationProvider`                                             | `texra://` protocol handler; tokens land in `safeStorage`                                                                                                    |
| Settings UI (`contributes.configuration`)                                   | Reuse the existing `settingsView` Lit app — point it at `conf` instead of `vscode.workspace.getConfiguration`                                                |
| `vscode.window.tabGroups.close()`                                           | Window-close API for the diff modal                                                                                                                          |
| `vscode.window.onDidChangeVisibleTextEditors`                               | Dropped — diff-view ready-state comes from renderer load event                                                                                               |
| `vscode.workspace.onDidChangeConfiguration`                                 | `conf`'s `onDidChange`                                                                                                                                       |
| `vscode.EventEmitter` (in `src/auth/tier/`, `src/auth/serverKeys/`)         | Node `EventEmitter` (mechanical swap, ~10 sites)                                                                                                             |

## 8. Build & compilation

### 8.1 Separate, additive

- **Existing extension build:** `pnpm --filter extension build` (or back-compat alias `npm run build:fast` at root) → unchanged VSIX.
- **New Electron build:** `pnpm --filter desktop build` → `electron-vite build` then `electron-builder --mac --win --linux`.
- **Dev:** `pnpm --filter desktop dev` → `electron-vite dev` with HMR for renderers, main-process restart-on-change.
- Both share the same `node_modules` (workspace hoisting), the same `tsconfig.base.json` aliases.

### 8.2 Path aliases

`tsconfig.base.json` owns `@agent/*`, `@platform`, `@webview/*`, etc., **once**. `packages/extension/tsconfig.json` and `packages/desktop/tsconfig.json` extend it. `electron-vite` reads them via `vite-tsconfig-paths`. No alias drift.

### 8.3 Native dependencies — audit

Confirmed by scout:

- `pdf2pic` — uses GraphicsMagick subprocess. PATH-dependent (see §10), no native rebuild.
- `@cantoo/pdf-lib`, `tar`, `katex`, `markdown-it`, `lit` — all pure JS.
- `@anthropic-ai/sdk`, `openai`, `@google/genai`, `@openrouter/sdk`, `@modelcontextprotocol/sdk` — pure JS.
- `@openai/codex-sdk` — bundles platform-specific binaries (`@openai/codex-{linux,darwin,win32}-{arch}`). Works in Electron via subprocess spawn; binaries must be unpacked from asar (`asarUnpack` glob in `electron-builder.yml`).
- `@xterm/xterm` + `@xterm/addon-fit` — work in Electron renderers (already run in browsers).
- `chokidar` — pure JS in v4.

**No** packages with `.node` files. Confirmed.

A build-time guard plugin (custom esbuild plugin: any `import 'vscode'` in `packages/desktop/` or `packages/core/` fails the build) prevents leakage as the codebase grows.

### 8.4 Resources

`resources/agents/`, `resources/walkthroughs/`, `resources/logo-128x128.png`, replacement rules — copied into the asar via `electron-builder` `extraResources`. Loaded through `app.getAppPath()`. Existing code reads via `platform().fs.readFile`, so no path code changes.

## 9. Pre-refactorings — land these in the extension first

These changes are safe to ship in the VS Code extension today. Each one shrinks the Electron port's blast radius, none of them require Electron to land. Tier 1 are high-leverage; pick those first.

### Tier 1 — high leverage, low risk

**1. Move `src/utils/config/configUtils.ts` behind `ConfigProvider`.**
Today it calls `vscode.workspace.getConfiguration()` directly with a 3-namespace fallback (`x.y.z` → `texra.*` prefix → full `texra.x.y.z`). Push that fallback logic into the `ConfigProvider.get()` contract (or expose `getRaw()`), then route every consumer through `platform().config`. The VS Code-side `ConfigProvider` impl absorbs the namespace logic. **Why now:** this is the single hardest-to-port file in code that's nominally shared. ~126 LOC of pure refactor with zero behavior change.

**2. Introduce a `DiffViewHost` interface and move the `vscode.diff` call behind it.**
`src/frontend/approval/nativeToolEditApproval.ts:277-282` currently invokes `vscode.commands.executeCommand('vscode.diff', uri1, uri2, title, opts)` inline. Define an interface:

```ts
interface DiffViewHost {
  openDiff(
    left: DiffSource,
    right: DiffSource,
    title: string,
    opts?: DiffOpts,
  ): Promise<DiffSession>;
  closeDiff(session: DiffSession): Promise<void>;
  revealFirstChange(session: DiffSession, line: number): void;
}
```

The current native impl wraps `executeCommand`. The Electron impl swaps in Monaco. **Why now:** isolates the largest UX-rewrite behind a stable contract. Phase 5 of the port becomes "implement DiffViewHost against Monaco" instead of "rewrite the approval flow."

**3. Swap `vscode.EventEmitter` → Node `EventEmitter`** in `src/auth/tier/TierService.ts`, `src/auth/serverKeys/ServerSideKeyService.ts`, and any other `vscode.EventEmitter` site outside the explicitly VS Code-coupled zones. ~10 call sites, mechanical. **Why now:** these files leave the `vscode`-coupled set entirely and move into the agnostic core, with no functional change.

**4. Add `WorkspaceProvider.watch(pattern, listener)` to the platform interface.**
The current interface (per scout) doesn't expose file watching. Any code today that needs watchers reaches for `vscode.workspace.createFileSystemWatcher` directly, leaking. Add `watch(glob, listener): Disposable`. VS Code impl wraps `createFileSystemWatcher`; Electron impl uses chokidar later. **Why now:** prevents new leaks; gives the extension a cleaner watcher abstraction in passing.

### Tier 2 — medium leverage

**5. Extract the auth-callback URL parser.**
`src/auth/UriHandler.ts` parses the `code`/`state`/error params from the callback URI. Pull the parsing into a pure function `parseAuthCallback(url: string): AuthCallbackResult` in `src/auth/parseAuthCallback.ts` (no `vscode` import). The handler becomes a thin VS Code-specific wrapper that calls the pure function. **Why now:** the Electron protocol handler reuses the parser unchanged.

**6. Rename `src/shared/vscode.ts` → `src/shared/hostBridge.ts`.**
The file is already a transport-agnostic wrapper with a fallback API (per webview scout). The name lies. Rename, document it as the host-transport seam, keep a re-export for compatibility during the migration. **Why now:** the Electron transport drops in alongside the existing one without naming friction.

**7. Theme-token indirection layer.**
Webview Lit components reference `--vscode-button-background`, `--vscode-foreground`, etc. directly. Introduce a `--texra-*` token layer that maps to `--vscode-*` today; rewrite component CSS to reference `--texra-*`. Single search-replace, plus a small `themeTokens.css` that defines the mapping. **Why now:** Electron just ships its own `themeTokens.css` with explicit values. No per-component changes during the port.

**8. Centralize external-binary resolution in `BinaryResolver`.**
`src/utils/system/platformPaths.ts` already probes Homebrew / TeX Live / MikTeX paths. Extract a `BinaryResolver` service that's the one place `execa()` calls go through to look up `pdflatex`, `latexmk`, `pandoc`, `gm`, etc. Audit existing call sites; route them all through it. **Why now:** the Electron port's `fix-path` augmentation has a single injection point.

### Tier 3 — nice to have, can also be done during Phase 0

**9. Settings Zod schema as canonical source.**
`package.json` `contributes.configuration` is a 600-line JSON-schema literal duplicating the runtime types. Define a Zod schema in `core/` mirroring it; runtime reads validate against the Zod schema. Optionally generate `package.json` from the Zod schema (`zod-to-json-schema`). **Why now:** Electron's `conf` instance gets its schema from the same source. Zero drift between the two hosts.

**10. Audit notification leaks.**
`CLAUDE.md` already mandates that business logic returns error results, not `vscode.window.show*Message()`. Spot-check the agnostic zones for leaks (the build-time guard catches the egregious ones, but subtle wrappers like `import { window } from 'vscode'` in non-allowed zones can hide). **Why now:** any leak found here is a port blocker found cheaply.

**11. CI guard: vscode-import lint rule.**
Add an ESLint rule (or a custom check) that fails CI if any file under the "vscode-free zones" imports `vscode`. Pin the existing 754/853 ratio so it can only improve. **Why now:** prevents regression while the Electron port is in flight.

**13. Extract `settingsViewDispatcher.ts`.**
Main and progress views have separate dispatcher files; settings inlines dispatch in a switch inside `SettingsApp.handleMessage()`. Mirror the pattern of the other two — pull the switch into `src/settingsView/frontend/settingsViewDispatcher.ts`. **Why now:** all three webviews share the same shape, simplifying the IPC adapter we drop in for Electron.

**12. Codex SDK binary unpack rehearsal.**
Create a tiny harness that bundles `@openai/codex-sdk` under an asar-like wrapper (or test it via electron-builder's `asarUnpack: ['**/node_modules/@openai/codex-*/**']`) and verifies the spawn works from inside the bundle on all three OSes. **Why now:** de-risks Phase 6 packaging; surface OS-specific path bugs early.

### Suggested ordering

If we land them all, ~3–4 engineering weeks total, can be parallelized across the team. Suggested order: **3 → 1 → 4 → 2 → 5 → 6 → 11 → 7 → 8 → 9 → 10 → 12**. Cheapest-first up to the two big wins (#1 and #2), then the lint guard (#11) to lock in gains, then the rest.

Each Tier 1 item is independently shippable to the extension and produces a smaller, cleaner extension regardless of the Electron decision.

## 10. Migration phases

Each phase is independently reviewable. The extension never breaks during this work — every change is additive until Phase 6.

### Phase 0 — Monorepo split (1.5–2 weeks)

The biggest mechanical change. Do this first; everything else is downstream.

- Migrate root → pnpm workspaces. Three packages: `core`, `extension`, `desktop` (`desktop` initially empty).
- Move source files per the layout in §7.1. Update path aliases in `tsconfig.base.json`. Update import sites if needed (most stay the same via aliases).
- Refactor `src/utils/config/configUtils.ts` behind `ConfigProvider` (or accept that it remains in `extension/`).
- Swap `vscode.EventEmitter` → Node `EventEmitter` in `src/auth/tier/` and `src/auth/serverKeys/`.
- Update CI: `pnpm install`, `pnpm --filter extension build`. Verify VSIX is byte-equivalent (modulo timestamps) to pre-split build.
- **Exit criteria:** VSIX from `pnpm --filter extension build` boots in VS Code and passes existing smoke tests. Empty `desktop` package builds a "Hello TeXRA" Electron window.

### Phase 1 — Platform impls (1.5 weeks)

- All eight Electron-side `Platform` interface impls in `desktop/src/main/platform/`.
- `initPlatform(...)` wired in `desktop/src/main/index.ts`.
- `fix-path()` called at startup; PATH augmentation belt-and-suspenders.
- Smoke test: load an agent definition, list models. No UI yet.
- **Exit criteria:** A subset of `src/test/` (the platform-agnostic Mocha suites) runs green inside the Electron main process.

### Phase 2 — Renderer + main view (1.5 weeks)

Tighter than originally scoped: per the §4.4 measurement, the existing Lit components are 97% byte-for-byte reusable. Renderer work is bridge-and-bootstrap, not UI.

- 4 new files (~250 LOC) in `desktop/src/`: `preload.ts`, `ipc/bridge.ts`, `windowManager.ts`, `renderer/main.ts`.
- 1 modified file: `src/shared/vscode.ts` (~45 LOC) — feature-detect `window.electron`, fall through to `acquireVsCodeApi` otherwise. Keeps both hosts working from one codebase.
- 1 new file: `desktop/src/renderer/themeTokens.css` defining the 53 `--vscode-*` tokens for light/dark/high-contrast (cribbed from the existing fallback values).
- "Open Project" file picker → `WorkspaceProvider`.
- File select group, agent dropdown, model dropdown all functional via existing Lit components, no template changes.
- First end-to-end agent execution.
- **Exit criteria:** Run the Direct agent on a `.tex` file from an opened project. See output in renderer. Light/dark/high-contrast themes round-trip correctly. `<main-app>` renders pixel-faithful to the extension version.

### Phase 3 — Progress view, settings, command palette (1.5 weeks)

Per §4.5 (agent-native architecture): one window, internal routing.

- Mount `<progress-app>` and `<settings-app>` Lit components in the same `BrowserWindow`, switched via the existing `texra.toggleView` routing state. No new windows.
- Lit command palette over the existing `src/commands.ts` registry.
- Native `Menu` with the most-used commands (top 20 from `package.json` `commandPalette`).
- Settings tabs read/write through `conf` via `ConfigProvider`.
- **Exit criteria:** Feature parity for the top 20 commands. Settings round-trip through `conf` correctly.

### Phase 4 — Auth, secrets, remote agents (1 week)

- `texra://` protocol handler. Cold-start, warm-start, all three platforms.
- `safeStorage`-backed `PlatformSecrets`.
- Supabase OAuth flow. Reuse 80% of `SupabaseAuthProvider.ts`; new ~50-LOC adapter for Electron protocol surface.
- API key set/remove dialogs.
- GitHub auth via OAuth (no `vscode.authentication.getSession('github')` parallel — use Supabase's built-in GitHub provider).
- **Exit criteria:** Sign in, run a remote agent, sign out. Linux fallback warning appears when `safeStorage.getSelectedStorageBackend() === 'basic'`.

### Phase 5 — Diff/preview surface for tool-edit approval (1.5–2 weeks)

The single largest UI port.

- `<texra-diff-view>` Lit component wrapping `monaco.editor.createDiffEditor`. Lazy-loads Monaco on first open. Registers only the languages we ship (`latex`, `bibtex`, `markdown`, `plaintext`, `typescript`, `python`). Honors light/dark theme via existing webview tokens. ~200–400 LOC of wrapper code; Monaco itself drops in via npm.
- **Renders inline inside the progress view** (anchored to `ToolEditRequestPanel`), not in a modal `BrowserWindow`. Per §4.5 the agent-native model puts the diff in-flow with the approval card; this also removes the focus-juggling we'd hit with a modal.
- Vite worker setup: configure `monaco-editor`'s standard `MonacoEnvironment.getWorker` to point at `?worker`-built chunks. Tested on all three OSes since worker resolution under asar can be fiddly.
- `desktop/src/main/ipc/editApproval.ts` replaces `nativeToolEditApproval.ts`. Same temp-file flow (lines 246–255 of original); replaces the `vscode.commands.executeCommand('vscode.diff', ...)` call with an inline-render IPC dispatched into the progress view.
- Bash approval reuses existing `BashRequestPanel.ts` — no new work.
- File preview (the non-diff case) uses `shell.openPath()` to hand the file to the user's default app. No in-app reader.
- LaTeX preview: inject Electron-aware `openBuildDisplayIfTex` callback (already a callback injection point at `latexPreview.ts:23`). Default action: open the produced PDF via `shell.openPath()`.
- Resume flow: confirmed in scout — only conversation history is persisted, approvals are transient. No additional work.
- **Exit criteria:** Tool-use agent edits a file, user sees inline Monaco side-by-side diff, approves, file changes on disk. PDF preview opens in user's default PDF viewer.

### Phase 6 — Packaging, signing, auto-update (1.5 weeks)

- `electron-builder.yml` for mac (universal DMG + zip), win (NSIS), linux (AppImage + deb).
- Mac code signing via Apple API Key (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`); notarization via `notarytool`.
- Windows signing via Azure Trusted Signing (~$10/mo) — budget this **now**, not in week 11.
- `electron-updater` pointed at the **public** `texra-ai/texra-desktop-releases` repo (separate from the private source repo). No `GH_TOKEN` baked into clients.
- Source repo CI publishes signed builds to the release repo via a trusted GitHub Actions workflow with a release-repo-scoped PAT.
- Differential updates via blockmaps.
- `autoDownload: false` for v1; user consents per update.
- Optionally also register with `update.electronjs.org` since the release repo is public — gives a fallback CDN if the GitHub Releases API is degraded.
- **Exit criteria:** Signed installers from CI on all three platforms. Auto-update from `v0.0.1 → v0.0.2` works.

### Phase 7 — Beta, polish, docs (2 weeks)

- First-run walkthrough modal.
- Sentry Electron SDK opt-in, native crashes only, `tracesSampleRate: 0`. `beforeSend` strips file paths outside workspace root.
- Telemetry parity with extension (or explicit opt-out path).
- In-app log viewer pane.
- Documentation site updates; new download page.
- Migration doc: how to import API keys / settings from the VS Code extension's `globalState`.

**Estimated timeline (single engineer):** 11.5–13 weeks. Trimmed from the v2 estimate after the §4.4 webview scout confirmed renderer work is bridge-and-bootstrap (~250 LOC + theme tokens) rather than the originally feared UI rewrite. With a two-engineer team running Phases 1+2 in parallel after Phase 0, achievable in 7–9 weeks.

A separate scout report estimated 22–24 weeks single-dev for "full feature parity including every command and complete auth rebuild." That figure is realistic if we treat the extension's command surface as a hard requirement to port verbatim. Our Phase 3 scope is "top 20 commands"; reaching parity on all ~60 is another 4–6 weeks of straightforward porting work past v1.

## 11. Risks & mitigations

| Risk                                                                             | Likelihood | Impact | Mitigation                                                                                                                                              |
| -------------------------------------------------------------------------------- | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hidden `vscode` imports in nominally-agnostic zones break Electron build         | Medium     | Medium | Build-time guard plugin in CI. Re-run scout after every refactor.                                                                                       |
| `@vscode-elements/elements` styling assumes VS Code CSS variables                | Medium     | Low    | Library ships its own CSS variables; we override the few VS Code-only ones with theme tokens. Already partial in webview styles.                        |
| `src/utils/config/configUtils.ts` refactor breaks extension                      | Medium     | High   | Phase 0 explicitly verifies VSIX boots after refactor. Land behind feature flag if needed.                                                              |
| macOS GUI launch can't find `pdflatex`/`pandoc`/`gm`                             | High       | High   | `fix-path` at startup + explicit augmentation of `/Library/TeX/texbin`, `/opt/homebrew/bin`, `/usr/local/bin`. Log resolved PATH for support diagnosis. |
| Windows deep-link cold-start bug (electron #40173)                               | High       | Medium | Capture `process.argv` synchronously at module top of `main/index.ts`; not in async handler.                                                            |
| Linux `safeStorage` falls back to "basic" mode without keyring                   | Medium     | Medium | Detect via `getSelectedStorageBackend()`, surface one-time warning, document keyring install.                                                           |
| Code-signing budget surprise                                                     | Medium     | High   | Budget Azure Trusted Signing (~$10/mo) and Apple Developer Program ($99/yr) **before** Phase 6.                                                         |
| Auto-update certificate expires / mac notarization breaks                        | Low        | High   | Document key rotation in runbook. CI uploads test build to `latest-mac.yml` weekly to catch regressions.                                                |
| `@openai/codex-sdk` binaries don't unpack from asar                              | Medium     | Medium | `asarUnpack: ['**/node_modules/@openai/codex-*/**']` in `electron-builder.yml`. Test on all platforms.                                                  |
| User confusion: extension and desktop sharing/colliding settings on same machine | Medium     | Low    | Distinct `userData` paths. Phase 7 ships a one-time importer for API keys + settings from the VS Code globalState file.                                 |
| Monaco worker resolution fails under asar                                        | Medium     | Medium | Test all OSes in CI; configure `MonacoEnvironment.getWorker` against `?worker`-built chunks; if asar bites, `asarUnpack` the worker chunks.             |
| Monaco bundle inflates renderer cold-start                                       | Medium     | Low    | Lazy-load via `await import('monaco-editor')` only when diff opens; ship only registered languages. Initial window doesn't load Monaco at all.          |
| Release-repo publish workflow leaks PAT                                          | Low        | High   | Use a GitHub App over a PAT; scope `contents: write` to the release repo only; rotate annually.                                                         |
| Diff performance on large files                                                  | Low        | Low    | Monaco handles 100k-line files comfortably; hard cap at ~10MB with "open in external" fallback.                                                         |
| 943-line `SupabaseAuthProvider` rewrite cost underestimated                      | Medium     | Medium | Phase 4 budget is 1 week; if it slips, scope GitHub auth as fast-follow rather than v1.                                                                 |
| **Apple Developer Program lapse** invalidates all signed builds                 | Low        | Critical | $99/yr renewal must not be missed. Calendar reminder + secondary owner. Document the resign + republish recovery in the runbook.                       |
| **Code-signing identity rotation breaks the auto-update chain**                 | Medium     | High   | When Apple Developer ID or Azure Trusted Signing cert changes, existing installs can't verify the new signature. Test rotation in beta channel first.    |
| **Notarization intermittent failures** stall CI                                 | Medium     | Medium | Apple's notary service has occasional outages. Retry with backoff; don't block merges; manual override available.                                       |
| **`process.argv` deep-link cold-start** subtly differs across the three OSes    | High       | Medium | macOS, Windows (#40173), Linux argv shapes diverge on cold-start. Test all four flows × three OSes (12 cases) explicitly in Phase 4.                    |
| **macOS App Nap / Windows modern standby** kills the renderer mid-run           | Medium     | Medium | `powerSaveBlocker.start('prevent-app-suspension')` while an agent run is in-flight. Release on idle.                                                    |
| **`asar` packing misses native binaries** (Codex SDK, Monaco workers, codicon font) | Medium  | High   | `electron-builder.yml` `asarUnpack` glob covers `@openai/codex-*/**`, Monaco worker chunks, the codicon TTF. Verified per-platform in CI.               |
| **Codex SDK platform-binary mismatch** under mac-universal builds               | Low        | High   | Confirm `@openai/codex-sdk`'s install-time platform detection works under `electron-builder` lipo'd builds. Test ARM64 + x64 explicitly.                |
| **`safeStorage` Linux fallback to "basic" mode** = secrets with a hardcoded key | Medium     | High   | Detect via `getSelectedStorageBackend()`. Surface a one-time warning. Document keyring install. Don't silently degrade.                                 |
| **Single-instance lock collides** with extension running on same machine        | Medium     | Low    | Use distinct lock IDs. Test cohabitation explicitly.                                                                                                    |
| **Subprocess env leaks API keys** via `ps`-style enumeration                    | Medium     | Medium | Pass keys via stdin / temp file with restrictive perms where SDKs support it. Audit existing `execa` call sites.                                        |
| **IPC message size limits** (~100MB) hit on large diffs / long transcripts      | Low        | Medium | Stream large payloads via `MessagePort` chunks; "diff too large" → `shell.openPath()` fallback at ~10MB.                                                |
| **License compliance** — codicons CC-BY-4.0 requires attribution                | Low        | Medium | Bundle `LICENSES.txt` and visible attribution in About box. Audit Monaco (MIT), codicons (CC-BY-4.0), `@vscode-elements/elements` (Apache-2.0), KaTeX, highlight.js. |
| **Sentry sourcemap upload regression** = useless crash reports                  | Low        | Medium | `electron-builder` `afterAllArtifactBuild` hook uploads sourcemaps; CI guard fails the release if upload step skipped.                                  |
| **Custom protocol hijack** — another app registers `texra://` after us          | Low        | Low    | Re-assert on every launch via `setAsDefaultProtocolClient`. Document in support FAQ.                                                                    |
| **Renderer memory growth** on long sessions (no auto-recycle)                   | Medium     | Low    | Virtualize logs via `@lit-labs/virtualizer` (already a dep). Soft cap on retained log lines; spill to file.                                             |
| **Cross-platform path normalization** in persisted runs                         | Medium     | Medium | Store POSIX-style internally; convert to `path.sep` only at the OS boundary. Audit storage code for naive `path.join` use.                              |
| **Corp proxy / SSL inspection** breaks model API or auto-update                 | Medium     | Medium | Respect `HTTP_PROXY` / `HTTPS_PROXY`. Electron's `net` module does by default; verify SDKs do too. Document for IT admins.                              |

## 12. Success criteria

- v1 ships signed installers: macOS (Universal DMG + ZIP), Windows (NSIS x64 + arm64), Linux (AppImage + deb).
- A user can: sign in (or set API key), open a project folder, pick an agent and model, execute, view progress, approve tool edits via the new diff component, see final output. End-to-end without VS Code installed.
- No regression in the VS Code extension. Same `pnpm --filter extension build` produces a working VSIX from the same `packages/core/`.
- Total Electron-side new code (in `packages/desktop/`) under ~3,000 LOC. Diff in `packages/core/` and `packages/extension/` (excluding the monorepo move itself) under ~500 LOC. Anything more means an abstraction leak.
- Cold start < 2s. Memory at idle < 250MB.
- Auto-update verified end-to-end on all three platforms before v1 announcement.
- Sentry confirms <1% crash rate on native code paths in beta cohort before public v1.

## 13. Open questions

- ~~**Multi-window model:** one window per project (VS Code-style) or single window with project-switcher?~~ **Resolved (§4.5):** single window, project-switcher in the launcher route. Multi-window deferred to §13.1.
- ~~**Diff window: modal vs embedded?**~~ **Resolved (§4.5):** embedded inline in the progress view, anchored to `ToolEditRequestPanel`.
- **Distribution:** texra.ai download page + GitHub Releases for v1. Mac App Store / Microsoft Store are separate compliance projects — defer.
- **Pricing/tier gating:** unchanged from extension (Supabase tier checks). Confirm "no internet on first run" path doesn't lock users out.
- **Bundled LaTeX:** v1 expects user-installed TeX (current model). Reconsider `tectonic` (~30MB statically-linked) for v2.
- **Codex CLI PATH discovery:** verify that `@openai/codex-sdk`'s bundled binaries are found from inside the asar after `asarUnpack`, on all three platforms.
- **GitHub auth:** drop the existing experimental `texra.auth.enableVSCodeGitHub` flag in Electron; use Supabase's GitHub OAuth provider directly. Confirm the edge function token-exchange flow (`GITHUB_TOKEN_EXCHANGE_URL`) still works without the VS Code session.
- **Migration path:** users with existing VS Code extension install — do we offer a one-shot importer (read `globalState` JSON, copy API keys via SecretStorage if accessible)? Phase 7 candidate.

### 13.1 Future divergence (post-v1)

Things explicitly out of scope for v1 under the agent-native model. Each is a coherent post-v1 chunk if demand surfaces.

- **In-app file editor.** Today users open files via `shell.openPath()` to their default app. A future v2 could embed Monaco in a non-diff editing surface (right pane in progress view, or a new "edit" route). Bundle and feature scope grows substantially — defer until users ask.
- **Multi-window pop-out.** The Lit code already supports it (`POP_OUT`/`POP_BACK`). Re-enabling means wiring the desktop renderer to spawn a second `BrowserWindow` and run the same Lit bundle there. Add when multi-monitor users complain.
- **Per-project windows** (VS Code "open folder in new window"). Requires single-instance lock changes, per-window `Platform` scoping, and IPC for cross-window state. Significant work; not justified by current usage patterns.
- **Bundled TeX distribution** (`tectonic` or similar, ~30MB statically linked). Saves users from MikTeX/MacTeX install. Worth a v2 experiment.
- **Drag diff to a second monitor.** Requires the multi-window infrastructure above plus diff-state serialization across windows.
- **Native PDF viewer pane.** Today PDFs open in the OS default viewer. An embedded `pdf.js`-based viewer would let us scroll-sync with the source — interesting but not v1.
- **File-tree explorer in the launcher route.** v1 launcher is "pick the input file"; a v2 could show the project tree, modification times, and last-run status per file.
- **Settings-as-code** (read/write a `texra.config.yaml` instead of `conf` JSON). Some users will want to commit settings to repos. Easy add later.
- **CLI mode** (`texra run agent --input foo.tex`). Headless invocations from a terminal, useful for batch jobs. Already feasible today since the agent core is `vscode`-free; just needs a CLI entry point in a fourth `packages/cli/` workspace.

## 14. Appendix: Reuse-by-the-numbers

From the parallel scout:

| Metric                                                               | Value                                           |
| -------------------------------------------------------------------- | ----------------------------------------------- |
| Total TS/TSX files in `src/`                                         | 853                                             |
| Files importing `vscode`                                             | 106 (12.4%)                                     |
| `Platform` interface LOC                                             | ~470                                            |
| Existing VS Code platform impl LOC                                   | ~303 (6 files)                                  |
| Estimated Electron platform impl LOC                                 | ~250–400 (8 files)                              |
| Lines in `nativeToolEditApproval.ts` (the diff blocker)              | 439                                             |
| Estimated `<texra-diff-view>` Lit wrapper LOC (Monaco hosted inside) | ~200–400                                        |
| Lines in `SupabaseAuthProvider.ts`                                   | 943                                             |
| Estimated reuse from `SupabaseAuthProvider.ts`                       | ~80%                                            |
| Estimated `desktop/src/` total LOC at v1                             | ~3,000                                          |
| Estimated diff in `core/` for monorepo split                         | ~0 (path aliases handle it)                     |
| Estimated diff in `core/` for behavioral changes                     | ~500 (configUtils refactor + EventEmitter swap) |
| Total Lit frontend LOC across the three webviews                     | 30,631                                          |
| Frontend LOC reused byte-for-byte                                    | 29,550 (96.5%)                                  |
| Frontend LOC needing `--vscode-*` token shim                         | 450 (1.5%)                                      |
| Frontend LOC needing transport-wrapper swap                          | 490 (1.6%)                                      |
| Frontend LOC needing genuine reimplementation                        | 141 (0.5%)                                      |
| Custom elements (`@customElement`) reused                            | 62                                              |
| Unique `--vscode-*` CSS tokens to shim                               | 53                                              |

## 15. Tech stack one-liner

```
electron-vite + electron-builder + electron-updater (→ public release repo)
+ conf + safeStorage + chokidar4 + Monaco (lazy-loaded, diff + read-only)
+ Lit (existing) + diff-match-patch (existing, inline only) + fix-path
+ pnpm workspaces (3 packages) + Sentry Electron (opt-in)
```

That's the whole story. Every other line of code already exists.
