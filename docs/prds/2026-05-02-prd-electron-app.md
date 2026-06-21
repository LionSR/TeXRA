---
created: 2026-05-02
updated: 2026-06-11
---

# PRD: TeXRA Electron App

**Status:** Draft (v2 — grounded in codebase scout)
**Owner:** TBD
**Date:** 2026-05-02
**Branch:** `claude/texra-electron-prd-bMUQG`

## 1. Summary

Ship TeXRA as a standalone cross-platform desktop application built on Electron, alongside the existing VS Code extension. The Electron app reuses the agent core, model handlers, LaTeX processing, tool implementations, and webview UIs unchanged. Only the host shell — window management, file system, settings, secrets, command surface, edit-approval UI — is rewritten for Electron. Compilation is fully separate: the existing extension build keeps producing a VSIX from the same shared sources (the agnostic core moves into `packages/core/` during Phase 0; see §7.1), while a new `pnpm --filter desktop build` pipeline produces signed installers.

Per a parallel codebase scout, ~88% of source files (747 of 853 TS/TSX files) have **zero** `vscode` imports. Of the remaining 106 coupled files, the heavy hitters are localized to `src/commands/`, `src/progressView/`, `src/settingsView/`, and `src/frontend/`. The Electron port is fundamentally a host-shell rewrite, not a core rewrite.

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
- **Webviews are pure Lit.** No React/Vue/Svelte. All three (`webview`, `progressView`, `settingsView`) extend `LitElement`, use `@lit-labs/signals`, communicate via Zod-validated message schemas in `src/shared/`. The transport wrapper at `src/shared/hostBridge.ts` includes a fallback API for non-webview contexts — the Electron transport is essentially a one-file swap.
- **Agent runtime is `vscode`-free.** All ~141 files in `src/agent/` confirmed. Streaming uses callbacks; cancellation uses standard `AbortController`; persistence is filesystem-based JSON validated by Zod. **Runs in the Electron main process at v1.** Per §9 #20, the runtime takes an `AgentRuntimeHost` / `ProgressSink` as a constructor dep (no `ProgressEventBus` singleton import) so utility-process execution becomes a single adapter swap in v2 (§13.1).
- **Inline word-diff infrastructure already exists.** `src/agent/output/diffComputation.ts` + `src/progressView/frontend/formatters/wordDiff.ts` already implement word-level inline diff over `diff-match-patch` — reused as-is in the Electron progress view. The side-by-side approval surface is built on Monaco (see §6.2); the two layers compose cleanly.

### 4.2 Coupling inventory (the 106 files)

Categorized by VS Code API surface:

| Category                                                              | Files | Uses | Effort           | Replacement                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------- | ----- | ---- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window/UX (`showInformationMessage`, `withProgress`, `OutputChannel`) | 54    | 96+  | small–medium     | `dialog.showMessageBox` + in-app toast component                                                                                                                                                                                                                            |
| Workspace (`workspace.fs`, `getConfiguration`, `workspaceFolders`)    | 4–5   | 20   | small            | Already wrapped — Electron impls of `FileSystemProvider`/`WorkspaceProvider`                                                                                                                                                                                                |
| Editor (`TextDocument`, `Range`, `showTextDocument`, `vscode.diff`)   | 10+   | 56+  | **medium-large** | Lit `<texra-diff-view>` wrapping Monaco's diff editor (lazy-loaded); file preview defers to OS via `shell.openPath()`                                                                                                                                                       |
| Commands (`registerCommand`, `executeCommand`)                        | 56    | 152+ | medium           | Custom command registry + IPC dispatch                                                                                                                                                                                                                                      |
| Webviews (`WebviewView`, `WebviewPanel`, `asWebviewUri`)              | 14+   | 37   | small–medium     | `BrowserWindow` + `contextBridge`                                                                                                                                                                                                                                           |
| Auth/Secrets (`authentication`, `SecretStorage`, `UriHandler`)        | 20    | 15+  | **large**        | `safeStorage` + custom protocol handler; per §9 #14, both `SupabaseAuthProvider` and `SupabaseClient` extracted to `core/` with a `TokenProvider` boundary (~1,000 LOC moved), then ~50 LOC of Electron host glue. No "% reuse" — it's two classes with thin host wrappers. |
| Memento (`globalState`, `workspaceState`)                             | 25    | 77   | small            | `conf`-backed `StateStore`                                                                                                                                                                                                                                                  |
| URIs/External (`Uri`, `env.openExternal`)                             | 6+    | 26   | small            | Node `URL` + `shell.openExternal`                                                                                                                                                                                                                                           |

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
| Direct `acquireVsCodeApi` calls in components                        | **0** (single seam at `src/shared/hostBridge.ts`)                                                              |
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

- 1 file modified: `src/shared/hostBridge.ts` (~45 LOC) — read the Electron bridge from `HOST_BRIDGE_API_KEY`, falling back to `acquireVsCodeApi` for VS Code. Component code unchanged.
- 3 new files (~230 LOC total) in `desktop/src/`: `main/ipc.ts`, `preload/index.ts`, `renderer/main.ts`. Window creation is inline in `main/index.ts` (per §7.1).
- 1 new file: `desktop/src/renderer/themeTokens.css` defining the 53 `--vscode-*` token values for light/dark/high-contrast themes (the existing fallbacks document the defaults).
- 0 component template changes, 0 signal/context-architecture changes, 0 changes to message dispatchers.

**Pop-out machinery is preserved but unused at v1.** The existing `POP_OUT`/`POP_BACK` plumbing in `ProgressApp.ts:697-701` and `ProgressViewProvider.ts:525-571` lets the Lit app render in two contexts. We deliberately don't activate it for the desktop app — see §4.5 for the agent-native architecture. The code stays so the extension build keeps working; the Electron renderer simply ignores the messages.

**Theme detection is host-driven, not browser-driven.** Frontends don't read `prefers-color-scheme` or `data-vscode-theme-kind`; they wait for a `COMMON_COMMANDS.SET_THEME` message and update `document.body.className` (`BaseWebviewApp.ts:69-71`). Electron just sends the same message from main when its `nativeTheme.shouldUseDarkColors` changes. Zero frontend code change.

**One inconsistency worth flagging.** Main and progress views have separate dispatcher files (`mainViewDispatcher.ts`, `messageDispatcher.ts`). Settings inlines its dispatch in a switch statement inside `SettingsApp.handleMessage()`. Cleaning this up — extracting a `settingsViewDispatcher.ts` mirroring the others — is a small Tier 2 pre-refactoring (added to §9 as item #13).

**Bottom line:** webview reuse is essentially complete. The Electron port's renderer work is bridge-and-bootstrap, not UI rewriting.

### 4.5 Agent-native architecture (v1)

The Electron app is **agent-view native**: the main window is the agent surface — what users actually came to do. We deliberately do **not** mirror VS Code's activity-bar / multi-view / pop-out structure.

**Concretely:**

- **One `BrowserWindow`.** Internal routing between three modes — _launcher_ (today's main view: file/agent/model picker), _progress_ (today's progress view: streams, logs, approvals), _settings_ (today's settings view). The existing `texra.toggleView` command already implements this routing for the extension; we reuse the same Lit components and the same routing state.
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

## 5. Decisions (12 core picks + §5.1 small libraries)

The 12 core architectural picks below define the stack's shape. §5.1 layers in six small one-purpose libraries that solve recurring Electron pain (window state, context menus, Monaco workers, logging, tests). §5.2 is the explicit anti-list. §5.3 covers module-system modernization.

Each pick is grounded in current (May 2026) state-of-the-art research and the actual TeXRA codebase. One-line rationale here; deeper justification in §6.

| #   | Concern         | Pick                                                                                                                                      | Why in one line                                                                                                                                                                                                                                                           |
| --- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Bundler / dev   | **electron-vite**                                                                                                                         | Purpose-built for the Vite + esbuild split we already run; Forge's Vite plugin is officially experimental as of 7.5.0                                                                                                                                                     |
| 2   | Packaging       | **electron-builder**                                                                                                                      | Best-in-class signed mac universal + signed Windows NSIS + AppImage/deb/rpm in one config; integrates with `electron-updater`                                                                                                                                             |
| 3   | Auto-update     | **electron-updater → public release repo** (separate from source repo)                                                                    | Avoids `GH_TOKEN`-in-binary problems; the public repo is for `electron-builder`'s `latest*.yml` flow only. We don't layer `update.electronjs.org` (Squirrel-only, mac+win, no Linux).                                                                                     |
| 4   | Settings store  | **`conf` + Zod schemas** (NOT `electron-store`)                                                                                           | `electron-store`'s validator is AJV; `conf` (its parent) lets us reuse Zod schemas as the single source of truth, matching the codebase's existing pattern                                                                                                                |
| 5   | Secrets         | **Electron `safeStorage` + `conf` blob** (NOT `keytar`)                                                                                   | `keytar` was archived Dec 2022; VS Code itself migrated to `safeStorage`                                                                                                                                                                                                  |
| 6   | File watcher    | **chokidar 4**                                                                                                                            | Pure JS — `@parcel/watcher` is faster on huge trees but adds a native module under asar; LaTeX project sizes don't justify the operational cost                                                                                                                           |
| 7   | Diff UI         | **Monaco Editor** (`monaco-editor` standalone, lazy-loaded, **diff editor only** at v1)                                                   | Same diff engine VS Code uses — keeps visual + behavioral parity with the extension; bundle cost (~5–10MB) is acceptable for a desktop app and is recouped via Vite code-splitting / lazy load. File preview is `shell.openPath()` (§4.5), not a Monaco read-only viewer. |
| 8   | Menu + palette  | **Native `Menu` + custom Lit palette over a host-agnostic command catalog (extracted from `src/commands.ts` per §9 #17)**                 | Avoids React/cmdk; existing `src/commands.ts` imports `vscode` so it can't be reused directly — the catalog is the metadata layer (id, title, category, icon, keybinding) that both hosts wire actions to.                                                                |
| 9   | OAuth deep-link | **Roll own** with `setAsDefaultProtocolClient` + `requestSingleInstanceLock` + `open-url` + `second-instance` + `process.argv` cold-start | Logic mirrors existing `src/auth/UriHandler.ts`; `electron-deeplink` adds 200 LOC of indirection over a 40-LOC implementation                                                                                                                                             |
| 10  | macOS PATH fix  | **`fix-path`** (cached at startup) + explicit PATH augmentation belt-and-suspenders                                                       | LaTeX/pandoc binaries live in `/Library/TeX/texbin`, `/opt/homebrew/bin`; Finder-launched apps don't see these by default                                                                                                                                                 |
| 11  | Repo structure  | **pnpm workspaces, three packages** (`core`, `extension`, `desktop`)                                                                      | `workspace:*` protocol, `--filter` builds, single `tsconfig.base.json`; Turborepo is overkill for three packages                                                                                                                                                          |
| 12  | Crash reporting | **Sentry Electron SDK, opt-in, native crashes only at v1**                                                                                | Free tier sufficient; opt-in matters for academic users; performance tracing off (noisy)                                                                                                                                                                                  |

### Stacks explicitly rejected

- **Tauri** — would force rewriting `@anthropic-ai/sdk`, `@google/genai`, `openai`, `execa`, `pdf2pic`, `tar` for a Rust/WebView2 runtime. Not "easy reuse."
- **Electron Forge instead of electron-builder** — Forge's Vite plugin is experimental; mixing Forge makers with electron-vite means two config dialects.
- **`update.electronjs.org`** — Squirrel-based feed service for `autoUpdater` (mac + win only, no Linux). Not a drop-in fallback for `electron-builder`'s `latest*.yml` artifact flow. The public release repo is built for `electron-updater`, not for this service.
- **`electron-store`** — wraps `conf` and adds AJV; we want `conf` direct + Zod.
- **`keytar`** / **`@napi-rs/keyring`** — archived; `safeStorage` ships in Electron.
- **`@parcel/watcher`** — native deps under asar packing; not justified for our tree size.
- **CodeMirror 6** — smaller than Monaco but means a different codebase from VS Code's diff editor; we want behavioral parity, not size optimization.
- **In-house `<texra-diff-view>` over `diff-match-patch`** — earlier draft pick. Rejected after stakeholder preference for VS Code parity over bundle size; Monaco is what users expect. We keep `diff-match-patch` for the inline word-diffs in the progress view (already in `wordDiff.ts`) and use Monaco only for the side-by-side approval surface.
- **`electron-deeplink`** — wrapper over a 40-LOC built-in pattern.
- **React/Vue rewrite of webviews** — they're already Lit and work fine in Electron renderer.
- **npm workspaces** — pnpm is 2-3× faster, has `workspace:*`, has `--filter`.

### 5.1 Small modern conveniences (low cost, high payoff)

A handful of mature one-purpose libraries that solve real Electron pain points in <500 LOC each. Each is a "don't reinvent" pick — the alternative is rolling our own subtly-buggy version.

| Pick                                           | Solves                                                                                                               | Why this not roll-own                                                                                                                                           |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`electron-window-state`**                    | Persist `BrowserWindow` size/position across launches; clamp to current display geometry on monitor changes          | Multi-monitor edge cases (window restored off-screen, screen disconnected) are the kind of thing nobody gets right the first time. ~200 LOC, mature.            |
| **`electron-context-menu`**                    | Right-click menu in renderer with sensible defaults (Cut/Copy/Paste in inputs, Inspect Element in dev, custom items) | Default Electron has no context menu; users notice immediately. Lib is configurable, themeable.                                                                 |
| **`vite-plugin-monaco-editor`**                | Wires Monaco's web workers under Vite (TS, JSON, CSS, HTML, editor workers as separate `?worker` chunks)             | The manual `MonacoEnvironment.getWorker` setup is tricky under asar; this plugin is the canonical solution.                                                     |
| **`electron-log`**                             | File-rotated logs under `app.getPath('logs')`, renderer→main forwarding, Sentry transport                            | Already implicit in §7.3 (`LogBackend` impl). Pino is more modern but Node-only. `electron-log` ships the renderer integration we need.                         |
| **`Vitest`** (Electron-side)                   | Test runner for `packages/core/` and `packages/desktop/`; existing extension tests stay on Mocha                     | We already use Vite — Vitest reuses the same config, transformers, and aliases. Faster and more modern than Mocha for new tests; doesn't disrupt the extension. |
| **`@playwright/test`** + `playwright-electron` | E2E renderer tests for the Electron app                                                                              | Spectron was deprecated by the Electron team in 2022; Playwright is the documented modern replacement and matches the broader testing ecosystem.                |

Total added dep weight: ~1.5MB before tree-shaking. All actively maintained, all Electron-aware, all backed by either Sindre Sorhus or VS Code/Microsoft.

### 5.2 Tooling discipline: things we explicitly do NOT add

The temptation when starting a new app is to grab every "modern" tool. Here's the anti-list, with reasoning, so future contributors don't reopen these:

- **Bun (instead of pnpm)** — Bun's compatibility with native Electron toolchain (`electron-builder`, `electron-rebuild`) isn't bulletproof yet. pnpm is the conservative-modern pick. Revisit in 12 months.
- **Biome (instead of ESLint + Prettier)** — Existing project is on ESLint flat config + Prettier. Biome is faster (Rust) but switching means rewriting the config and losing the existing rule set. Not justified for the Electron port specifically.
- **`electron-trpc` / `@trpc/server`** — Type-safe IPC over tRPC sounds good, but the codebase already has Zod-validated message dispatchers (per §4.4 scout). Adding tRPC is a parallel layer of typing without removing the existing one.
- **`electron-conf` (instead of `conf`)** — Adds a renderer-side IPC bridge. The renderer should not be writing config directly; that's a `platform()` consumer concern. `conf` in main is sufficient.
- **`better-sqlite3` for state** — Native dep + asar unpacking + migration tooling for what's currently flat JSON files. v1 doesn't have data volumes that justify it. v2 if session histories grow.
- **`electron-trayWindow` / dock helpers** — TeXRA isn't a tray app; we don't need a docked-window pattern.
- **`@electron/remote`** — Officially deprecated. We use `contextBridge` + IPC, the modern path.
- **`spectron`** — Deprecated by Electron team in 2022; Playwright is the replacement.
- **A custom IPC abstraction layer** — The `BaseViewMessageHandler` pattern already in `src/common/webview/` is the dispatcher; we add a transport adapter and stop. New abstractions accumulate cost.

### 5.3 Module system + tsconfig modernization (Electron side)

The existing extension is CommonJS (`"module": "commonjs"` in `tsconfig.json`). The Electron desktop app should be ESM-first since Electron 28+ supports ESM in main, and the renderer is already ESM via Vite.

| Layer                       | `module` / `moduleResolution`                                | Notes                                                                                       |
| --------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `packages/core/`            | `"module": "esnext"`, `"moduleResolution": "bundler"`        | Consumed by both extension (CJS) and desktop (ESM) — bundlers handle the format conversion. |
| `packages/extension/`       | `"module": "commonjs"` (unchanged)                           | VS Code extension host expects CJS. No churn.                                               |
| `packages/desktop/main`     | `"module": "nodenext"`, `"type": "module"` in `package.json` | Modern Electron main process; ESM with top-level await for `await fixPath()`.               |
| `packages/desktop/renderer` | `"module": "esnext"`, `"moduleResolution": "bundler"`        | Vite handles bundling; same conventions as the existing webview frontends.                  |

This is a Phase 0 decision — gets it right once during the monorepo split. CommonJS-only modules in `core/` (if any sneak in) get caught at build time.

## 6. Tech stack rationale (highlights)

### 6.1 Why `conf` + Zod, not `electron-store`

`electron-store` is a thin Electron wrapper on `conf` (same author, Sindre Sorhus). It adds a renderer IPC bridge and uses `app.getPath('userData')` automatically. The catch: its built-in validator is AJV. The TeXRA codebase mandates Zod as the single source of truth (`CLAUDE.md` § "Schema and Type Guidelines") and uses `z.union([New, Legacy.transform(...)])` for backward-compat (`CLAUDE.md` § "Backward Compatibility with Zod"). Going one level deeper to `conf` lets us validate at read/write with our own Zod schemas, run migrations through the same `.transform()` pipeline we already use, and avoid a second validation framework. The renderer IPC bridge isn't a loss — the renderer should never write config directly anyway; it's a `platform()` consumer.

### 6.2 Why Monaco for diff

VS Code's diff editor is what TeXRA users already know — same gutters, same minimap, same keybindings. Behavioral parity matters more than bundle savings for a desktop app where users have committed to a download. We adopt `monaco-editor` (the standalone npm package, not `@monaco-editor/react`) directly, used in **one** constrained mode at v1:

- **Diff editor** (`monaco.editor.createDiffEditor`) — for tool-edit approval, replacing the `vscode.commands.executeCommand('vscode.diff', ...)` call site at `src/frontend/approval/nativeToolEditApproval.ts:277-282`.
- **No file viewer, no editing surface.** Per §4.5 (agent-native), file preview defers to the OS via `shell.openPath()` — TeXShop, Overleaf desktop, VS Code, whatever the user prefers. A Monaco read-only viewer would be the start of an in-app editor; we explicitly defer that to §13.1.

Bundle integration:

- Use Vite's `?worker` syntax + Monaco's standard worker setup. Workers (TS, JSON, CSS, HTML, editor) ship as separate chunks, not in the main renderer bundle.
- Lazy-load Monaco itself: the Lit component that hosts the diff (`<texra-diff-view>`) does `await import('monaco-editor')` on mount. Cold-start of the main window stays fast; first-diff opens with a brief load.
- Drop unused languages — register only `latex`, `markdown`, `plaintext`, `bibtex`, `typescript`, `python` (the ones our users actually edit). Monarch token configs for `latex` and `bibtex` are well-known recipes; we can crib them from VS Code's `texlive`/`vscode-LaTeX-Workshop` ecosystem under MIT.
- We keep `diff-match-patch` and `wordDiff.ts` for the **inline** word-diffs already shown in the progress view — Monaco isn't loaded for those.

This is essentially the pattern Sourcegraph used pre-2023 and that VS Code uses today; well-trodden.

### 6.2.5 Release-repo separation

The TeXRA source repo is private. Two complications follow:

1. **`electron-updater` against a private GitHub repo** requires a `GH_TOKEN` to be available at update-check time. The two delivery paths are: (a) bake the token into the build (harvestable from any installed binary, bad pattern), or (b) require each end-user to set `GH_TOKEN` in their environment (works but is a deployment-burden non-starter for desktop apps). Either way, the private repo is the wrong shape for client distribution.
2. **`update.electronjs.org`** (a Squirrel-based feed service for the legacy `autoUpdater` API) is a separate, incompatible update path — mac + win only, no Linux, no blockmap differential updates. It refuses private repos outright. We're not using it; this is just to head off "why don't we use it?" questions.

We solve both by publishing builds to a **separate public repo**, e.g. `texra-ai/texra-desktop-releases`. The release repo contains only signed installers, `latest-mac.yml` / `latest.yml` / `latest-linux.yml` manifests, and a license. The source repo's CI workflow uses a release-repo-scoped PAT (or a GitHub App with `contents: write` on just that repo) to push artifacts. Clients embed only the release-repo URL; no token in the binary.

This is a one-time setup task in Phase 6:

- Create the release repo. Add LICENSE, README pointing back to texra.ai.
- Provision a GitHub App (preferred) or fine-grained PAT scoped to the release repo only.
- Add a publish job to the source-repo CI that runs after `electron-builder` and uploads via `gh release create` with the release-repo URL.
- `electron-builder.yml` `publish.provider: github` with `owner: texra-ai`, `repo: texra-desktop-releases`.

### 6.3 Why `safeStorage` over `keytar`

`keytar` was archived Dec 2022; VS Code itself migrated off it (microsoft/vscode #185677). `safeStorage` (Electron 15+) gives Keychain (mac), DPAPI (win), libsecret/kwallet (linux when available); `getSelectedStorageBackend()` (Electron 30+) returns one of `'basic_text'`, `'gnome_libsecret'`, `'kwallet'`, `'kwallet5'`, `'kwallet6'`, or `'unknown'`. The Linux fallback to plaintext (`'basic_text'`) is encrypted with a hardcoded key — effectively no protection. Combine with `conf` for storage of the encrypted blob, and surface a one-time "your secrets are stored with reduced security on this Linux configuration; install gnome-keyring for full protection" warning when `getSelectedStorageBackend() === 'basic_text'`.

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

Existing `src/auth/UriHandler.ts` already handles the `vscode://vscode.texra/auth-callback?code=...&state=...` parse-and-dispatch logic. The Electron equivalent registers `texra://` and reuses the same parse/dispatch on the URL. The platforms diverge meaningfully on cold-start delivery — get this wrong and packaged macOS auth callbacks silently disappear:

- **macOS — always `open-url`.** Register `app.on('open-url', (event, url) => ...)` **before** `app.whenReady()` resolves. The OS delivers all `texra://` URLs through this event, both for warm-start (already-running app) and cold-start (launches the app). `process.argv` does **not** contain the URL on macOS in either case. Missing the early registration is the canonical "auth callbacks broken on first launch" bug.
- **Windows — `second-instance` for warm-start, `process.argv` for cold-start.** Cold-start: the URL arrives in `process.argv` _before_ `ready` fires (electron/electron #40173). Capture synchronously at module top. Warm-start: rely on `app.requestSingleInstanceLock()` + `app.on('second-instance', (event, argv) => ...)`. In dev, must pass executable path explicitly: `app.setAsDefaultProtocolClient('texra', process.execPath, [path.resolve(process.argv[1])])`.
- **Linux — same as Windows** for argv/second-instance shape, plus desktop-environment specifics. Test on GNOME and KDE.

`electron-deeplink` adds ~200 LOC of indirection. Roll our own at ~40 LOC, with the platform branch made explicit.

### 6.6 Industry-tested patterns we adopt (and why)

The "one source tree, multiple targets" problem is well-trodden. VS Code, Slack, Standard Notes, Discord, and Linear have all converged on a similar set of patterns. This section names them explicitly so the team has shared vocabulary, defends against drift, and can defer architectural decisions to "what does VS Code do here?" instead of inventing.

| Pattern                                  | Industry source                                                                           | TeXRA realization                                                                                                                                                       |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hexagonal / ports & adapters**         | Cockburn 2005 — universal in modern apps                                                  | `core/platform/*.ts` defines ports (`ConfigProvider`, `LogBackend`, etc.); `extension/frontend/vscode/*.ts` and `desktop/main/platform/*.ts` are adapters.              |
| **Composition root**                     | Mark Seemann, _Dependency Injection Principles_                                           | `extension/src/extension.ts:144` and `desktop/src/main/index.ts` are the only places `initPlatform()` is called. Everywhere else uses `platform()`.                     |
| **Thin shell over a kernel**             | VS Code (`src/vs/` + `code/` binary), Standard Notes (`web` core + 5K-LOC Electron shell) | `@texra/core` is the kernel; `@texra/extension` and `@texra/desktop` are thin shells. §12 caps the desktop shell at ~3,000 LOC.                                         |
| **Bare-minimum port surface**            | VS Code (every API addition is a debate)                                                  | `Platform` is 7 interfaces, ~470 LOC. New methods need a documented reason. (Codified in CLAUDE.md's "platform()" rule.)                                                |
| **Test the kernel with fakes**           | Hexagonal architecture orthodoxy                                                          | `FakePlatform` impl in `core/test/fakes/` (Phase 1) lets Vitest run agent + LaTeX + tool tests in <1s with zero host setup. **Make this explicit.**                     |
| **TS project references**                | Microsoft's own monorepo guidance                                                         | `tsconfig.base.json` + `composite: true` on each package; `tsc --build` understands the graph (§8.2).                                                                   |
| **Strict-direction imports**             | Nx, Turborepo, custom ESLint rules                                                        | Per the §8.1 matrix: `core/` imports nothing from siblings; `extension/` and `desktop/` may import only from `core/`. Enforced by ESLint.                               |
| **Environment-tagged folders**           | VS Code (`src/vs/{common,node,browser,electron-main,electron-sandbox}/`)                  | **Considered, deferred.** See discussion below — TeXRA's scale doesn't yet justify the reorg.                                                                           |
| **Per-OS CI matrix**                     | electron-builder docs; Slack, Discord, Cursor                                             | Three parallel jobs on macos/windows/ubuntu runners + aggregator (§8.1).                                                                                                |
| **Per-target build with shared bundler** | electron-vite, vite-plugin-electron, Tauri                                                | electron-vite drives main/preload/renderer; existing extension build keeps esbuild + Vite (§8.1).                                                                       |
| **Capability check, not host check**     | Modern cross-platform JS (e.g. `tabs` API)                                                | Code calls `platform().secrets.set(...)` not `if (isElectron) ...`. Avoids lock-in; new hosts (web, CLI) can flip capabilities on. (Existing pattern — keep enforcing.) |

#### Why we don't adopt VS Code's environment-tagged folders (yet)

VS Code splits `src/vs/` into `common/` (pure JS), `node/` (Node API), `browser/` (DOM API), `electron-main/`, and `electron-sandbox/`. Each file's location declares which APIs it can use; the build pipeline targets a subset cleanly, and accidentally importing `fs` from a `browser/` file is a directory-violation lint error.

It's a great pattern. We do **not** adopt it for v1 because:

1. **Scale.** VS Code has ~10× our file count and is genuinely deployed to 4+ environments (desktop, web, GitHub Codespaces, dev containers). TeXRA targets 2 environments. The reorg cost (~853 file moves + path-alias updates) doesn't pay off for two targets.
2. **`Platform` already enforces what matters.** The env-tagged folders' main value is "catch leaks at organization time." We catch them at lint time via the §9 #11 vscode-import rule, and at runtime via `platform()` discipline.
3. **Future-proofing.** If we ever add a third target (browser-only PWA, headless CLI, mobile WebView), we revisit. Until then it's premature.

What we **do** borrow from VS Code's structure: clear naming of the kernel (`core/`), a documented composition root, and the principle that environment leakage is a lint error, not a code-review nit.

#### Build orchestration revisited: pnpm alone vs Turborepo / Nx / Moon

With 3 packages and 2 build entry points (`pnpm --filter extension build`, `pnpm --filter desktop build`), Turborepo's task graph and remote cache are overkill. Plain pnpm workspaces gives:

- Per-package install caching (already 2-3× faster than npm).
- `--filter` for targeted builds.
- `workspace:*` protocol for crisp internal-version pinning.
- `pnpm install --frozen-lockfile` for reproducible CI.

We revisit if any of these become true:

- More than 5 packages.
- Multiple "leaf" packages depending on common ancestors (build-graph parallelization actually helps).
- A monorepo-wide `lint`/`test`/`build` umbrella that benefits from caching.
- Distributed CI runners that benefit from remote cache.

For now: **pnpm alone, plus `tsc --build` for incremental TS, plus the per-OS CI matrix for the desktop release.** Turborepo / Nx stay on the §13.1 future-divergence list.

### 6.7 Testing strategy — three surfaces, no host coupling

VS Code testing is genuinely hard. The state of testing in this repo today, verified empirically:

- `npm test` runs `vscode-test`, which downloads a VS Code test electron and boots Mocha inside the extension host. `CLAUDE.md` forbids it because it fails. **Doesn't work.**
- An unofficial route exists: ~25 Mocha test files in `src/test/` plus `src/test/setup.ts` + `src/test/support/vscode-mock.ts` for stubbing the `vscode` import. There's also `test-loader.mjs` that registers `tsconfig-paths` for ESM. Trying to invoke it directly fails with `SyntaxError: Identifier 'resolve' has already been declared` in the loader. **Also doesn't work.**
- Net result: there is currently no working way to run the kernel test suite. The tests exist, the mocks exist, but the runner is broken.

This is a problem #16 (FakePlatform + Vitest migration) doesn't just optimize — it fixes. The replacement is:

**Three test surfaces, in increasing cost:**

| Surface                 | Tooling                                    | Where it runs                                   | Speed             | What it covers                                                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------ | ----------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Kernel tests**        | Vitest + `FakePlatform`                    | Pure Node (any CI)                              | <1s for the suite | Agent runtime, model handlers, LaTeX processing, tool implementations, replacement rules, schema validation. ~80% of the test budget. The existing 25 Mocha tests get migrated.                                                |
| **Platform-impl tests** | Vitest against real platform impls (no UI) | Node + Electron's main-process libs             | seconds           | The eight `desktop/main/platform/*.ts` files (and the existing VS Code adapters in `extension/frontend/vscode/`). Each runs the same invariant suite `FakePlatform` passes — guarantees behavioral parity. ~15% of the budget. |
| **E2E tests**           | Playwright + `playwright-electron`         | Spawns the packaged Electron app, drives the UI | tens of seconds   | Sign-in flow, agent execution, tool-edit approval, project switcher. A handful of golden-path scenarios. ~5% of the budget.                                                                                                    |

**What we deliberately do NOT do:**

- **Don't try to fix `vscode-test`.** Tests that genuinely need a VS Code host (extension activation, command registration, real `WebviewView`) are a small minority and not in the v1 critical path. They can stay broken in this repo until the VS Code team's `@vscode/test-electron` story improves; we'll revisit if a real bug forces it. Until then, those tests live alongside the extension code as documentation.
- **Don't try to run the kernel tests inside Electron.** The kernel doesn't depend on Electron. Vitest in plain Node is faster, cheaper, and runs on any CI.
- **Don't test the renderer in jsdom.** Lit components need real DOM + custom-elements + shadow DOM. Vitest's browser mode (Playwright-driven) is the right tool when component tests are warranted; we lean on E2E for v1.

**The `FakePlatform` invariant suite is the contract.** Every platform impl — `FakePlatform`, the existing VS Code adapters, the new Electron adapters — passes the same Vitest suite. If a kernel test passes on one host but fails on another, the platform contract is being violated and we know exactly where to look.

This isn't a TeXRA invention. It's the pattern VS Code uses for its workbench tests, Standard Notes uses for desktop/mobile parity, and every hexagonal codebase converges on. The novelty for TeXRA is moving from a broken `vscode-test`/Mocha pipeline to a working Vitest one — that's the actual delta.

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
│           │   ├── index.ts          # lifecycle, single-instance lock, fix-path(), createWindow()
│           │   │                     #   (electron-window-state inlined; no separate windowManager.ts)
│           │   ├── platform/         # 8 Electron-backed Platform impls (one per interface)
│           │   ├── ipc.ts            # ipcMain.handle(rpc) + webContents.send(push) — single file
│           │   ├── menu.ts           # native Menu (top 20 commands)
│           │   ├── protocol.ts       # texra:// handler (auth callbacks)
│           │   ├── updater.ts        # electron-updater wiring
│           │   ├── contextMenu.ts    # electron-context-menu config
│           │   ├── log.ts            # electron-log → LogBackend impl
│           │   ├── pathFix.ts        # fix-path + explicit PATH augmentation
│           │   └── editApproval.ts   # diff-temp-file flow (replaces nativeToolEditApproval.ts)
│           ├── preload/
│           │   └── index.ts          # contextBridge: per-view typed methods (texra.main.*, texra.progress.*, texra.settings.*, texra.diff.*) + per-view push subscriptions (texra.on.*); no generic rpc(channel, msg). See §7.4.
│           └── renderer/
│               ├── index.html        # single-window shell
│               ├── main.ts           # mounts <main-app>/<progress-app>/<settings-app> from
│               │                     #   @texra/core; routes via existing toggleView state
│               ├── themeTokens.css   # 53 --vscode-* → --texra-* mappings (light/dark/HC)
│               └── TexraDiffView.ts  # Lit wrapper around lazy-loaded Monaco diff editor
└── (no src/ at root — moved into packages/)
```

**Layout rationale (fewer middlemen):**

- `windowManager.ts` collapsed into `main/index.ts` — it was just `new BrowserWindow(...)` plus an `electron-window-state` call; not worth a file.
- `ipc/` directory collapsed to a single `ipc.ts` — there's one `rpc` handler and one `push` sender, nothing more to organize.
- `renderer/components/` directory dropped — only one component (`TexraDiffView.ts`) at v1; promote when there are 3+.
- `renderer/windows/` (separate window entrypoints) dropped — single window per §4.5.

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
- `frontend/approval/nativeToolEditApproval.ts` — replaced by `desktop/src/main/editApproval.ts` + `<texra-diff-view>` (path matches §7.1's collapsed layout).
- `frontend/vscode/` — replaced by `desktop/src/main/platform/`.
- `auth/UriHandler.ts` — replaced by `desktop/src/main/protocol.ts` (mirrors logic).
- `auth/SupabaseAuthProvider.ts` + `auth/SupabaseClient.ts` — both moved to `core/auth/` per §9 #14 with a `TokenProvider` boundary; the Electron-side wrapper is ~50 LOC of glue.

### 7.3 Platform impls (Electron)

Eight files, ~250–400 LOC total. Each mirrors an existing VS Code impl in `src/frontend/vscode/`.

| Interface                | VS Code (today)                                                                     | Electron                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ConfigProvider`         | `vscode.workspace.getConfiguration` w/ 3-namespace fallback                         | `conf` instance + Zod schema mirroring `package.json` `contributes.configuration`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `StateStore` (global)    | `ExtensionContext.globalState`                                                      | `conf` (file: `state.global.json`) under `app.getPath('userData')`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `StateStore` (workspace) | `ExtensionContext.workspaceState` (app-private Memento) for **all** workspace state | **Two storage classes, not one** (the existing extension also conflates them — fix it once at port time): (a) **small mementos** (last-selected agent, last-opened tab, UI toggles, migration markers) in `conf` keyed by hashed project path under `userData/workspace-state/<sha256(projectPath)>.json`; (b) **run artifacts** (agent history, stream logs, task states, run instructions, output-file metadata) under append-oriented per-run directories at `userData/projects/<sha256(projectPath)>/runs/<runId>/`. Append-only writes, explicit retention/compaction (default: keep last 50 runs per project, summarize older). **Not** in `<project>/.texra/` either way. Putting run artifacts in `conf` JSON would mean rewriting the same blob on every progress event — works in demos, garbage under real sessions. |
| `LogBackend`             | `vscode.OutputChannel`                                                              | `electron-log` to `app.getPath('logs')/` + in-app log viewer pane                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `FileSystemProvider`     | `vscode.workspace.fs`                                                               | `node:fs/promises` + `fs-extra` (already a dep)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `WorkspaceProvider`      | `workspace.workspaceFolders[0]` + `asRelativePath`                                  | Project-folder model + `chokidar`. "Open Project" replaces "Open Folder."                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `StorageProvider`        | `context.storageUri`, `context.globalStorageUri`                                    | `app.getPath('userData')` (global) + per-project storage scoped under `userData/projects/<sha256(projectPath)>/` (NOT inside the user's repo, same reasoning as `StateStore` workspace).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `PlatformSecrets`        | `context.secrets`                                                                   | `safeStorage.encryptString` over a `conf`-backed JSON blob                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

`initPlatform()` is called once at top of `main/index.ts`, before any agent code runs. Mirrors the call site in `src/extension.ts:144-153`.

### 7.4 IPC contract — capability-scoped channels, one schema

Renderer and main process exchange messages, but **the IPC layer is also a security boundary**. The renderer renders markdown, model output, file content, and tool transcripts — treating an XSS or prototype-pollution there as impossible would be wrong. Zod validates payload _shape_, not _authority_: a generic `texra:rpc` channel that accepts any well-formed message lets a compromised renderer ask main to execute any privileged controller action. The bridge has to enforce **what** the renderer is allowed to call, not just **whether** the message is parseable.

**Capability model: one channel per view, one allowlisted method set per channel.**

| Channel              | Sender (preload exposes)               | `ipcMain.handle` allowlist (controllers)        | Lives at                             |
| -------------------- | -------------------------------------- | ----------------------------------------------- | ------------------------------------ |
| `texra:main-rpc`     | `window.texra.main.<method>(args)`     | `MainViewController.<allowlisted methods>`      | main window's `<main-app>`           |
| `texra:progress-rpc` | `window.texra.progress.<method>(args)` | `ProgressViewController.<allowlisted methods>`  | progress route in main window        |
| `texra:settings-rpc` | `window.texra.settings.<method>(args)` | `SettingsViewController.<allowlisted methods>`  | settings route in main window        |
| `texra:diff-rpc`     | `window.texra.diff.<method>(args)`     | `editApproval` only (approve/reject)            | diff component embedded in progress  |
| `texra:<view>-push`  | `ipcRenderer.on(...)`                  | (host → renderer; one-way; no allowlist needed) | each view subscribes to its own push |

The preload script does **not** expose a generic `rpc(channel, msg)` function. It exposes per-view namespaces with explicit method shapes:

```ts
// desktop/preload/index.ts
contextBridge.exposeInMainWorld('texra', {
  main: {
    runWorkflow: (args: RunWorkflowArgs) =>
      ipcRenderer.invoke('texra:main-rpc:runWorkflow', args),
    selectFiles: (args: SelectFilesArgs) =>
      ipcRenderer.invoke('texra:main-rpc:selectFiles', args),
    // ...one method per allowlisted controller method
  },
  progress: {
    approveEdit: (args: ApproveEditArgs) =>
      ipcRenderer.invoke('texra:progress-rpc:approveEdit', args),
    // ...
  },
  // ...
  on: {
    progress: (cb: (msg: PushMessage) => void) =>
      ipcRenderer.on('texra:progress-push', (_, m) => cb(m)),
    // ...
  },
});
```

**Authority checks in `ipcMain`:**

1. Each `ipcMain.handle('texra:<view>-rpc:<method>', ...)` is registered exactly once and points to one typed controller method. There is no "look up method by string" path.
2. Before dispatching, the handler validates `event.senderFrame`: it must be the main frame of an expected `BrowserWindow`. A message claiming to come from main but from an off-screen frame or another window is rejected. (At v1 with one window: `event.senderFrame === mainWindow.webContents.mainFrame`.)

**What this layer does and does not protect against.** Be honest about the boundary, especially because XSS from rendered markdown / model output is in the threat model:

- ✅ **Bounds the attack surface.** A compromised renderer can only call allowlisted methods with allowlisted payload shapes against the specific controllers we wired. It can't ask main to execute arbitrary code, read arbitrary files, or open arbitrary processes — the bridge has no generic "execute" or "spawn" path.
- ✅ **Blocks off-frame / off-window senders.** `event.senderFrame` validation stops messages from third-party origins or stray frames.
- ✅ **Validates payloads.** Zod runs after authority is established.
- ❌ **Does NOT enforce cross-view isolation in a single window.** A compromised renderer running the progress route can still invoke `texra:settings-rpc:*` methods. We do **not** trust renderer-reported route state for authorization — that would be checkable-state-from-the-untrusted-side. Per-view channel naming exists for code organization and auditability, not security separation across views in the same window.
- ❌ **Does NOT prevent abuse of legitimately exposed methods.** If a method has destructive side effects, that method itself needs server-side rules (rate limits, confirmation flows via `PromptHost`, idempotency keys) — the IPC layer can't substitute for per-method authorization.

If real cross-view isolation becomes a requirement post-v1 (e.g., embedding untrusted third-party agent dashboards), the right answer is per-view sandboxed `BrowserView`/`<webview>` tags or separate `BrowserWindow`s, not stronger checks on a single shared renderer. Documented in §13.1 as a future-divergence item. 3. Zod validates the args _after_ authority is established, against the per-method schema.

**Push direction** (host → renderer) uses `webContents.send('texra:<view>-push', message)`. Pushes go to specific views, not broadcast. The renderer's per-view dispatcher remains unchanged from the existing webview pattern.

**Streaming large payloads** (Phase 5+): for diffs >1MB or transcripts that risk hitting Electron's IPC size limit (~100MB), bypass the push channel and use a `MessageChannelMain` / `MessagePort` between main and renderer. Streamed via the same Zod schemas, just on a different transport. The MessagePort is also capability-scoped — one port per view, established by the main process, never created by the renderer.

**Net change to dispatcher / schema code:** zero — the existing Zod schemas and per-view discriminated-union dispatch transfer unchanged. **Net change to the bridge layer:** the preload exposes per-view namespaces (~150 LOC) and main registers one `ipcMain.handle` per allowlisted controller method (~250 LOC of type-safe glue replacing the previously imagined ~150 LOC generic dispatcher). **Handler code does change materially** per §9 #18 — controllers move from `extension/` into `core/`.

### 7.5 Process model

- **Main process** — app lifecycle, window mgmt, native menu, auto-update, protocol handler, platform impls.
- **Renderer (one per window)** — Lit UI; `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`. Talks to main via preload bridge.
- **No utility process at v1, but the boundary exists.** Agents run in the main process at v1, but the agent runtime takes `AgentRuntimeHost` / `ProgressSink` as a constructor dep (per §9 #20), not a singleton. v1 ships an `InProcessProgressSink` that forwards to in-process subscribers; v2's utility-process variant ships a `MessagePortProgressSink` against the same interface. No rewrites of progress / approval / cancellation / logging when v2 lands. Deferred to §13.1 because the v2 _implementation_ (utility-process spawning + IPC plumbing) isn't worth doing for v1, but the _abstraction_ lands now to prevent the cross-cutting rewrite later.

### 7.6 Replacing VS Code-specific UX

| VS Code feature                                                             | Electron replacement                                                                                                                                                             |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Activity bar view (`texra.mainView`)                                        | Default `BrowserWindow` mounting `<main-app>`                                                                                                                                    |
| `vscode.commands.executeCommand('vscode.diff', ...)` for tool-edit approval | `<texra-diff-view>` Lit component wrapping `monaco.editor.createDiffEditor`, lazy-loaded; rendered **inline** in the progress view (anchored to `ToolEditRequestPanel`) per §4.5 |
| `vscode.window.showInformationMessage` (et al.)                             | `dialog.showMessageBox` from main; in-app toast for non-blocking                                                                                                                 |
| Status bar                                                                  | Footer in main window (already mocked in webview frontend)                                                                                                                       |
| Walkthrough (`getting-started.md`)                                          | First-run modal rendering the same markdown                                                                                                                                      |
| Command palette                                                             | Lit palette (Cmd/Ctrl-Shift-P) over the host-agnostic command catalog (§9 #17); `globalShortcut` only when window focused                                                        |
| Keybindings (`package.json` `keybindings`)                                  | `app.on('browser-window-focus')` + key handlers in renderer; native menu accelerators for app-level shortcuts                                                                    |
| `vscode.AuthenticationProvider`                                             | `texra://` protocol handler; tokens land in `safeStorage`                                                                                                                        |
| Settings UI (`contributes.configuration`)                                   | Reuse the existing `settingsView` Lit app — point it at `conf` instead of `vscode.workspace.getConfiguration`                                                                    |
| `vscode.window.tabGroups.close()`                                           | Renderer dismisses the inline `<texra-diff-view>` (no separate window — see §4.5)                                                                                                |
| `vscode.window.onDidChangeVisibleTextEditors`                               | Dropped — diff-view ready-state comes from the Lit component's connected callback                                                                                                |
| `vscode.workspace.onDidChangeConfiguration`                                 | `conf`'s `onDidChange`                                                                                                                                                           |
| `vscode.EventEmitter` (in `src/auth/tier/`, `src/auth/serverKeys/`)         | Node `EventEmitter` (mechanical swap, ~10 sites)                                                                                                                                 |

## 8. Build & compilation

### 8.1 Build separation — strict

Two independent build graphs sharing one source tree. The separation is enforced at the package level: `pnpm --filter extension` and `pnpm --filter desktop` cannot accidentally cross-pollute because they have separate `dist/` outputs, separate `package.json` `main`/`exports`, separate dependency closures (only `core/` is shared), and separate CI jobs.

| Concern                | Extension build                                 | Desktop build                                                       |
| ---------------------- | ----------------------------------------------- | ------------------------------------------------------------------- |
| Command                | `pnpm --filter extension build`                 | `pnpm --filter desktop build`                                       |
| Output                 | `packages/extension/dist/` → VSIX               | `packages/desktop/dist/` + `packages/desktop/release/` → installers |
| Bundler                | esbuild (host) + Vite (3 webviews)              | electron-vite (main + preload + renderer)                           |
| Module format          | CommonJS (VS Code requires)                     | ESM (Electron 28+ in main, Vite in renderer)                        |
| Dev loop               | `npm run watch:fast` (unchanged)                | `pnpm --filter desktop dev` (electron-vite HMR)                     |
| CI runner              | One Linux runner (cross-OS-irrelevant)          | Per-OS matrix (mac/win/linux) — see below                           |
| Signing identity       | None (extension is unsigned in the marketplace) | Apple Developer ID (mac) + Azure Trusted Signing (win)              |
| Release artifact       | `texra-{version}.vsix` → vsce/ovsx publish      | Signed installers → public release repo                             |
| Allowed to import from | `@texra/core` only                              | `@texra/core` only                                                  |
| **Forbidden imports**  | Anything from `@texra/desktop`                  | Anything from `@texra/extension` or `vscode`                        |

**Cross-pollution guards** (CI):

1. ESLint rule: `packages/extension/**/*.ts` may import `vscode` and `@texra/core/*`; nothing else from siblings.
2. ESLint rule: `packages/desktop/**/*.ts` may import `electron` and `@texra/core/*`; nothing else.
3. Build-time fail: if `electron-vite` ever resolves a path under `packages/extension/`, the build errors.
4. The pre-existing vscode-import lint rule from §9 #11 catches any vscode import sneaking into `core/` or `desktop/`.

**Per-OS CI matrix** (Phase 6) — mac signing only works on macOS, NSIS signing only works on Windows (or via Azure Trusted Signing remote service), AppImage assembly is reliable only on Linux. The release workflow runs three jobs in parallel on `macos-latest`, `windows-latest`, `ubuntu-latest`. Each job:

- Checks out the repo, runs `pnpm install`.
- Runs `pnpm --filter desktop build` (electron-vite produces the same JS bundle on every OS).
- Runs `electron-builder` with that OS's targets only (`-m` / `-w` / `-l`).
- Signs locally using OS-resident credentials (mac uses notarytool; win uses Azure Trusted Signing; linux is unsigned but checksummed).
- Uploads installers + blockmaps + per-OS manifest as workflow artifacts.

A fourth aggregator job (Linux runner) downloads all artifacts, merges manifests into `latest-mac.yml` / `latest.yml` / `latest-linux.yml`, and pushes to the public release repo. Each OS job runs independently — a flake on the Windows runner doesn't block the mac release.

**Local dev:** developers running `pnpm --filter desktop build` on their own machine get only their OS's installer; that's expected and fine for testing. Cross-OS builds happen only in CI.

- Both share the same `tsconfig.base.json` aliases. No shared `dist/`, no shared cache, no shared bundler config.

**Per-package dependency hygiene (hard rule).** pnpm hoists transitive deps to the workspace root for dev convenience, but **packaged installers don't ship the workspace root** — `electron-builder` prunes against `packages/desktop/package.json`'s declared production dependencies. So:

1. Every package declares **every runtime dependency it imports** in its own `package.json` (`dependencies`, not `peerDependencies` or root-only). No reaching through hoisted siblings.
2. Phase 6 CI step: build the desktop installer, extract the asar, list every package under `app.asar/node_modules/`, and verify the set matches the closure of `packages/desktop/package.json` `dependencies`. Fail the release on any extra or missing package.
3. A `pnpm install --frozen-lockfile --filter desktop --prod` in CI catches "I imported it in dev but didn't declare it" mismatches before they reach packaging.
4. The vscode-import lint rule from §9 #11 has a sibling rule: `desktop/` and `core/` cannot import packages not declared in their own `package.json`.

Workspace hoisting is dev convenience, not an architectural property. Treat it that way.

### 8.2 Path aliases

`tsconfig.base.json` owns `@agent/*`, `@platform`, `@webview/*`, etc., **once**. `packages/extension/tsconfig.json` and `packages/desktop/tsconfig.json` extend it. `electron-vite` reads them via `vite-tsconfig-paths`. No alias drift.

### 8.3 Native dependencies — audit

Confirmed by scout:

- `pdf2pic` — uses GraphicsMagick subprocess. PATH-dependent (see §10), no native rebuild.
- `@cantoo/pdf-lib`, `tar`, `katex`, `markdown-it`, `lit` — all pure JS.
- `@anthropic-ai/sdk`, `openai`, `@google/genai`, `@openrouter/sdk`, `@modelcontextprotocol/sdk` — pure JS.
- `@openai/codex-sdk` — bundles platform-specific binaries (`@openai/codex-{linux,darwin,win32}-{arch}`). The SDK is constructed with `codexPathOverride: findCodexBinaryPath()`, where the helper uses `createRequire(__dirname)` to resolve platform packages and falls back to global npm + PATH. **`asarUnpack` alone is not enough** — `createRequire` doesn't automatically prefer `app.asar.unpacked/` over `app.asar/`, so a packaged build can resolve to an asar path that won't spawn or silently use a stale global Codex. v1 plan: extend `findCodexBinaryPath()` (per #8 `BinaryResolver`) to detect `app.isPackaged` and resolve from `process.resourcesPath/app.asar.unpacked/node_modules/@openai/codex-{platform}-{arch}/...` first, then fall back to `createRequire`. Phase 6 harness verifies the exact resolved path.
- `@xterm/xterm` + `@xterm/addon-fit` — work in Electron renderers (already run in browsers).
- `chokidar` — pure JS in v4.

**Runtime closure has no `.node` files.** Verified by walking `package-lock.json` — every package containing native bindings (`@rolldown/binding-*`, `lightningcss-*-*`) is marked `dev: true, optional: true`, so they're Vite/Rolldown build-time only and never ship in the production bundle. To prevent regression, Phase 6 packaging adds a CI check that fails if `electron-builder`'s emitted asar contains any `.node` file we didn't explicitly allow-list (Codex SDK is the only exception, and ships unpacked from asar via `asarUnpack` — see §8.4).

A build-time guard plugin (custom esbuild plugin: any `import 'vscode'` in `packages/desktop/` or `packages/core/` fails the build) prevents leakage as the codebase grows.

### 8.4 Resources

`resources/agents/`, `resources/walkthroughs/`, `resources/logo-512x512.png`, replacement rules — bundled **inside `app.asar`** via `electron-builder`'s `files` glob (so `app.getAppPath() + '/resources/...'` resolves correctly in dev and after packaging). Existing code reads via `platform().fs.readFile`, so no path code changes.

**Two distinct asset locations to keep straight in `electron-builder.yml`:**

- **`files`** (default — bundled inside `app.asar`): YAML agent definitions, walkthrough markdown, logos, replacement rules, every TS/JS we ship. Path: `app.getAppPath()` + relative.
- **`asarUnpack`** (extracted from asar at install time, lives under `process.resourcesPath/app.asar.unpacked/...`): native binaries that subprocess-spawn won't tolerate inside an asar. Currently just `**/node_modules/@openai/codex-*/**`. Resolve via `process.resourcesPath + '/app.asar.unpacked/...'`.

We do **not** use `extraResources` for v1 — it places files in `process.resourcesPath` (a third pathing convention) with no benefit for our asset shapes. Reserved for the future only if we ever ship user-patchable assets meant to be edited out-of-band.

## 9. Pre-refactorings — land these in the extension first

These changes are safe to ship in the VS Code extension today. Each one shrinks the Electron port's blast radius, none of them require Electron to land. Tier 1 are high-leverage; pick those first.

### Tier 1 — high leverage, low risk

**1. Expand `ConfigProvider` to a full settings store; route `configUtils.ts` through it.** _(~200 LOC added to interface + VS Code adapter; ~126 LOC of `configUtils.ts` body refactored to thin wrappers; ~40 LOC of consumer-site updates; +~10 LOC for the host-neutral `Disposable`.)_

The current `ConfigProvider` only exposes `get<T>(key, default?)`. That's not enough — the existing `configUtils.ts` surface that consumers in the settings view, setup flow, file lister, and main view depend on includes `updateConfig` (write), `inspectConfig` (default/global/workspace + sources), `isConfigExplicitlySet`, and `watchConfig`. Phase 3's "settings round-trip through `conf`" requires all four. Extend the interface, plus a small host-neutral `Disposable` type so `watch()` returns something each adapter can implement without leaking `vscode.Disposable`:

```ts
// core/platform/types.ts
export interface Disposable {
  dispose(): void;
}

// core/platform/config.ts
export interface ConfigProvider {
  get<T>(key: string, defaultValue?: T): T | undefined;
  update<T>(
    key: string,
    value: T,
    scope?: 'global' | 'workspace',
  ): Promise<void>;
  inspect<T>(key: string): {
    default?: T;
    global?: T;
    workspace?: T;
    effective?: T;
  };
  isExplicitlySet(key: string): boolean;
  watch(key: string | RegExp, listener: () => void): Disposable;
}
```

VS Code adapter wraps `vscode.workspace.getConfiguration().{get,update,inspect,onDidChangeConfiguration}` and returns the existing `vscode.Disposable` (which structurally matches `{ dispose(): void }`). Electron adapter wraps `conf`'s `get`/`set`/`onDidChange` with default-value tracking layered on (`conf` lacks native `inspect` semantics — store the default schema separately and compute the layered view) and returns `{ dispose: unsubscribe }`. The same `Disposable` is used by `WorkspaceProvider.watch()` (#4) and the narrow UI ports introduced in §9 #18 below. **No `vscode` types in `core/`.**

Push `configUtils.ts`'s 3-namespace fallback (`x.y.z` → `texra.*` prefix → full `texra.x.y.z`) into the VS Code-side adapter so consumers see a single canonical key shape. **Why now:** Phase 3 cannot exist with just `get<T>()`; better to expand once than twice.

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

The current native impl wraps `executeCommand`. The Electron impl swaps in Monaco. **Why now:** isolates the largest UX-rewrite behind a stable contract. Phase 5 of the port becomes "implement DiffViewHost against Monaco" instead of "rewrite the approval flow." _(~120 LOC: ~40 for the interface, ~80 for the VS Code impl wrapper around the existing call site.)_

**3. Swap `vscode.EventEmitter` → Node `EventEmitter`** in `src/auth/tier/TierService.ts`, `src/auth/serverKeys/ServerSideKeyService.ts`, and any other `vscode.EventEmitter` site outside the explicitly VS Code-coupled zones. **Why now:** these files leave the `vscode`-coupled set entirely and move into the agnostic core, with no functional change. _(~10 call sites, ~30 LOC mechanical.)_

**4. Add `WorkspaceProvider.watch(pattern, listener)` to the platform interface.**
The current interface (per scout) doesn't expose file watching. Any code today that needs watchers reaches for `vscode.workspace.createFileSystemWatcher` directly, leaking. Add `watch(glob, listener): Disposable` (using the same host-neutral `Disposable` type from #1). VS Code impl wraps `createFileSystemWatcher`; Electron impl uses chokidar later. **Why now:** prevents new leaks; gives the extension a cleaner watcher abstraction in passing. _(~60 LOC: 15 for interface, 45 for VS Code impl.)_

### Tier 2 — medium leverage

**5. ~~Extract the auth-callback URL parser.~~** _Subsumed by Tier 1 #14 — the URL parser is part of the OAuth state machine that #14 extracts wholesale._

**6. Keep the webview transport seam named `src/shared/hostBridge.ts`.** _Completed._
The file is a transport-agnostic wrapper with a fallback API (per webview scout), and the current name now reflects the host-transport seam. The compatibility shim is no longer part of the target shape. **Why now:** the Electron transport drops in alongside the existing one without naming friction.

**7. Theme-token indirection layer.** _(~450 LOC of CSS find-replace across ~25 components, ~100 LOC for the new `themeTokens.css` mapping file.)_
Webview Lit components reference `--vscode-button-background`, `--vscode-foreground`, etc. directly. Introduce a `--texra-*` token layer that maps to `--vscode-*` today; rewrite component CSS to reference `--texra-*`. Single search-replace, plus a small `themeTokens.css` that defines the mapping. **Why now:** Electron just ships its own `themeTokens.css` with explicit values. No per-component changes during the port.

**8. Centralize external-binary resolution in `BinaryResolver`.** _(~80 LOC for the new service, ~120 LOC of call-site changes audit.)_
`src/utils/system/platformPaths.ts` already probes Homebrew / TeX Live / MikTeX paths. Extract a `BinaryResolver` service that's the one place `execa()` calls go through to look up `pdflatex`, `latexmk`, `pandoc`, `gm`, etc. Audit existing call sites; route them all through it. **Why now:** the Electron port's `fix-path` augmentation has a single injection point.

**9. Settings Zod schema as canonical source.** _(~600 LOC of new Zod schemas mirroring the JSON-schema; ~50 LOC for the generator.)_
`package.json` `contributes.configuration` is a ~600-line JSON-schema literal duplicating the runtime types. Define a Zod schema in `core/` mirroring it; runtime reads validate against the Zod schema. Generate `package.json` from the Zod schema via `zod-to-json-schema`. **Why now:** eliminates a real middleman — today the JSON-schema and the runtime types drift independently. Electron's `conf` instance gets its schema from the same source, so adopting it before Phase 1 means the ConfigProvider impl writes itself.

**14. Extract host-agnostic Supabase auth + client.** _(~750 LOC `SupabaseAuthProvider` + ~250 LOC `SupabaseClient` body moved to core; ~190 LOC of VS Code glue + ~50 LOC desktop glue.)_

The auth port is two coupled files, not one. Both today import `vscode` and need extraction:

- **`src/auth/SupabaseAuthProvider.ts` (943 LOC)** — interleaves OAuth state machine (sign-in, PKCE, token storage, refresh, GitHub exchange) with `vscode.AuthenticationProvider`, `vscode.UriHandler`, `context.secrets`.
- **`src/auth/SupabaseClient.ts`** — also imports `vscode`, holds a `vscode.ExtensionContext`, reads session tokens via `context.secrets`, and `isReady()` blocks on `vscodeProviderRegistered`. Remote-agent loading + tier checks call `getSessionTokens()` directly, so without extracting this too, those flows stay coupled to VS Code readiness even if `SupabaseAuthProvider` is host-neutral.

The fix moves both into `core/auth/`:

- `core/auth/SupabaseSession.ts` — the OAuth state machine. Constructor deps: `(secrets: PlatformSecrets, openExternal: (url) => void, onAuthCallback: Listener<AuthCallbackResult>)`.
- `core/auth/SupabaseClient.ts` — the API client. Constructor takes a `TokenProvider` interface (`{ getSessionTokens(): Promise<Tokens | null>; whenReady: () => Promise<void> }`) — `SupabaseSession` implements it. No more `vscode.ExtensionContext` field, no `vscodeProviderRegistered` flag. `isReady()` becomes `await tokenProvider.whenReady()`.

The VS Code-side wrapper becomes ~190 LOC of glue: register `AuthenticationProvider`, register `UriHandler`, wire its callback into `SupabaseSession`, instantiate `SupabaseClient` with the session as `TokenProvider`. The Electron-side wrapper becomes ~50 LOC: `texra://` protocol handler routes callbacks into `SupabaseSession`, instantiates `SupabaseClient` the same way.

**Why now:** the Electron auth surface becomes ~50 LOC of glue against the same `SupabaseSession` + `SupabaseClient` classes — no parallel implementation, no "80% reuse" estimation; **it's two classes with two thin host wrappers**. Without extracting `SupabaseClient`, remote-agent loading and tier checks still go through `vscodeProviderRegistered` and silently break in Electron. Subsumes #5 (the URL parser is part of the state machine).

### Tier 3 — nice to have

**10. Audit notification leaks.** _(audit only; expected ~20 LOC of fixes if any leaks found.)_
`CLAUDE.md` already mandates that business logic returns error results, not `vscode.window.show*Message()`. Spot-check the agnostic zones for leaks (the build-time guard catches the egregious ones, but subtle wrappers like `import { window } from 'vscode'` in non-allowed zones can hide). **Why now:** any leak found here is a port blocker found cheaply.

**11. CI guard: vscode-import lint rule.** _(~50 LOC — ESLint flat-config addition + custom rule.)_
Add an ESLint rule (or a custom check) that fails CI if any file under the "vscode-free zones" imports `vscode`. Pin the existing 747/853 ratio so it can only improve. **Why now:** prevents regression while the Electron port is in flight.

**20. Define `AgentRuntimeHost` + `ProgressSink` boundary now.** _(~120 LOC: ~60 LOC interface + ~40 LOC `InProcessProgressSink` adapter + ~20 LOC of agent-runtime constructor wiring; ~150 LOC refactored at the existing `ProgressEventBus` site.)_

The current `ProgressEventBus` is an in-memory singleton: agent runtime code does `bus.emit(...)`, and the extension host's progress webview subscribes via the same module. That works in-process, but it bakes "agents and UI share an address space" into the core event path. Moving agents to a utility process (or a CLI in §13.1) becomes a cross-cutting rewrite of progress, approval, cancellation, logging, and platform access — exactly the trap the platform abstraction was supposed to prevent.

Define the boundary now, even though v1 implements it in-process:

```ts
// core/agent/runtime/ports.ts
export interface ProgressSink {
  emit(event: ProgressEvent): void;
  onApprovalRequest(
    handler: (req: ApprovalRequest) => Promise<ApprovalResponse>,
  ): Disposable;
}
export interface AgentRuntimeHost {
  sink: ProgressSink;
  // (also: cancellation tokens, log channel, platform handle — passed through)
}
```

The agent runtime (everything in `core/agent/`) takes an `AgentRuntimeHost` as a constructor dependency instead of importing `ProgressEventBus` directly. v1 ships an `InProcessProgressSink` adapter in `desktop/main/` (and the equivalent in `extension/`) that just forwards to the existing in-process subscribers — same behavior, same code path, but no singleton import in the core. v2's utility-process variant implements the same interface over `MessagePort` without touching agent code.

**Why now:** the cost is small (~120 LOC of glue + a refactor at the singleton's call sites), and doing it as a pre-refactoring means the utility-process v2 work is "implement one adapter" rather than "rewrite progress/approval/cancellation/logging." The current PRD's "deferred to v2 because of the singleton" framing is honest about the cost of NOT doing this now; #20 removes the cost.

**19. Host-agnostic `AgentDirectories` / resource-sync adapter.** _(~150 LOC: ~80 LOC for the core adapter + ~50 LOC for the VS Code wrapper + ~20 LOC for the desktop wrapper.)_

Today's bundled-agent flow is **not** "read from `resources/agents/` at runtime." It's:

1. `copyDefaultAgents(context)` reads `context.extensionPath/resources/{agents,tool_use_agents}` and copies into `GlobalStorageFS` on version changes or missing files (lazy bootstrap).
2. `AgentDirectoryManager` then serves built-in + user-custom directories from global storage; `AgentDirectoryManager` itself imports `vscode`.
3. Agent registry reads from global storage, never from the extension bundle directly.

If the desktop app only bundles YAMLs inside `app.asar` and reads them via `platform().fs.readFile`, the version-bump bootstrap doesn't run, user customizations are lost, and update flows silently break.

The fix:

- Move the bootstrap logic into a host-agnostic `AgentDirectories` class in `core/agents/`. It takes (a) a `bundleSource` path-or-bundle abstraction and (b) a `userStorage: FileSystemProvider` writable area. It owns: detect-bundled-version, compare-to-stored-version, copy-on-bump, list-directories.
- VS Code wrapper passes `extensionPath/resources` as `bundleSource` and `globalStorageUri` as `userStorage`. ~50 LOC.
- Desktop wrapper passes `app.getAppPath()/resources` as `bundleSource` and `app.getPath('userData')/agents/` as `userStorage`. ~20 LOC.
- `AgentDirectoryManager` then loses its `vscode` import — it consumes `AgentDirectories` instead.

**Why now:** without this, "Phase 1 loads an agent definition" works in dev but fails on packaged builds because `app.asar` reads don't trigger the bootstrap. Same risk shape as the Codex resolution bug — works in dev, fails in production. Catch in pre-refactor.

**12. Codex SDK packaged-resolution + unpack rehearsal.** _(~80 LOC harness + ~30 LOC of `electron-builder.yml` config + ~50 LOC update to `findCodexBinaryPath()`.)_
Three-part fix because `asarUnpack` alone misses the `createRequire` resolution path:

1. **Teach `findCodexBinaryPath()` (and the broader `BinaryResolver` from #8) to prefer `app.asar.unpacked` when `app.isPackaged` is true.** Resolution order in packaged Electron: `process.resourcesPath/app.asar.unpacked/...` → `createRequire` (current behavior) → global npm → `PATH`.
2. **`electron-builder.yml`** ships with `asarUnpack: ['**/node_modules/@openai/codex-*/**']` and any vendor sub-deps the SDK needs at runtime.
3. **Phase 6 harness** loads the packaged app, calls `findCodexBinaryPath()`, asserts the result is under `app.asar.unpacked/`, and spawns the binary on all three OSes (mac universal × x64 + arm64, win x64 + arm64, linux x64). Single failure fails the release.

**Why now:** the existing `findCodexBinaryPath()` works perfectly in dev because `createRequire` resolves source-tree node_modules; it fails silently in packaged builds because `createRequire` from inside the asar can't see `app.asar.unpacked` siblings. Catching this in dev costs nothing; catching it after a v1 release costs every install.

**13. Extract `settingsViewDispatcher.ts`.** _(~120 LOC moved out of `SettingsApp.handleMessage()`, ~40 LOC of new wiring.)_
Main and progress views have separate dispatcher files; settings inlines dispatch in a switch inside `SettingsApp.handleMessage()`. Mirror the pattern of the other two — pull the switch into `src/settingsView/frontend/settingsViewDispatcher.ts`. **Why now:** all three webviews share the same shape, simplifying the IPC adapter we drop in for Electron.

**15. Codify the composition-root rule as a lint check.** _(~30 LOC of ESLint flat-config rule.)_
Per §6.6, `initPlatform()` may be called only from `extension/src/extension.ts` (and the future `desktop/src/main/index.ts`). Everywhere else accesses host services via `platform()`. Add an ESLint rule (`no-platform-init-outside-composition-root`) that fails on `import { initPlatform } from '@platform'` outside the designated files. **Why now:** locks in the composition-root invariant before the desktop shell exists; prevents the kind of "I just need to init the platform from this one place" creep that hexagonal architectures degrade into.

**18. Extract host-neutral controllers from the three message handlers.** _(~3,551 LOC of handlers split: ~2,800 LOC of business logic moved to `core/controllers/`; ~750 LOC of host glue stays in `extension/` and is mirrored at ~150 LOC in `desktop/`.)_

This is the largest pre-refactoring and was previously hidden behind §4.4's "bridge-and-bootstrap" framing. That framing is right for the **renderer** (the Lit components are 96.5% reusable) but wrong for the **host-side handlers**. The three handlers in `extension/` total **~3,551 LOC** and all import `vscode`:

- `MainViewMessageHandler` (~440 LOC) — file selection, command routing, instruction submission.
- `ProgressViewMessageHandler` (~1,366 LOC) — stream lifecycle, log streaming, approval routing, terminal creation, push updates.
- `SettingsViewMessageHandler` (~1,745 LOC) — every settings tab's writes, history queries, memory management, auth/API-key dialogs, model dashboard.

Per §8.1 the desktop must not import `extension/` or `vscode`. So without extraction we'd either rewrite all three handlers in `desktop/` from scratch (parallel maintenance forever) or violate the boundary.

Split each handler into a host-neutral controller in `core/` plus thin per-host glue:

```
core/controllers/MainViewController.ts        (~400 LOC, takes platform() + UIHosts as deps)
core/controllers/ProgressViewController.ts    (~1,200 LOC)
core/controllers/SettingsViewController.ts    (~1,600 LOC)

extension/handlers/MainViewMessageHandler.ts  (~120 LOC, parses msg → calls controller → wraps reply)
extension/handlers/ProgressViewMessageHandler.ts  (~250 LOC)
extension/handlers/SettingsViewMessageHandler.ts  (~380 LOC)

desktop/main/ipc.ts                            (~150 LOC total — generic dispatcher routing
                                                Zod-typed messages to controller methods)
```

**The boundary problem and how we resolve it.** Today's handlers do far more than read filesystem state — they invoke `vscode.window.showInformationMessage`, `vscode.window.showInputBox`, `vscode.window.createTerminal`, `vscode.commands.executeCommand`, `vscode.env.openExternal`, `vscode.env.clipboard`, and so on. Stuffing all of that into the existing `Platform` (which is deliberately tiny: config, state, log, fs, workspace, storage, secrets) would turn `Platform` into a UI mega-facade and import exactly the host coupling we're removing.

Cleaner split: keep `Platform` as **OS primitives**, and introduce a separate set of **narrow UI effect ports** in `core/hosts/` that controllers take alongside `platform()`. Each port is small, has one job, and adapts cleanly to both VS Code and Electron primitives:

```ts
// core/hosts/index.ts
export interface UIHosts {
  prompt: PromptHost; // confirm / info / warning / error / input
  externalOpener: ExternalOpener; // openExternal(url), openPath(file)
  diff: DiffViewHost; // (already defined in §9 #2)
  terminal: TerminalHost; // create / send / dispose terminal
  clipboard: ClipboardHost; // read / write text
}
```

| Port             | VS Code adapter                                                                 | Electron adapter                                                           |
| ---------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `PromptHost`     | `vscode.window.show{Information,Warning,Error,InputBox}`                        | `dialog.showMessageBox` + in-app Lit modal for input                       |
| `ExternalOpener` | `vscode.env.openExternal`, `vscode.commands.executeCommand('vscode.open', uri)` | `shell.openExternal`, `shell.openPath`                                     |
| `DiffViewHost`   | `vscode.commands.executeCommand('vscode.diff', ...)` (existing #2)              | Inline `<texra-diff-view>` (Monaco) rendered into the progress view (§4.5) |
| `TerminalHost`   | `vscode.window.createTerminal`                                                  | xterm.js component already in renderer + spawned subprocess                |
| `ClipboardHost`  | `vscode.env.clipboard`                                                          | `clipboard` from Electron's `electron` module                              |

**Why no `CommandHost`.** A string-typed `commands.execute(id)` port would be a back door: it would import host command names into the supposedly host-neutral core, recreate VS Code's dynamic command bus inside the kernel, and turn the catalog into both metadata and runtime authority. The clean alternative is **one-way only**: the host shell's menu/palette layer reads the #17 catalog and dispatches each catalog entry to a typed controller method or explicit port (e.g., `progressView.openLatexDiff()`). Controllers themselves never hold a stringly executor — they expose typed methods that the per-host shell wires up. Catalog stays metadata; runtime authority lives at the boundary, not in core.

Controllers use `platform().fs` to read files but `hosts.prompt.confirm("Delete this memory?")` to ask the user. `FakePlatform` (#16) gets a sibling `FakeHosts` so kernel tests can record-and-assert UI effects deterministically. The result: each port is ~30–80 LOC of interface + adapter, the boundary is explicit, and we don't expand `Platform`.

Side benefit: this finally provides a place to register the per-host handlers from §9 #17's command catalog — the catalog's command IDs map to typed controller methods directly (per-host dispatch table), with no `CommandHost` indirection. The palette and menu in each host walk the catalog and dispatch each entry to a controller method or explicit port; runtime authority stays at the host boundary, not in core.

**Why now:** Phase 2/3 of the desktop port currently has no plan for the ~3,551 LOC of handler logic. Without #18, those phases are missing several thousand LOC of work or break the §8.1 boundary. Without the narrow UI ports above, `Platform` collapses into a UI mega-facade. Tier 1 is the right place because skipping any of it breaks the LOC budget AND the architectural rule simultaneously.

**17. Extract a host-agnostic command catalog from `src/commands.ts`.** _(~250 LOC: ~150 LOC for `core/commands/catalog.ts` + ~80 LOC of `extension/commands/register.ts` adapter + ~20 LOC of glue.)_

Today `src/commands.ts` registers ~60 commands by importing `vscode.commands.registerCommand` and wiring handlers inline — it's host-coupled by construction. The Electron palette and native menu can't reuse it (per §8.1 separation rule).

Split into two layers:

- **`core/commands/catalog.ts`** — pure data: `{ id, title, category, icon, keybinding?, description?, when? }` for each command. ~60 entries; no `vscode` import.
- **Per-host wiring** — extension's `register.ts` reads the catalog and registers each `id` against `vscode.commands.registerCommand(id, handler)` from a handler map. Desktop's `menu.ts` reads the catalog to build the native `Menu`; the renderer reads it to populate the Lit palette and key handler.

The handler map stays per-host because handlers genuinely differ — extension handlers receive `vscode.ExtensionContext`, desktop handlers receive an Electron `BrowserWindow`. Shape: `Record<CommandId, () => Promise<void>>`.

**Why now:** unblocks §5's pick #8 (Lit palette over the registry) which is currently broken — `src/commands.ts` can't be imported from `desktop/` per §8.1. Without #17, Phase 3's command palette either re-implements the catalog inline (drift) or violates the separation rule. Doing it as a Tier 1 pre-refactoring is cleaner and lets the extension benefit from the metadata layer too (better menu generation, easier docs).

**16. Stand up Vitest + `FakePlatform`; migrate the existing Mocha tests.** _(~150 LOC for the fake impl + helpers; Mocha → Vitest port for ~25 existing test files; ~50 LOC of `vitest.config.ts` + scripts.)_

Today's kernel test pipeline is broken in two places (see §6.7):

- `npm test` (`vscode-test`) is forbidden by `CLAUDE.md` because it fails.
- The unofficial Mocha-with-loader path also fails — `test-loader.mjs` throws `SyntaxError: Identifier 'resolve' has already been declared` on modern Node. Verified empirically.

Net result: there is no working way to run the kernel test suite right now. The tests exist (~25 files) and the mocks exist, but the runner doesn't.

The fix replaces the broken pipeline rather than patching it:

- New `core/test/fakes/FakePlatform.ts` — in-memory impls of all 7 platform interfaces (config = Map, secrets = Map, fs = memfs, log = array, etc.).
- New `vitest.config.ts` per package using path aliases from `tsconfig.base.json`.
- Migrate the ~25 existing Mocha test files to Vitest. Replace the `vscode-mock` import with `setPlatform(new FakePlatform())` in test setup. Most tests need only mechanical changes (`assert` → `expect`, `describe`/`it` is identical).
- Discard `test-loader.mjs` and `vscode-test`-driven invocations.

`pnpm --filter core test` becomes the canonical command. Tests run in Vitest in plain Node, in <1s for the whole suite.

**Why now:** the existing test pipeline is genuinely non-functional, so the cost of switching is "fix the pipeline" not "rewrite working tests." Doing it as a pre-refactoring means Phase 1's eight Electron platform impls land with a working invariant suite from day one, instead of inheriting a broken-by-default test story.

### Suggested ordering

If we land them all, ~7.5–9.5 engineering weeks total, parallelizable. Suggested order: **3 → 1 → 4 → 16 → 2 → 20 → 14 → 18 → 17 → 6 → 11 → 15 → 9 → 19 → 7 → 8 → 13 → 10 → 12**. Mechanical fixes first (#3 EventEmitter), then the foundational items (#1 ConfigProvider expansion, #4 watch, #16 FakePlatform — pre-test infrastructure pays off immediately), then the structural extractions in dependency order (#2 DiffViewHost, #20 ProgressSink boundary, #14 SupabaseSession+Client, #18 host-neutral controllers + UI ports, #17 command catalog), then the lint guards (#11 and #15) to lock in agnostic-zone + composition-root purity, then the schema unification (#9), resource-sync adapter (#19), CSS shim (#7), binary resolver (#8), dispatcher cleanup (#13), audit/rehearsal items.

Each Tier 1 item is independently shippable to the extension and produces a smaller, cleaner extension regardless of the Electron decision.

**After Tier 1 lands, the Electron port is "wire up the extracted abstractions":**

- Implement the platform interfaces against Electron primitives (`ConfigProvider` from #1, `WorkspaceProvider.watch` from #4, `DiffViewHost` from #2, `PlatformSecrets` for `safeStorage`).
- Implement the 5 narrow UI ports (`PromptHost`, `ExternalOpener`, `DiffViewHost`, `TerminalHost`, `ClipboardHost`) against Electron + the renderer. **No `CommandHost`** — per §9 #18, command dispatch is a typed per-host wiring of the catalog (#17), not a stringly bus.
- Wire the Electron-side wrappers around the extracted **host-neutral controllers** (#18) via `desktop/main/ipc.ts`.
- Wire the Electron-side wrapper around the extracted **`SupabaseSession` + `SupabaseClient`** (#14).
- Wire the Electron-side **command-catalog consumer** (#17) for the native menu + Lit palette.
- Stand up the Electron-side **`AgentDirectories`** wrapper (#19) so bundled-agent bootstrap actually runs.

Each implementation is verifiable against the `FakePlatform`/`FakeHosts` invariant suite from #16 — the Electron port becomes "make these existing tests pass against real adapters."

## 10. Migration phases

Each phase is independently reviewable. The extension never breaks during this work — every change is additive until Phase 6.

### Phase 0 — Monorepo split (1.5–2 weeks)

The biggest mechanical change. Do this first; everything else is downstream.

- Migrate root → pnpm workspaces. Three packages: `core`, `extension`, `desktop` (`desktop` initially empty).
- Move source files per the layout in §7.1. Update path aliases in `tsconfig.base.json`. Update import sites if needed (most stay the same via aliases).
- Refactor `src/utils/config/configUtils.ts` behind `ConfigProvider` (or accept that it remains in `extension/`).
- Swap `vscode.EventEmitter` → Node `EventEmitter` in `src/auth/tier/` and `src/auth/serverKeys/`.
- Update CI: `pnpm install`, `pnpm --filter extension build`.
- **Exit criteria (behavioral, not byte-equivalent):**
  - `pnpm --filter extension typecheck` and `pnpm --filter extension build` succeed in CI.
  - The new VSIX installs and activates cleanly in a fresh VS Code instance — extension activates, the three webviews render, no errors in the dev tools console.
  - `package.json` `contributes.{commands,configuration,views,...}` is identical to the pre-split build (compare via JSON diff, not byte diff).
  - Bundled runtime asset set (`resources/agents/`, walkthroughs, codicon font, etc.) matches pre-split — assert by `find dist/resources -type f | sort | sha256sum`.
  - Empty `desktop` package builds a "Hello TeXRA" Electron window.

  We deliberately **do not** require byte-equivalence on the VSIX itself — zip ordering, package metadata, sourcemap paths, and lockfile artifacts can legitimately change without runtime impact, and byte equality wouldn't actually prove the new layout resolves resources correctly.

### Phase 1 — Platform impls + AgentDirectories (1.5–2 weeks)

**Gates:** §9 #1 (expanded `ConfigProvider`), #4 (`WorkspaceProvider.watch` + `Disposable`), #16 (`FakePlatform`), #19 (`AgentDirectories` + resource-sync) must be merged before Phase 1 starts.

- All eight Electron-side `Platform` interface impls in `desktop/src/main/platform/`.
- `initPlatform(...)` wired in `desktop/src/main/index.ts` (the Electron composition root, per §6.6).
- `fix-path()` called at startup; PATH augmentation belt-and-suspenders.
- **Resource bootstrap**: Electron-side `AgentDirectories` wrapper (per #19) so bundled YAMLs from `app.getAppPath()/resources/` get copied into `app.getPath('userData')/agents/` on version bumps. Without this, built-in agent discovery silently breaks in packaged builds.
- Each Electron platform impl gets a Vitest suite that runs the same invariant checks as `FakePlatform` — so we know `ConfigProvider` behaves identically across hosts. Catches subtle differences cheaply.
- **Exit criteria:** Vitest invariant suite passes for all 8 platform impls + AgentDirectories. Built-in agents load on a fresh-userData run.

### Phase 2 — Renderer + main view + UI-host wiring (1.5–2 weeks)

**Gates:** §9 #18 (host-neutral controllers + narrow UI ports) must be merged. Phase 2 is "wire the controllers up over IPC," not "rewrite the handlers."

Tighter than originally scoped: per the §4.4 measurement, the existing Lit components are 97% byte-for-byte reusable. Renderer work is bridge-and-bootstrap, not UI.

- 3 new files (~230 LOC) in `desktop/src/`: `main/ipc.ts` (RPC + push handlers), `preload/index.ts` (contextBridge surface), `renderer/main.ts` (mounts the three Lit apps). Window creation lives in `main/index.ts` directly per §7.1.
- 1 modified file: `src/shared/hostBridge.ts` (~45 LOC) — read the Electron preload bridge from `HOST_BRIDGE_API_KEY`, fall through to `acquireVsCodeApi` otherwise. Keeps both hosts working from one codebase.
- 1 new file: `desktop/src/renderer/themeTokens.css` defining the 53 `--vscode-*` tokens for light/dark/high-contrast (cribbed from the existing fallback values).
- **UI host adapters in `desktop/main/hosts/`** (per §9 #18 narrow ports): `PromptHost` (in-app Lit modal + `dialog.showMessageBox`), `ExternalOpener` (`shell.openExternal` / `shell.openPath`), `TerminalHost`, `ClipboardHost`. ~50–80 LOC each.
- `MainViewController` (extracted in #18) wired through `desktop/main/ipc.ts`.
- "Open Project" file picker → `WorkspaceProvider` + `PromptHost`.
- First end-to-end agent execution.
- **Exit criteria:** Run the Direct agent on a `.tex` file from an opened project. See output in renderer. Light/dark/high-contrast themes round-trip correctly. `<main-app>` renders pixel-faithful to the extension version.

### Phase 3 — Progress view, settings, command palette (1.5 weeks)

**Gates:** §9 #17 (command catalog) and #18 (controllers) must be merged. Phase 3 is "wire `ProgressViewController` and `SettingsViewController` through IPC + populate the catalog-driven menu and palette."

Per §4.5 (agent-native architecture): one window, internal routing.

- Mount `<progress-app>` and `<settings-app>` Lit components in the same `BrowserWindow`, switched via the existing `texra.toggleView` routing state. No new windows.
- `ProgressViewController` + `SettingsViewController` wired through `desktop/main/ipc.ts` (controllers from #18; Phase 3 is just the IPC routing).
- Lit command palette consumes the host-agnostic command catalog (§9 #17); each catalog entry maps to a typed controller method or narrow UI-port call via the desktop-side dispatch table (no stringly `CommandHost` — see §9 #18 "Why no `CommandHost`").
- Native `Menu` populated from the same catalog — top 20 commands at v1.
- Settings tabs round-trip through the expanded `ConfigProvider` (#1).
- **Exit criteria:** Feature parity for the top 20 commands. Settings round-trip through `conf` correctly. Both progress and settings webviews receive push updates from their respective controllers.

### Phase 4 — Auth, secrets, remote agents (0.5–1 week)

Tighter if §9 #14 (SupabaseSession extraction) lands as a pre-refactoring — the auth core becomes a class we already have, not code we port.

- `texra://` protocol handler. Cold-start, warm-start tested on all three OSes.
- `safeStorage`-backed `PlatformSecrets`.
- New ~50-LOC Electron host wrapper around the (already extracted) `SupabaseSession` class — registers `texra://` callback, calls `openExternal()` for sign-in, persists tokens via `safeStorage`. **No 943-line rewrite, no "80% reuse" estimation.**
- API key set/remove via in-app Lit modal (Electron's `dialog` module has no input-box primitive; `dialog.showMessageBox` is button-only). Reuse the existing settings-tab Lit components for consistency.
- GitHub auth: drop the `texra.auth.enableVSCodeGitHub` flag in Electron; use Supabase's built-in GitHub OAuth provider (per §13).
- **Exit criteria:** Sign in, run a remote agent, sign out. Linux fallback warning appears when `safeStorage.getSelectedStorageBackend() === 'basic_text'`.

### Phase 5 — Diff/preview surface for tool-edit approval (1.5–2 weeks)

The single largest UI port.

- `<texra-diff-view>` Lit component wrapping `monaco.editor.createDiffEditor`. Lazy-loads Monaco on first open. Registers only the languages we ship (`latex`, `bibtex`, `markdown`, `plaintext`, `typescript`, `python`). Honors light/dark theme via existing webview tokens. ~200–400 LOC of wrapper code; Monaco itself drops in via npm.
- **Renders inline inside the progress view** (anchored to `ToolEditRequestPanel`), not in a modal `BrowserWindow`. Per §4.5 the agent-native model puts the diff in-flow with the approval card; this also removes the focus-juggling we'd hit with a modal.
- Vite worker setup: configure `monaco-editor`'s standard `MonacoEnvironment.getWorker` to point at `?worker`-built chunks. Tested on all three OSes since worker resolution under asar can be fiddly.
- `desktop/src/main/editApproval.ts` replaces `nativeToolEditApproval.ts`. Same temp-file flow (lines 246–255 of original); replaces the `vscode.commands.executeCommand('vscode.diff', ...)` call with an inline-render IPC dispatched into the progress view.
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
- We do **not** layer `update.electronjs.org` on top — it speaks Squirrel/`autoUpdater` (mac + win only, no Linux) and isn't a drop-in fallback for `electron-builder`'s `latest*.yml` manifest flow. Mixing the two would mean two parallel update pipelines and a Linux gap.
- **Exit criteria:** Signed installers from CI on all three platforms. Auto-update from `v0.0.1 → v0.0.2` works.

### Phase 7 — Beta, polish, docs (2 weeks)

- First-run walkthrough modal.
- Sentry Electron SDK opt-in, native crashes only, `tracesSampleRate: 0`. `beforeSend` strips file paths outside workspace root.
- Telemetry parity with extension (or explicit opt-out path).
- In-app log viewer pane.
- Documentation site updates; new download page.
- Migration plan for users coming from the VS Code extension. **Neither settings nor secrets are externally readable.** VS Code's `globalState` and `workspaceState` are `Memento` APIs backed by VS Code's internal SQLite state DB (`state.vscdb`) — not a single JSON file the desktop can parse, and VS Code holds locks on the DB while running. `SecretStorage` is encrypted via the OS keychain through VS Code's host. An external Electron process can't reliably read either. Two viable paths, in order of preference:
  - **Re-auth + reconfigure on first launch (recommended for v1).** Desktop prompts the user to sign in and re-enter API keys; non-secret settings (model preferences, agent defaults, etc.) get a clean default-and-edit experience. Simple, secure, no fragile cross-process reads. Users with one or two API keys are fine; heavy power users will notice the friction.
  - **Extension-side export command** (`texra.exportForDesktop`). The user runs this command inside VS Code; the extension reads its own `globalState` + `workspaceState` (via the `Memento` API) and decrypts `SecretStorage` (via `context.secrets`), then writes a one-shot OS-keychain-encrypted blob to disk. Desktop reads on first launch and immediately deletes. ~200 LOC across both packages. Defer unless users ask.

  **Not viable:** reading `state.vscdb` directly (VS Code holds locks; schema is undocumented) or reading `User/globalStorage/<extension>/` artifacts (those are extension-managed, not the Memento store).

**Estimated timeline (single engineer):** 11.5–13 weeks. Trimmed from the v2 estimate after the §4.4 webview scout confirmed renderer work is bridge-and-bootstrap (~250 LOC + theme tokens) rather than the originally feared UI rewrite. With a two-engineer team running Phases 1+2 in parallel after Phase 0, achievable in 7–9 weeks.

A separate scout report estimated 22–24 weeks single-dev for "full feature parity including every command and complete auth rebuild." That figure is realistic if we treat the extension's command surface as a hard requirement to port verbatim. Our Phase 3 scope is "top 20 commands"; reaching parity on all ~60 is another 4–6 weeks of straightforward porting work past v1.

## 11. Risks & mitigations

| Risk                                                                                          | Likelihood | Impact   | Mitigation                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------------- | ---------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hidden `vscode` imports in nominally-agnostic zones break Electron build                      | Medium     | Medium   | Build-time guard plugin in CI. Re-run scout after every refactor.                                                                                                                                                                                                                                               |
| `@vscode-elements/elements` styling assumes VS Code CSS variables                             | Medium     | Low      | Library ships its own CSS variables; we override the few VS Code-only ones with theme tokens. Already partial in webview styles.                                                                                                                                                                                |
| `src/utils/config/configUtils.ts` refactor breaks extension                                   | Medium     | High     | Phase 0 explicitly verifies VSIX boots after refactor. Land behind feature flag if needed.                                                                                                                                                                                                                      |
| macOS GUI launch can't find `pdflatex`/`pandoc`/`gm`                                          | High       | High     | `fix-path` at startup + explicit augmentation of `/Library/TeX/texbin`, `/opt/homebrew/bin`, `/usr/local/bin`. Log resolved PATH for support diagnosis.                                                                                                                                                         |
| Windows deep-link cold-start bug (electron #40173)                                            | High       | Medium   | Capture `process.argv` synchronously at module top of `main/index.ts`; not in async handler.                                                                                                                                                                                                                    |
| Code-signing budget surprise                                                                  | Medium     | High     | Budget Azure Trusted Signing (~$10/mo) and Apple Developer Program ($99/yr) **before** Phase 6.                                                                                                                                                                                                                 |
| Auto-update certificate expires / mac notarization breaks                                     | Low        | High     | Document key rotation in runbook. CI uploads test build to `latest-mac.yml` weekly to catch regressions.                                                                                                                                                                                                        |
| `@openai/codex-sdk` resolves to wrong path under packaging                                    | High       | High     | Two parts: (1) `asarUnpack` glob covers `**/node_modules/@openai/codex-*/**`. (2) `findCodexBinaryPath()` updated to prefer `process.resourcesPath/app.asar.unpacked/...` when `app.isPackaged` (per §9 #12). Phase 6 harness asserts the resolved path on all three OSes.                                      |
| User confusion: extension and desktop sharing/colliding settings on same machine              | Medium     | Low      | Distinct `userData` paths. **Default first-launch flow is re-auth + reconfigure** — VS Code `Memento` (backed by `state.vscdb`) and `SecretStorage` aren't externally readable from Electron (see Phase 7 in §10). Optional `texra.exportForDesktop` extension command for power users who want auto-migration. |
| Monaco worker resolution fails under asar                                                     | Medium     | Medium   | Test all OSes in CI; configure `MonacoEnvironment.getWorker` against `?worker`-built chunks; if asar bites, `asarUnpack` the worker chunks.                                                                                                                                                                     |
| Monaco bundle inflates renderer cold-start                                                    | Medium     | Low      | Lazy-load via `await import('monaco-editor')` only when diff opens; ship only registered languages. Initial window doesn't load Monaco at all.                                                                                                                                                                  |
| Release-repo publish workflow leaks PAT                                                       | Low        | High     | Use a GitHub App over a PAT; scope `contents: write` to the release repo only; rotate annually.                                                                                                                                                                                                                 |
| Diff performance on large files                                                               | Low        | Low      | Monaco handles 100k-line files comfortably; hard cap at ~10MB with "open in external" fallback.                                                                                                                                                                                                                 |
| 943-line `SupabaseAuthProvider` rewrite cost underestimated                                   | Medium     | Medium   | Phase 4 budget is 1 week; if it slips, scope GitHub auth as fast-follow rather than v1.                                                                                                                                                                                                                         |
| **Apple Developer Program lapse** invalidates all signed builds                               | Low        | Critical | $99/yr renewal must not be missed. Calendar reminder + secondary owner. Document the resign + republish recovery in the runbook.                                                                                                                                                                                |
| **Code-signing identity rotation breaks the auto-update chain**                               | Medium     | High     | When Apple Developer ID or Azure Trusted Signing cert changes, existing installs can't verify the new signature. Test rotation in beta channel first.                                                                                                                                                           |
| **Notarization intermittent failures** stall CI                                               | Medium     | Medium   | Apple's notary service has occasional outages. Retry with backoff; don't block merges; manual override available.                                                                                                                                                                                               |
| **Deep-link cold-start path differs by OS, not just by argv shape**                           | High       | Medium   | Per §6.5: macOS uses `app.on('open-url')` registered before `ready` (URL is **not** in `process.argv`). Windows + Linux use `process.argv` cold-start + `second-instance` warm-start. Test all four flows × three OSes (12 cases) explicitly in Phase 4.                                                        |
| **macOS App Nap / Windows modern standby** kills the renderer mid-run                         | Medium     | Medium   | `powerSaveBlocker.start('prevent-app-suspension')` while an agent run is in-flight. Release on idle.                                                                                                                                                                                                            |
| **`asar` packing misses native binaries** (Codex SDK, Monaco workers, codicon font)           | Medium     | High     | `electron-builder.yml` `asarUnpack` glob covers `@openai/codex-*/**`, Monaco worker chunks, the codicon TTF. Verified per-platform in CI.                                                                                                                                                                       |
| **Codex SDK platform-binary mismatch** under mac-universal builds                             | Low        | High     | Confirm `@openai/codex-sdk`'s install-time platform detection works under `electron-builder` lipo'd builds. Test ARM64 + x64 explicitly.                                                                                                                                                                        |
| **`safeStorage` Linux fallback to `'basic_text'` mode** = secrets stored with a hardcoded key | Medium     | High     | Detect via `getSelectedStorageBackend() === 'basic_text'` (see §6.3). Surface a one-time warning. Document keyring install. Don't silently degrade.                                                                                                                                                             |
| **Two desktop instances racing on the same machine**                                          | Low        | Low      | `app.requestSingleInstanceLock()` is per-binary and gracefully reuses the existing window via `second-instance` event. The earlier "extension + desktop collide" framing was wrong — they're separate Electron binaries with distinct identities and don't share a lock.                                        |
| **Subprocess env leaks API keys** via `ps`-style enumeration                                  | Medium     | Medium   | Pass keys via stdin / temp file with restrictive perms where SDKs support it. Audit existing `execa` call sites.                                                                                                                                                                                                |
| **IPC message size limits** (~100MB) hit on large diffs / long transcripts                    | Low        | Medium   | Stream large payloads via `MessagePort` chunks; "diff too large" → `shell.openPath()` fallback at ~10MB.                                                                                                                                                                                                        |
| **License compliance** — codicons CC-BY-4.0 requires attribution                              | Low        | Medium   | Bundle `LICENSES.txt` and visible attribution in About box. Audit Monaco (MIT), codicons (CC-BY-4.0), `@vscode-elements/elements` (Apache-2.0), KaTeX, highlight.js.                                                                                                                                            |
| **Sentry sourcemap upload regression** = useless crash reports                                | Low        | Medium   | `electron-builder` `afterAllArtifactBuild` hook uploads sourcemaps; CI guard fails the release if upload step skipped.                                                                                                                                                                                          |
| **Custom protocol hijack** — another app registers `texra://` after us                        | Low        | Low      | Re-assert on every launch via `setAsDefaultProtocolClient`. Document in support FAQ.                                                                                                                                                                                                                            |
| **Renderer memory growth** on long sessions (no auto-recycle)                                 | Medium     | Low      | Virtualize logs via `@lit-labs/virtualizer` (already a dep). Soft cap on retained log lines; spill to file.                                                                                                                                                                                                     |
| **Cross-platform path normalization** in persisted runs                                       | Medium     | Medium   | Store POSIX-style internally; convert to `path.sep` only at the OS boundary. Audit storage code for naive `path.join` use.                                                                                                                                                                                      |
| **Corp proxy / SSL inspection** breaks model API or auto-update                               | Medium     | Medium   | Respect `HTTP_PROXY` / `HTTPS_PROXY`. Electron's `net` module does by default; verify SDKs do too. Document for IT admins.                                                                                                                                                                                      |

## 12. Success criteria

- v1 ships signed installers: macOS (Universal DMG + ZIP), Windows (NSIS x64 + arm64), Linux (AppImage + deb).
- A user can: sign in (or set API key), open a project folder, pick an agent and model, execute, view progress, approve tool edits via the new diff component, see final output. End-to-end without VS Code installed.
- No regression in the VS Code extension. Same `pnpm --filter extension build` produces a working VSIX from the same `packages/core/`.
- Total **net-new** code in `packages/desktop/` under ~3,000 LOC (the v1 hard gate; per §14.1 we sit at 2,180–2,900, plus ~250 LOC of UI-host adapters in `desktop/main/hosts/` per §9 #18). The pre-refactorings in §9 land in `packages/core/` and `packages/extension/` and are budgeted separately at **~2,195 net-new + ~5,901 modified** LOC (per §14.1) — most of the modified count is moved code (existing handler/auth logic relocating into `core/` to become host-neutral). They are _prep work_, not v1 surface. Going over the ~3,000-LOC desktop cap means an abstraction leak — that's the gate.
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
- **Migration path:** Default v1 plan is **re-auth + reconfigure on first launch**. Neither `globalState`/`workspaceState` (VS Code `Memento` API → internal `state.vscdb`) nor `SecretStorage` is externally readable from a separate Electron process. Optional `texra.exportForDesktop` extension command writes a one-shot OS-keychain-encrypted blob if user demand for auto-migration surfaces post-v1.

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
- **Utility-process agent execution.** Move long agent runs into a separate Electron utility process so a renderer crash doesn't lose the run. With §9 #20's `AgentRuntimeHost` / `ProgressSink` boundary in place, this is a single new adapter (~250–400 LOC: a `MessagePortProgressSink` + utility-process `initPlatform()` proxy) — no rewrites of progress, approval, cancellation, or logging. v2 candidate.
- **Extension-side credential export handoff** (`texra.exportForDesktop` command). Writes a one-shot encrypted blob from `SecretStorage` for the desktop to import. Default Phase 7 plan is "re-auth on first launch"; this is the optional alternative if user demand surfaces.

## 14. Appendix: Reuse-by-the-numbers

From the parallel scout:

| Metric                                                               | Value                                                                                                                                                                                   |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Total TS/TSX files in `src/`                                         | 853                                                                                                                                                                                     |
| Files importing `vscode`                                             | 106 (12.4%)                                                                                                                                                                             |
| `Platform` interface LOC                                             | ~470                                                                                                                                                                                    |
| Existing VS Code platform impl LOC                                   | ~303 (6 files)                                                                                                                                                                          |
| Estimated Electron platform impl LOC                                 | ~250–400 (8 files)                                                                                                                                                                      |
| Lines in `nativeToolEditApproval.ts` (the diff blocker)              | 439                                                                                                                                                                                     |
| Estimated `<texra-diff-view>` Lit wrapper LOC (Monaco hosted inside) | ~200–400                                                                                                                                                                                |
| Lines in `SupabaseAuthProvider.ts`                                   | 943                                                                                                                                                                                     |
| `SupabaseAuthProvider.ts` extraction (§9 #14)                        | ~750 LOC moved into `core/auth/SupabaseSession.ts`; ~190 LOC of VS Code glue in `extension/` + ~50 LOC of glue in `desktop/`. No "% reuse" estimate — one class with two thin wrappers. |
| Estimated `desktop/src/` total LOC at v1                             | ~3,000                                                                                                                                                                                  |
| Estimated diff in `core/` for monorepo split                         | ~0 (path aliases handle it)                                                                                                                                                             |
| Estimated diff in `core/` for behavioral changes                     | ~500 (configUtils refactor + EventEmitter swap)                                                                                                                                         |
| Total Lit frontend LOC across the three webviews                     | 30,631                                                                                                                                                                                  |
| Frontend LOC reused byte-for-byte                                    | 29,550 (96.5%)                                                                                                                                                                          |
| Frontend LOC needing `--vscode-*` token shim                         | 450 (1.5%)                                                                                                                                                                              |
| Frontend LOC needing transport-wrapper swap                          | 490 (1.6%)                                                                                                                                                                              |
| Frontend LOC needing genuine reimplementation                        | 141 (0.5%)                                                                                                                                                                              |
| Custom elements (`@customElement`) reused                            | 62                                                                                                                                                                                      |
| Unique `--vscode-*` CSS tokens to shim                               | 53                                                                                                                                                                                      |

### 14.1 Effort-by-the-numbers (LOC budget)

Consolidates every LOC estimate scattered through the doc. Rough order-of-magnitude figures based on existing analogues (the VS Code platform impls, the diff-handler, similar Electron apps). Each line is "code we write" — not "code we touch via find-replace." Ranges reflect the medium/large items where I'd give ±30% confidence.

#### LOC by phase (`packages/desktop/`)

| Phase                | Scope                                                                                               | New LOC                 | Modified LOC          | Notes                                                                                                                                                                                                      |
| -------------------- | --------------------------------------------------------------------------------------------------- | ----------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0                    | Monorepo split                                                                                      | ~50                     | ~200                  | Package.jsons, tsconfig.base.json, pnpm-workspace.yaml, electron-vite skeleton "Hello TeXRA". Most work is moving files, not writing.                                                                      |
| 1                    | Platform impls (8 files) + initPlatform + fix-path + Vitest invariant suite                         | 450–600                 | ~10                   | Eight 30–60-LOC impls + ~80 LOC bootstrap + ~50 LOC fix-path / PATH augmentation + ~50 LOC of platform-impl Vitest tests sharing FakePlatform invariants.                                                  |
| 2                    | Renderer + main view (3 files: ipc.ts, preload, renderer/main.ts; window creation in main/index.ts) | 230–330                 | ~45 (`hostBridge.ts`) | 3 files at ~70–100 LOC each, plus `themeTokens.css` ~150 LOC.                                                                                                                                              |
| 3                    | Progress, settings, command palette, native menu                                                    | 250–350                 | ~60                   | Lit palette ~150 LOC, native `Menu` ~100 LOC, settings adapter wiring ~60 LOC.                                                                                                                             |
| 4                    | Auth, secrets, remote agents (Electron-side)                                                        | 150–220                 | ~10 in core           | Slimmer because §9 #14 lands first: `texra://` protocol ~80 LOC, `safeStorage` adapter ~80 LOC, `SupabaseSession` host wrapper ~50 LOC.                                                                    |
| 5                    | Diff surface (`<texra-diff-view>` + IPC)                                                            | 400–550                 | —                     | Lit Monaco wrapper 200–400 LOC, worker config ~50 LOC, `editApproval.ts` IPC handler ~120 LOC.                                                                                                             |
| 6                    | Packaging, signing, auto-update                                                                     | 250–350 (mostly config) | —                     | `electron-builder.yml` ~150 LOC YAML, per-OS GitHub Actions matrix ~120 LOC, updater wiring ~80 LOC.                                                                                                       |
| 7                    | Beta polish (walkthrough, Sentry, log viewer, importer)                                             | 350–450                 | ~30                   | Walkthrough modal ~150 LOC, Sentry init + scrubber ~80 LOC, log-viewer pane ~120 LOC, migration importer ~100 LOC.                                                                                         |
| **Total `desktop/`** |                                                                                                     | **~2,180–2,900**        | **~395**              | Within the §12 cap of ~3,000 net new LOC. Trimmed since the renderer collapsed (3 files instead of 4, no separate windowManager) and Phase 4 became a thin wrapper around the extracted `SupabaseSession`. |

#### LOC by component (`packages/desktop/src/main/` + `renderer/`)

| Component                                                                           | New LOC          | Notes                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `main/index.ts` (lifecycle, single-instance lock, fix-path top-of-file)             | ~120             | Cold-start bookkeeping, single-instance, `fix-path()` cached.                                                                                                                                                                                                                                                            |
| `main/platform/` (8 files: config, state×2, log, fs, workspace, storage, secrets)   | 250–400          | Mirrors VS Code impls in `src/frontend/vscode/` (~300 LOC today).                                                                                                                                                                                                                                                        |
| `main/ipc.ts` (single file: `ipcMain.handle` for RPC + `webContents.send` for push) | ~150             | Wraps Zod schemas from `core/shared/` directly; the preload bridge IS the transport — no separate adapter file in `core/`.                                                                                                                                                                                               |
| `main/menu.ts`                                                                      | ~100             | Native menu mapping top 20 commands.                                                                                                                                                                                                                                                                                     |
| `main/protocol.ts` (`texra://` handler)                                             | ~80              | Mirrors `src/auth/UriHandler.ts` logic (~150 LOC) but reuses the extracted `parseAuthCallback()`.                                                                                                                                                                                                                        |
| `main/updater.ts`                                                                   | ~80              | electron-updater event wiring + user-consent dialog.                                                                                                                                                                                                                                                                     |
| (window creation in `main/index.ts`)                                                | included above   | electron-window-state inlined into `main/index.ts`; no separate file at v1 (per §7.1 simplification).                                                                                                                                                                                                                    |
| `main/contextMenu.ts` (electron-context-menu)                                       | ~30              | Configuration only.                                                                                                                                                                                                                                                                                                      |
| `main/log.ts` (electron-log → LogBackend)                                           | ~80              | Adapter pattern, file rotation config.                                                                                                                                                                                                                                                                                   |
| `main/pathFix.ts`                                                                   | ~50              | `fix-path` + explicit augmentation of `/Library/TeX/texbin`, `/opt/homebrew/bin`, `/usr/local/bin`.                                                                                                                                                                                                                      |
| `main/editApproval.ts`                                                              | ~120             | Replaces `nativeToolEditApproval.ts` (439 LOC); most of the diff-temp-file work moves to `core/`.                                                                                                                                                                                                                        |
| `preload/index.ts`                                                                  | ~80              | `contextBridge` API surface (~10 methods).                                                                                                                                                                                                                                                                               |
| `renderer/main.ts` (mounts the three Lit apps)                                      | ~100             | Boots `<main-app>` / `<progress-app>` / `<settings-app>` and routes via `toggleView` state.                                                                                                                                                                                                                              |
| `renderer/TexraDiffView.ts`                                                         | 200–400          | Largest single new component; lazy-loads Monaco. Lives directly under `renderer/` (no `components/` subdir at v1 — only one component).                                                                                                                                                                                  |
| `renderer/themeTokens.css`                                                          | ~150             | 53 tokens × 3 themes (light/dark/HC).                                                                                                                                                                                                                                                                                    |
| `renderer/index.html`                                                               | ~30              | Single-window shell.                                                                                                                                                                                                                                                                                                     |
| Beta polish (walkthrough modal, log-viewer pane, migration importer)                | ~370             | Phase 7 deliverables.                                                                                                                                                                                                                                                                                                    |
| **Subtotal**                                                                        | **~1,990–2,340** | Sum of the rows above. The phase table reaches ~2,180–2,900 because it also counts ~150 LOC of `electron-builder.yml` YAML, ~120 LOC of GitHub Actions workflow YAML, and ~50 LOC of platform-impl Vitest invariant tests — which aren't standalone runtime components but do ship in the desktop package's source tree. |

#### LOC for `packages/core/` and `packages/extension/` (changes to existing code)

These are the §9 pre-refactorings + the unavoidable cross-cutting changes during Phase 0–5.

| Item                                                                                            | Net new LOC                        | Modified / refactored LOC                              | Notes                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| §9 #1 Expanded `ConfigProvider` (write/inspect/isExplicitlySet/watch) + `configUtils.ts` rewire | ~200                               | ~126                                                   | Interface expansion required for Phase 3 settings round-trip; not just a `get()` wrapper.                                                                                                                                                                        |
| §9 #2 `DiffViewHost` interface + VS Code wrapper                                                | ~40                                | ~80                                                    | Native impl wraps existing `vscode.diff` call site.                                                                                                                                                                                                              |
| §9 #3 `vscode.EventEmitter` → Node `EventEmitter`                                               | —                                  | ~30                                                    | 10 mechanical sites.                                                                                                                                                                                                                                             |
| §9 #4 `WorkspaceProvider.watch()` interface + impl                                              | ~60                                | —                                                      | Interface + VS Code impl wraps `createFileSystemWatcher`.                                                                                                                                                                                                        |
| §9 #14 `SupabaseSession` + `SupabaseClient` extraction                                          | ~80                                | ~1,000 moved + ~190 glue                               | Two host-agnostic classes (auth + API client) with `TokenProvider` boundary. Subsumes #5.                                                                                                                                                                        |
| §9 #18 Host-neutral controller extraction + narrow UI ports                                     | ~280 (interfaces + 5 narrow ports) | ~2,800 moved + ~750 glue rewritten                     | Splits ~3,551 LOC of handlers into core controllers; introduces 5 narrow UI ports (Prompt, ExternalOpener, Diff, Terminal, Clipboard — no CommandHost) at ~30–60 LOC each so `Platform` doesn't become a UI mega-facade. Phase 2/3 desktop work depends on this. |
| §9 #19 `AgentDirectories` / resource-sync adapter                                               | ~150                               | ~100 (slim `AgentDirectoryManager` of `vscode` import) | Host-agnostic copy-on-version-bump from bundled `resources/agents/` into per-host writable storage.                                                                                                                                                              |
| §9 #6 `hostBridge.ts` transport seam                                                            | ~5                                 | ~45                                                    | Shared bridge contract via `HOST_BRIDGE_API_KEY`, with VS Code fallback through `acquireVsCodeApi`.                                                                                                                                                              |
| §9 #7 `--vscode-*` → `--texra-*` token shim                                                     | ~100                               | ~450                                                   | New `themeTokens.css` + ~25 components touched by find-replace.                                                                                                                                                                                                  |
| §9 #8 `BinaryResolver` extraction                                                               | ~80                                | ~120                                                   | Service + call-site routing audit.                                                                                                                                                                                                                               |
| §9 #9 Settings Zod schema (Tier 2 — recommended)                                                | ~600                               | —                                                      | Mirrors `package.json` `contributes.configuration`; eliminates JSON-schema/Zod drift.                                                                                                                                                                            |
| §9 #11 ESLint vscode-import rule                                                                | ~50                                | —                                                      | Custom flat-config rule.                                                                                                                                                                                                                                         |
| §9 #12 Codex unpack rehearsal harness                                                           | ~80                                | ~30                                                    | Test harness + electron-builder config.                                                                                                                                                                                                                          |
| §9 #13 `settingsViewDispatcher.ts` extraction                                                   | ~40                                | ~120                                                   | Move switch out of `SettingsApp.handleMessage()`.                                                                                                                                                                                                                |
| §9 #15 `no-platform-init-outside-composition-root` ESLint rule                                  | ~30                                | —                                                      | Codifies §6.6 composition-root invariant.                                                                                                                                                                                                                        |
| §9 #16 `FakePlatform` for unit tests                                                            | ~150                               | —                                                      | In-memory impls of the 7 platform interfaces; enables fast kernel tests via Vitest.                                                                                                                                                                              |
| §9 #20 `AgentRuntimeHost` / `ProgressSink` boundary                                             | ~120                               | ~150 (refactored at ProgressEventBus call sites)       | Removes the singleton import from agent runtime; v2 utility-process becomes a single adapter swap.                                                                                                                                                               |
| §9 #17 Host-agnostic command catalog                                                            | ~250                               | ~120 (slimmed `src/commands.ts`)                       | Splits per-host wiring out of catalog metadata.                                                                                                                                                                                                                  |
| **Subtotal core/extension**                                                                     | **~2,275**                         | **~6,051**                                             | The bulk of the modified LOC is moved code (~3,800 LOC across #14 and #18) — same logic, new home. Net-new is dominated by interface definitions, narrow UI ports, the ProgressSink boundary (#20), dispatchers, and lint rules.                                 |

#### Aggregate budget

| Bucket                                                                   | Net new LOC      | Modified LOC | Total touched      |
| ------------------------------------------------------------------------ | ---------------- | ------------ | ------------------ |
| `packages/desktop/`                                                      | 2,180–2,900      | ~395         | ~2,575–3,295       |
| `packages/core/` + `extension/` (all §9 pre-refactorings, incl. #15–#20) | ~2,275           | ~6,051       | ~8,326             |
| **Total v1**                                                             | **~4,455–5,175** | **~6,446**   | **~10,901–11,621** |

For comparison: the VS Code extension today is ~853 source files. The agent core (reused unchanged) is ~141 files. The Electron port itself is **~4% of the existing source base** in net-new code. **Most of the "modified LOC" total is not rewriting** — it's existing handler/auth logic relocating from `extension/` into `core/` so it becomes host-neutral. The shape of the work is "move code into the right place" much more than "write new code."

The §12 success criterion is "Total Electron-side new code (in `packages/desktop/`) under ~3,000 LOC." Current estimate sits inside that range when Phase 5 (the diff component) lands at the lower end of its 200–400 LOC band, and slightly over if it lands at the upper end. We adjust scope by deferring Phase 7 polish items (log-viewer pane, migration importer) if needed.

**The bigger story is the pre-refactoring effort** — ~5,800 LOC of moved code in `core/`+`extension/` is real engineering work even if the LOC count is mostly relocation. Without it, Phase 2/3 of the Electron port has no plan for the ~3,551 LOC of host-side message-handler logic and the auth client. Pre-refactorings #1, #14, and especially #18 are the gates; they pay off twice — they unblock the Electron port AND give the extension a cleaner architecture today.

#### What's NOT counted in this LOC budget

- **Configuration files**: `electron-builder.yml`, GitHub Actions workflows, `pnpm-workspace.yaml`, `tsconfig.json`s. Roughly ~400 LOC of YAML / JSON / TS config, not application code.
- **CI scripts**: signing, notarization, sourcemap upload. ~150 LOC of shell + workflow YAML.
- **Test code**: Vitest + Playwright suites. Estimated 600–1,000 LOC for v1 coverage; written alongside features but not in the budget above.
- **Documentation**: install guide, troubleshooting, migration doc, runbook. Markdown only.

Total config + CI + tests + docs: another ~1,500–2,200 LOC of non-application code spread across the project.

## 15. Tech stack one-liner

```

electron-vite + electron-builder + electron-updater (→ public release repo)

- conf + safeStorage + chokidar4 + Monaco (lazy-loaded, diff only)
- Lit (existing) + diff-match-patch (existing, inline only) + fix-path
- pnpm workspaces (3 packages, ESM-first) + Sentry Electron (opt-in)
- electron-window-state + electron-context-menu + vite-plugin-monaco-editor
- Vitest (Electron-side tests) + Playwright (E2E)

```

That's the whole story. Every other line of code already exists.

```

```
