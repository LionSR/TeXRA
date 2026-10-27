# VS Code extension guidelines

Folder-scoped addition to the root [AGENTS.md](../../../AGENTS.md) for the VS Code
extension host and its webviews (`progressView`, `settingsView`).

## Directory organization

- `packages/extension/src/frontend/` - Extension-host utilities behind shared UI flows (`system/`, `ui/`, `editor/`, `agents/`, `latex/`: agent directories, approvals, editor and LaTeX integration, instruction banners, status bar). Use them instead of duplicating logic in commands or webviews.
- `packages/extension/src/common/` - Extension-only helpers: the webview content provider (`webview/BundledViewContentProvider.ts`, which also builds the webview HTML) and shared styles.

## Webviews

Generate HTML through `BundledViewContentProvider` and include every common module path in `localResourceRoots` (a missing one is a 401). There is no shared message-handler base class; two architectures coexist, so match the view you are touching:

- **`settingsView`** is request/response. `SettingsViewMessageHandler` (`packages/extension/src/settingsView/`) owns inbound dispatch over the shared settings body (`packages/texra/src/controllers/settingsView/sharedSettingsCommands.ts`) and its page modules; only the VS Code LaTeX handlers live in `settingsView/handlers/latexSettingsHandlers.ts`. Commands are the `SETTINGS_VIEW_COMMANDS` constants in `packages/texra/src/shared/ipc.ts`. Frontend state is module-level `trackedSignal`s in `settingsView/frontend/settingsState.ts`; `settingsView/frontend/messageDispatcher.ts` holds the one outbound registry (`settingsViewHandlers`, typed `SettingsViewOutboundHandlerRegistry` to stay exhaustive).
- **`progressView`** (sidebar and editor-tab conversation) is event-driven. `ProgressViewProvider` implements `vscode.WebviewViewProvider` directly over `BundledViewContentProvider` and routes through `SessionBridge` / `HostDraftRequests` as typed `runtime.request` / `host.request` calls (`.agents/docs/implemented/architecture/2026-09-03-prd-one-fold-three-renderers.md`). Its Lit components (`progressView/frontend/components/`) take the `SessionView` (`packages/harness/src/shared/session/sessionView.ts`) and `Surface` records as properties.
- Name classes `[Domain]View[Component]` (`SettingsViewMessageHandler`, `ProgressViewProvider`). A genuinely new pattern updates this section, not a silent third variant.
- Icons are Web Awesome (`waIcon()` from `@ui/wa/webAwesomeIcons`). Shared helpers come from `@texra-ai/harness/schemas` (paths, text), `@ui/copy/format` (sizes, relative times) and `@texra-ai/harness/transcript` (`formatCompactDuration`). Per-component styles are TypeScript in the view's `frontend/`; shared tokens are in `packages/extension/src/common/styles/common.css`. Read `packages/texra/src/ui/README.md` before adding a control or a local style override.

## Errors and commands

- Surface errors with `showLoggedErrorMessage` / `showLoggedMessageWithDocs` (`packages/extension/src/frontend/ui/errorHandlingUtils.ts`) for consistent telemetry and doc links.
- Run VS Code commands with `safeExecuteCommand` (`packages/extension/src/frontend/system/commandUtils.ts`) and shell commands with `executeCommand` (`packages/harness/src/utils/system/execUtils.ts`).
- Shared notification primitives: `packages/extension/src/frontend/ui/dialogs.ts` and `instruction.ts`.
