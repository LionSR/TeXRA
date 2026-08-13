# Electron Migration Plan for TeXRA

## Goal

Make TeXRA a standalone Electron app **while keeping the VS Code extension working**. Both targets share the same core logic; only the "shell" (host environment) differs.

---

## Current State: VS Code Coupling Audit

| Layer                                | Files importing `vscode`             | Severity                           |
| ------------------------------------ | ------------------------------------ | ---------------------------------- |
| `src/agent/` (core logic)            | **3** (runtime, storage, remote)     | Low — easily decoupled             |
| `src/model/`                         | **0**                                | None                               |
| `src/latex/`                         | **1** (latexdiff)                    | Low                                |
| `src/tools/`                         | **10**                               | Medium — approval UI, editor tools |
| `src/utils/`                         | **5** (config, FS, system)           | **High** — used everywhere         |
| `src/common/`                        | **7** (webview bases, state, errors) | **High** — foundational            |
| `src/frontend/`                      | **16**                               | **High** — all VS Code UI          |
| `src/commands/`                      | **42**                               | **High** — all VS Code commands    |
| `src/webview/` (extension-host side) | **8**                                | High                               |
| `src/progressView/`                  | **6**                                | High                               |
| `src/settingsView/`                  | **5**                                | High                               |
| `src/auth/`                          | **7**                                | Medium                             |
| Webview frontends (Lit components)   | **0** (browser-only)                 | None                               |

**Total: ~112 files** import `vscode`, with **~613 individual API call sites**.

### Most-Used VS Code APIs

1. **`vscode.workspace.fs`** — File system operations (BaseFS, StorageFS)
2. **`vscode.workspace.getConfiguration()`** — All settings access (configUtils)
3. **`vscode.window.show*`** — Dialogs, quick picks, notifications (~231 calls)
4. **`vscode.commands.executeCommand`** — Command dispatch
5. **`vscode.window.createWebviewPanel / registerWebviewViewProvider`** — Webview lifecycle
6. **`context.secrets`** — API key storage (SecretManager)
7. **`context.globalState / workspaceState`** — State persistence
8. **`vscode.Uri`** — Path handling
9. **`vscode.authentication`** — Auth provider registration
10. **`vscode.window.createStatusBarItem`** — Status indicators

---

## Architecture Strategy: Platform Abstraction Layer (PAL)

Create a thin **Platform Abstraction Layer** that both VS Code and Electron implement. Core logic codes against the PAL interfaces, never against `vscode` directly.

```
┌─────────────────────────────────────────────┐
│              Webview UI (Lit)                │  ← Unchanged, runs in
│          (browser environment)              │     BrowserWindow or WebviewView
├─────────────────────────────────────────────┤
│              IPC Bridge                     │  ← postMessage (both platforms)
├──────────────────────┬──────────────────────┤
│   VS Code Host       │   Electron Main      │  ← Platform-specific shells
│   (extension.ts)     │   (main.ts)          │
├──────────────────────┴──────────────────────┤
│         Platform Abstraction Layer          │  ← NEW: interfaces only
│   (src/platform/)                           │
├─────────────────────────────────────────────┤
│              Core Business Logic            │  ← Agent, Model, LaTeX, Tools
│   (src/agent/, src/model/, src/latex/...)   │     Zero vscode imports
└─────────────────────────────────────────────┘
```

---

## Refactoring Phases

### Phase 1: Define Platform Interfaces (`src/platform/`)

Create interface-only files that define what the host environment must provide. No implementation here — just contracts.

#### 1.1 `src/platform/filesystem.ts` — File System

```typescript
export interface PlatformFS {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  readBytes(path: string): Promise<Buffer>;
  write(path: string, content: string | Uint8Array): Promise<void>;
  delete(path: string, options?: { recursive?: boolean }): Promise<void>;
  createDir(path: string): Promise<void>;
  readDir(path: string): Promise<{ name: string; isDirectory: boolean }[]>;
  stat(path: string): Promise<{
    size: number;
    mtime: number;
    isDirectory: boolean;
    isFile: boolean;
  }>;
  copy(source: string, destination: string): Promise<void>;
  rename(source: string, destination: string): Promise<void>;
  // Sync variants
  existsSync(path: string): boolean;
  readSync(path: string): string;
  writeSync(path: string, content: string | Buffer): void;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
}
```

#### 1.2 `src/platform/config.ts` — Configuration

```typescript
export interface PlatformConfig {
  get<T>(path: string, defaultValue?: T): T;
  update<T>(
    path: string,
    value: T,
    scope?: 'global' | 'workspace',
  ): Promise<void>;
  isExplicitlySet(key: string): boolean;
  onChange(keys: string[], callback: () => void): Disposable;
}
```

#### 1.3 `src/platform/secrets.ts` — Secret Storage

```typescript
export interface PlatformSecrets {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
```

#### 1.4 `src/platform/ui.ts` — UI Primitives

```typescript
export interface PlatformUI {
  showInformation(
    message: string,
    ...actions: string[]
  ): Promise<string | undefined>;
  showWarning(
    message: string,
    ...actions: string[]
  ): Promise<string | undefined>;
  showError(message: string, ...actions: string[]): Promise<string | undefined>;
  showQuickPick<T extends QuickPickItem>(
    items: T[],
    options?: QuickPickOptions,
  ): Promise<T | undefined>;
  showInputBox(options?: InputBoxOptions): Promise<string | undefined>;
  showOpenDialog(options?: OpenDialogOptions): Promise<string[] | undefined>;
  showSaveDialog(options?: SaveDialogOptions): Promise<string | undefined>;
  setStatusBarText(text: string, tooltip?: string): void;
}
```

#### 1.5 `src/platform/editor.ts` — Text Editor

```typescript
export interface PlatformEditor {
  openFile(
    path: string,
    options?: { preview?: boolean; selection?: Range },
  ): Promise<void>;
  getActiveFilePath(): string | undefined;
  showDiff(original: string, modified: string, title: string): Promise<void>;
  applyEdit(path: string, edits: TextEdit[]): Promise<boolean>;
}
```

#### 1.6 `src/platform/shell.ts` — Terminal/Process

```typescript
export interface PlatformShell {
  exec(
    command: string,
    options?: { cwd?: string; timeout?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  spawn(command: string, args: string[], options?: SpawnOptions): ChildProcess;
}
```

#### 1.7 `src/platform/auth.ts` — Authentication

```typescript
export interface PlatformAuth {
  registerAuthProvider(provider: AuthProvider): Disposable;
  registerUriHandler(handler: UriHandler): Disposable;
  getSession(providerId: string): Promise<AuthSession | undefined>;
}
```

#### 1.8 `src/platform/context.ts` — App Context

```typescript
export interface PlatformContext {
  extensionPath: string;
  globalStoragePath: string;
  workspaceStoragePath: string;
  workspaceRoot: string;
  subscriptions: Disposable[];

  // State persistence (replaces globalState/workspaceState)
  getState<T>(key: string, scope?: 'global' | 'workspace'): T | undefined;
  setState<T>(
    key: string,
    value: T,
    scope?: 'global' | 'workspace',
  ): Promise<void>;
}
```

#### 1.9 `src/platform/index.ts` — Platform Registry

```typescript
export interface Platform {
  fs: PlatformFS;
  config: PlatformConfig;
  secrets: PlatformSecrets;
  ui: PlatformUI;
  editor: PlatformEditor;
  shell: PlatformShell;
  auth: PlatformAuth;
  context: PlatformContext;
}

let _platform: Platform;
export function setPlatform(p: Platform): void {
  _platform = p;
}
export function platform(): Platform {
  return _platform;
}
```

---

### Phase 2: Implement VS Code Platform (`src/platform/vscode/`)

Wrap existing VS Code API calls behind the platform interfaces. This is a **mechanical refactor** — behavior stays identical.

| File               | Wraps                                                          |
| ------------------ | -------------------------------------------------------------- |
| `vscodeFS.ts`      | `vscode.workspace.fs` + `vscode.Uri.file()`                    |
| `vscodeConfig.ts`  | `vscode.workspace.getConfiguration()`                          |
| `vscodeSecrets.ts` | `context.secrets`                                              |
| `vscodeUI.ts`      | `vscode.window.show*`, quick picks, dialogs                    |
| `vscodeEditor.ts`  | `vscode.window.activeTextEditor`, `vscode.workspace.applyEdit` |
| `vscodeShell.ts`   | `child_process` (already used)                                 |
| `vscodeAuth.ts`    | `vscode.authentication`                                        |
| `vscodeContext.ts` | `vscode.ExtensionContext` properties                           |

**Key principle**: `extension.ts` calls `setPlatform(createVSCodePlatform(context))` at activation. Everything downstream uses `platform()`.

---

### Phase 3: Decouple Core Logic from VS Code

Migrate imports file-by-file, prioritizing the most-used modules first.

#### 3.1 High Priority: Foundation Layer

| Current                                                    | Change to                                  |
| ---------------------------------------------------------- | ------------------------------------------ |
| `src/utils/config/configUtils.ts`                          | Use `platform().config`                    |
| `src/utils/files/baseFS.ts`                                | Use `platform().fs`                        |
| `src/utils/files/storageFS.ts`                             | Use `platform().fs` + `platform().context` |
| `src/utils/files/workspaceFS.ts`                           | Use `platform().fs` + `platform().context` |
| `packages/extension/src/frontend/secretManager.ts`         | Use `platform().secrets`                   |
| `src/common/state/stateManager.ts`                         | Use `platform().context.getState/setState` |
| `packages/extension/src/frontend/ui/errorHandlingUtils.ts` | Use `platform().ui` for error dialogs      |

This alone removes ~30 transitive `vscode` dependencies.

#### 3.2 Medium Priority: Agent Runtime

Only 3 files in `src/agent/` import vscode:

- `src/agent/runtime/executeAgent.ts` — Uses `vscode.window.showErrorMessage`, `vscode.commands.executeCommand`. Replace with `platform().ui` and a command dispatch abstraction.
- `src/agent/storage/executionListing.ts` — Uses `vscode.workspace.fs`. Replace with `platform().fs`.
- `src/agent/remote/remoteAgentUtils.ts` — Uses `vscode.env.openExternal`, `vscode.Uri`. Replace with `platform().shell` (open URL) and plain strings.

#### 3.3 Medium Priority: Tools

Tools use VS Code for:

- **Edit approval** (`toolEditApproval.ts`) — Diff views via `vscode.commands.executeCommand('vscode.diff')`. Abstract via `platform().editor.showDiff()`.
- **Diagnostics** (`DiagnosticsTool.ts`) — `vscode.languages.getDiagnostics()`. Abstract via `platform().editor`.
- **Text editor** (`TextEditorTool.ts`) — Direct editor manipulation. Abstract via `platform().editor`.
- **Notifications** (`toolUnavailableNotification.ts`) — `vscode.window.showWarning`. Use `platform().ui`.

#### 3.4 Lower Priority: Commands & Frontend

The `src/commands/` and `src/frontend/` directories are **inherently platform-specific** — they bridge UI actions to core logic. For these:

- Extract the **core logic** (the "what") into platform-agnostic functions
- Keep the **wiring** (the "how to trigger") platform-specific
- Both VS Code commands and Electron IPC handlers call the same core functions

---

### Phase 4: Webview IPC Abstraction (`src/shared/ipc/`)

The webview UI (Lit components) is already platform-agnostic. The IPC layer needs a thin abstraction:

```typescript
// src/shared/ipc/bridge.ts
export interface IPCBridge {
  postMessage(message: unknown): void;
  onMessage(handler: (message: unknown) => void): Disposable;
}
```

**VS Code implementation**: Uses `vscode.Webview.postMessage` / `webview.onDidReceiveMessage`
**Electron implementation**: Uses `ipcMain` / `ipcRenderer` (or `BrowserWindow.webContents.send`)

The existing message schemas in `src/shared/schemas/` stay unchanged — they define the protocol, not the transport.

---

### Phase 5: Implement Electron Platform (`src/platform/electron/`)

| File                 | Implementation                                                                        |
| -------------------- | ------------------------------------------------------------------------------------- |
| `electronFS.ts`      | Node.js `fs/promises` (direct — no VS Code wrapper needed)                            |
| `electronConfig.ts`  | `electron-store` or JSON file in `app.getPath('userData')`                            |
| `electronSecrets.ts` | `safeStorage.encryptString()` + file storage, or `keytar`                             |
| `electronUI.ts`      | `dialog.showMessageBox`, `dialog.showOpenDialog`, custom notification windows         |
| `electronEditor.ts`  | Monaco Editor or CodeMirror in a BrowserWindow                                        |
| `electronShell.ts`   | Node.js `child_process` (same as VS Code)                                             |
| `electronAuth.ts`    | OAuth via system browser + custom protocol handler (`app.setAsDefaultProtocolClient`) |
| `electronContext.ts` | `app.getPath()` for storage paths, JSON-backed state                                  |

---

### Phase 6: Electron App Shell

```
electron/
├── main.ts              # Electron main process entry
├── preload.ts           # Context bridge for renderer
├── windows/
│   ├── mainWindow.ts    # Primary BrowserWindow (hosts Lit webview UI)
│   ├── progressWindow.ts
│   └── settingsWindow.ts
├── menu.ts              # Native menus (replaces VS Code command palette)
├── tray.ts              # System tray (optional)
├── updater.ts           # Auto-update via electron-updater
└── platform/            # Electron PAL implementations
```

`main.ts` calls `setPlatform(createElectronPlatform())` then creates windows.

---

## Build System Changes

### Dual Build Targets

```
npm run compile:vscode    # Existing — esbuild + Vite → VS Code extension
npm run compile:electron  # New — esbuild + Vite → Electron app
npm run compile:fast      # Builds both (or the default target)
```

Shared config:

- **esbuild** compiles `src/` for both targets. Use `--define` to set `PLATFORM=vscode|electron` at build time for tree-shaking dead platform code.
- **Vite** builds webview frontends unchanged (same Lit components).
- **electron-builder** packages the Electron app for Windows/macOS/Linux.

### Package Structure

```json
// package.json changes
{
  "main": "dist/extension.js", // VS Code entry (existing)
  "electron-main": "dist/electron/main.js", // Electron entry (new)
  "scripts": {
    "electron:dev": "electron dist/electron/main.js",
    "electron:build": "electron-builder",
    "compile:electron": "esbuild ... --define:PLATFORM=electron && vite build"
  }
}
```

### Local macOS Desktop Package

The monorepo now has a local unsigned package rehearsal for the Electron desktop app. It produces a
macOS `.app` bundle from the built desktop main, preload, and renderer artifacts, then verifies the
packaged `app.asar` contains the expected runtime files. The package verifier also reads the
desktop main esbuild metafile and checks that the startup import graph does not eagerly pull in
provider SDKs that should remain behind lazy agent-execution imports. Its Codex payload check
rejects unexpected platform packages independently of size. Size ceilings use the audited npm
unpacked size of each `@openai/codex` 0.144.1 platform package plus 16 MiB of headroom per retained
package; a universal build receives the sum of its component ceilings. A future Codex update that
exceeds this headroom requires a tarball-content review before the platform baseline is updated.

From the repository root:

```bash
corepack pnpm install --frozen-lockfile
npm run desktop:package:local
npm run check:desktop-package
npm run desktop:package:smoke
```

On Apple Silicon macOS, the local app bundle is written to:

```text
packages/desktop/dist-packaged/mac-arm64/TeXRA.app
```

Open it directly from Finder or from the terminal:

```bash
open packages/desktop/dist-packaged/mac-arm64/TeXRA.app
```

This build is intentionally unsigned and not notarized. macOS may block the first launch; right-click
the app and choose Open from Finder, or remove the quarantine attribute for a local development build:

```bash
xattr -dr com.apple.quarantine packages/desktop/dist-packaged/mac-arm64/TeXRA.app
```

Use the full initial-build check when validating both shipped targets together:

```bash
npm run build:initial
```

That command builds the Electron desktop app and the VS Code extension package, then checks that the
desktop build artifacts and `.vsix` are present.

`npm run desktop:package:smoke` uses Playwright's Electron support to launch an unpacked packaged app
with an isolated temporary profile and workspace. Launch has a 30-second timeout; after launch, the
smoke asserts that Electron reports `app.isPackaged`, then waits up to 30 seconds for a visible desktop
shell, a rendered `main-app` shadow root, and the theme state returned by the `WEBVIEW_READY` to
`desktopViewState` IPC round trip. The packaged child inherits only an explicit allowlist of operating-
system path, display, and locale variables; signing credentials and future job-level secrets are
excluded by default. Process errors fail readiness immediately but remain separate from actual process
exit observation, so teardown still waits for termination and escalates to a forced stop when needed.
The desktop package workflow runs this readiness gate against Electron Builder's `mac-universal`,
`win-unpacked`, and `linux-unpacked` outputs on their respective operating systems before uploading
installer artifacts. This gate validates the unpacked application, not installer mounting,
installation, uninstallation, or operating-system trust dialogs.

### Local macOS Desktop Installer

To produce an installable macOS artifact, run the distributable package command from the repository
root:

```bash
npm run desktop:package:dist
npm run check:desktop-installers
```

The release package path is:

```text
packages/desktop/dist-packaged/
```

For macOS, the distributable targets are a DMG and ZIP. Windows release builds use NSIS, and Linux
release builds use AppImage and deb. CI release installer jobs can sign and notarize macOS artifacts
and sign Windows artifacts when the repository secrets in `docs/dev/release/desktop-signing-ci.md` are
configured. Local smoke tests should continue using `npm run desktop:package:local` because the
unpacked directory target launches faster and keeps startup regression coverage separate from
installer generation.

### Desktop Update Artifact Publishing

Electron Builder is configured to generate public GitHub update metadata for
`texra-ai/texra-desktop-releases`. Local distributable builds still pass `--publish never`, so
running `npm run desktop:package:dist` produces unsigned local artifacts without uploading them.

On pushes to `main`, CI collects the per-OS installer outputs and update metadata:

- macOS: DMG, ZIP, ZIP blockmap, and `latest-mac.yml`
- Windows: NSIS executable, blockmap, and `latest.yml`
- Linux: AppImage, deb, blockmap, and `latest-linux.yml`

The `publish desktop release artifacts` job downloads those workflow artifacts, verifies that the
Electron Builder publish target is still the public `texra-ai/texra-desktop-releases` repository,
checks that update metadata exists and points at a generated update-capable installer, and then
uploads the files to the matching public GitHub release. The GitHub credential is confined to CI via
the `DESKTOP_RELEASES_TOKEN` secret; installed desktop clients should read the public update metadata
and artifacts without a client-side `GH_TOKEN`.

---

## What Stays the Same

These require **zero changes** for Electron:

- **Agent system** (`src/agent/`) — PocketFlow, model handlers, all reasoning logic
- **Model handlers** (`src/agent/modelHandlers/`) — Pure HTTP/SDK calls
- **LaTeX processing** (`src/latex/`) — CLI tool wrappers
- **Webview UI** (`src/webview/frontend/`, `src/progressView/frontend/`, `src/settingsView/frontend/`) — Lit components are pure browser code
- **Shared schemas** (`src/shared/schemas/`) — Zod message definitions
- **Replacement rules** (`src/replacement/`) — Pure text processing
- **Event bus** (`src/eventBus/`) — In-process pub/sub
- **Logger core** (`src/logger/`) — Winston (just add Electron transports)

---

## Recommended Execution Order

### Step 1: Create `src/platform/` interfaces (Phase 1)

Non-breaking. Add files, no existing code changes.

### Step 2: Create VS Code implementations (Phase 2)

Non-breaking. Wrap existing APIs behind interfaces.

### Step 3: Migrate foundation layer (Phase 3.1)

**This is the big one.** Change `configUtils`, `baseFS`, `storageFS`, `secretManager`, `stateManager` to use `platform()`. All 112 files that transitively depend on these get decoupled automatically.

### Step 4: Migrate agent runtime (Phase 3.2)

Small — only 3 files.

### Step 5: Migrate tools (Phase 3.3)

~10 files, mostly replacing `vscode.window.show*` calls.

### Step 6: Extract command core logic (Phase 3.4)

Ongoing — extract reusable logic from commands as needed for Electron.

### Step 7: IPC abstraction (Phase 4)

Small — bridge interface + two implementations.

### Step 8: Electron platform + app shell (Phases 5-6)

Build the Electron-specific code.

---

## Electron-Specific Considerations

### File/Project Management

VS Code provides workspace management. In Electron you need:

- "Open Folder" dialog → set working directory
- Recent projects list
- File watching (`chokidar` or `fs.watch`)
- Project-scoped settings (stored alongside workspace)

### Text Editing

The Electron app needs a code editor component for viewing/editing LaTeX. Options:

- **Monaco Editor** (VS Code's editor, MIT licensed) — Full-featured, familiar
- **CodeMirror 6** — Lighter weight, excellent LaTeX mode
- **Read-only** initially — Just display outputs, let users use their preferred editor

### Native Menus & Shortcuts

Replace the VS Code command palette with:

- Native application menu (File, Edit, Agent, LaTeX, Help)
- Keyboard shortcuts mapped to the same core functions
- Context menus on file lists

### Auto-Update

Use `electron-updater` with GitHub Releases (already used for `.vsix` distribution).

### Code Signing

Required for macOS notarization and Windows SmartScreen. Budget for Apple Developer ($99/year) and Windows code signing certificates.

---

## File-Level Migration Tracker

Approximate effort per directory:

| Directory             | Files to Migrate | Effort | Notes                                      |
| --------------------- | ---------------- | ------ | ------------------------------------------ |
| `src/platform/`       | 0 → ~20 new      | Medium | New interfaces + 2 implementations         |
| `src/utils/config/`   | 1                | Small  | `configUtils.ts` → `platform().config`     |
| `src/utils/files/`    | 3                | Medium | `baseFS`, `storageFS`, `workspaceFS`       |
| `src/common/state/`   | 1                | Small  | `stateManager.ts`                          |
| `src/common/errors/`  | 1                | Small  | Error dialog calls                         |
| `src/common/webview/` | 4                | Medium | Base classes need IPC abstraction          |
| `src/frontend/`       | 16               | Large  | Most VS Code-heavy; extract core logic     |
| `src/commands/`       | 42               | Large  | Extract business logic from command wiring |
| `src/tools/`          | 10               | Medium | Approval UI, editor integration            |
| `src/agent/`          | 3                | Small  | Minimal VS Code coupling                   |
| `src/auth/`           | 7                | Medium | OAuth flow differs per platform            |
| `src/webview/` (host) | 8                | Medium | Provider + message handler adaptation      |
| `src/progressView/`   | 6                | Medium | Same pattern as webview                    |
| `src/settingsView/`   | 5                | Medium | Same pattern as webview                    |

---

## Summary

The core insight is that TeXRA's business logic (agents, models, LaTeX, tools) is already largely decoupled from VS Code. The coupling is concentrated in:

1. **Foundation utilities** (FS, config, secrets, state) — 5 files that everything depends on
2. **UI/UX layer** (commands, dialogs, webview providers) — many files but inherently platform-specific

By introducing a Platform Abstraction Layer and migrating the foundation utilities first (Phase 3.1), you decouple the majority of the codebase in one step. The rest is incremental.
