# VS Code extension guidelines

Folder-scoped addition to the root [AGENTS.md](../../../AGENTS.md) for the VS Code
extension host and its webviews (`progressView`, `settingsView`).

## Directory organization

- `packages/extension/src/frontend/` contains extension-host utilities that power shared UI flows (agent directories, file listers, instruction banners, tool workflows; subfolders `system/`, `ui/`, `editor/`, `agents/`, `latex/`, `media/`). Prefer these helpers over duplicating logic in commands or webviews.
- `packages/extension/src/common/` holds extension-only helpers (webview base classes, shared styles):
  - `packages/extension/src/common/webview/` - Webview content provider (`BundledViewContentProvider`), webview HTML builder (`buildWebviewHtml`), command constants

## Coding style

- Keep webview directory structure aligned where views share a concern (`components/`, `styles/`); beyond that `progressView` and `settingsView` intentionally diverge (see "Webview Consistency Patterns").

## Webviews and UI

- Generate HTML through `BundledViewContentProvider` (`packages/extension/src/common/webview/BundledViewContentProvider.ts`) and its `buildWebviewHtml` helper. There is no shared message-handler base class: `settingsView` owns its inbound dispatch inside `SettingsViewMessageHandler` and `progressView` routes through typed host requests, so follow the pattern of the view you are touching (see "Webview Consistency Patterns").
- Use Web Awesome (`<wa-icon>` via `waIcon()` from `@ui/wa/webAwesomeIcons`) and shared utilities from `@utils/text/stringUtils` and `@utils/core` (path basics: `normalizeFilePath`, `getBasename`, `getFileStem`). Keep CSS modular: per-component styles as TypeScript in each view's `frontend/` directory, shared tokens in `packages/extension/src/common/styles/common.css`.

## Error handling

- Format and surface errors through `showLoggedErrorMessage` and `showLoggedMessageWithDocs` in `packages/extension/src/frontend/ui/errorHandlingUtils.ts` for consistent telemetry and documentation links.

## Webview Consistency Patterns

Two message-passing architectures coexist for the extension's views. Match the
one the view you're touching already uses:

- **`settingsView`** is request/response: `SettingsViewMessageHandler`
  (`packages/extension/src/settingsView/`) owns its inbound dispatch directly
  over the shared settings body
  (`packages/texra/src/controllers/settingsView/sharedSettingsCommands.ts`) and its page
  modules; only the VS Code-specific LaTeX arms live in
  `settingsView/handlers/latexSettingsHandlers.ts`. Commands are named constants in `packages/harness/src/shared/ipc.ts` (`COMMON_COMMANDS`,
  `SETTINGS_VIEW_COMMANDS`), not string literals. Frontend state lives in
  module-level reactive signals in `settingsView/frontend/settingsState.ts`
  (`trackedSignal`); `settingsView/frontend/messageDispatcher.ts` holds the one
  outbound handler registry (`settingsViewHandlers`, typed
  `SettingsViewOutboundHandlerRegistry` so it stays exhaustive).
- **`progressView`** (the sidebar and editor-tab conversation shell) is
  event-fold: `ProgressViewProvider` implements `vscode.WebviewViewProvider`
  directly, composed with `BundledViewContentProvider`, and routes through
  `SessionBridge` / `HostDraftRequests` as typed `runtime.request` /
  `host.request` calls (see
  `.agents/docs/implemented/architecture/2026-09-03-one-view-state-three-renderers.md`).
  Its Lit components (`progressView/frontend/components/`) read the
  `SessionView` fold (`packages/harness/src/shared/session/sessionView.ts`) and `Surface`
  records as properties.
- **Naming Convention**: within whichever pattern applies, follow
  `[Domain]View[Component]` (e.g. `SettingsViewMessageHandler`,
  `ProgressViewProvider`). Adding a genuinely new pattern needs an update to
  this section, not a silent third variant.
- **Resource Access**: Include all common module paths in `localResourceRoots` to prevent 401 errors.
- **Design system**: tokens, control skins, and the brand and human-in-the-loop rules are in `packages/texra/src/ui/README.md`. Read it before adding a control or a local style override

## Miscellaneous

- Execute VS Code commands with `safeExecuteCommand` from `packages/extension/src/frontend/system/commandUtils.ts` and shell commands with `executeCommand` from `packages/harness/src/utils/system/execUtils.ts` so logging and error handling stay uniform.
- Use `packages/extension/src/frontend/ui/dialogs.ts` and `instruction.ts` for notification primitives shared across the extension.
