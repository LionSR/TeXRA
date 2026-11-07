// The document resources of one project. Selection changes which owner is visible;
// only tab closure, project closure, or document disposal releases its resources.

import { Effect, Result, Schema, Struct } from 'effect';

import { isPackagedAgentSource } from '@texra-ai/harness/schemas';
import type { HostCommand } from '@texra/shared/session/hostRequest';
import type { HostOutcome } from '@texra/shared/session/sessionFrames';
import { postMessage } from '@texra/shared/hostBridge';
import type { Theme } from '@texra/shared/ipc';
import type { SessionSurfaces } from '@ui/progress/sessionSurfaces';
import type { ProgressApp } from '@ui/progress/ProgressApp';
import { requestErrorText } from '@ui/copy/requestErrors';

import {
  DesktopShellStateSchema,
  initialDesktopShellState,
  openWorkbenchTab,
  setWorkbenchTabDirty,
  type DesktopShellState,
} from '../shared/desktopShellState';
import {
  DESKTOP_WORKSPACE_COMMANDS,
  type DesktopWorkspaceRequest,
} from '../shared/desktopWorkspaceMessages';
import { createEditorPane } from './editorPane';
import { createPdfPane } from './pdfPane';
import { createReviewPane } from './reviewPane';
import { createTerminalPane } from './terminalPane';
import { createWorkbenchController } from './workbenchController';
import { agentDocumentIdentity } from '../shared/desktopAgentDocument';

const FILE_REQUEST_TIMEOUT_MS = 60_000;

export function createProjectWorkbench(options: {
  session: string;
  surfaces: SessionSurfaces;
  logsPane: HTMLElement;
  conversationView: ProgressApp;
  isActive(): boolean;
  isBrowserCovered(): boolean;
  confirmDiscard(title: string, discard: () => void): void;
  onLayoutChanged(
    session: string,
    previous: DesktopShellState,
    next: DesktopShellState,
  ): void;
}) {
  const { session, surfaces } = options;
  const surface = surfaces.get(session);
  if (!surface) throw new Error(`No surface for project ${session}.`);
  const layout = restoredLayout(session, surface.surface$.get().workbench);
  surfaces.act(session, {
    kind: 'workbench',
    layout: {
      ...layout,
      workbenchTabs: layout.workbenchTabs.map((tab) => ({
        ...tab,
        dirty: false,
      })),
    },
  });

  let disposed = false;
  // `Surface.workbench` is untyped storage (`Record<string, unknown> | null`)
  // shared with hosts that have no workbench at all; validate on every read
  // rather than trusting a cast, but skip the reparse when the raw value is
  // still the one `updateState` last wrote.
  let cachedRaw: unknown = surface.surface$.get().workbench;
  let cachedState: DesktopShellState = Schema.decodeUnknownSync(
    DesktopShellStateSchema,
  )(cachedRaw);
  const getState = (): DesktopShellState => {
    const raw = surface.surface$.get().workbench;
    if (raw !== cachedRaw) {
      cachedState = Schema.decodeUnknownSync(DesktopShellStateSchema)(raw);
      cachedRaw = raw;
    }
    return cachedState;
  };
  function updateState(next: DesktopShellState): void {
    if (disposed) return;
    const previous = getState();
    if (previous === next) return;
    surfaces.act(session, { kind: 'workbench', layout: next });
    options.onLayoutChanged(session, previous, next);
  }
  const send = (message: DesktopWorkspaceRequest) =>
    postMessage(message.command, { ...message, session });
  // The editor's file I/O is a host request answered to the pane, its
  // refusal worded as the progress view words one; closing the pane
  // interrupts whatever is still pending.
  const unexpected = (outcome: HostOutcome) =>
    Effect.fail(
      new Error(`The host answered a file request with ${outcome.kind}.`),
    );
  // A read or a list on a hung mount would otherwise leave the pane's refresh
  // pending until the project closes. A write is never abandoned: the host
  // cannot cancel it, and a retry must not race a write still in flight.
  const workspaceFile = (
    action: Extract<HostCommand, { kind: 'workspaceFile' }>['action'],
  ) =>
    surfaces
      .answer(
        {
          kind: 'host.request',
          session,
          requestId: crypto.randomUUID(),
          request: { kind: 'workspaceFile', action },
        },
        action.kind === 'write' ? undefined : FILE_REQUEST_TIMEOUT_MS,
      )
      .pipe(Effect.mapError((error) => new Error(requestErrorText(error))));
  const editorCallbacks = {
    isReadOnly: (path: string) => {
      const identity = agentDocumentIdentity(path);
      return identity ? isPackagedAgentSource(identity.source) : false;
    },
    listFiles: (directory) =>
      Effect.flatMap(workspaceFile({ kind: 'list', directory }), (outcome) =>
        outcome.kind === 'entries'
          ? Effect.succeed(outcome.entries)
          : unexpected(outcome),
      ),
    readFile: (path) =>
      Effect.flatMap(workspaceFile({ kind: 'read', path }), (outcome) =>
        outcome.kind === 'contents'
          ? Effect.succeed(outcome.contents)
          : unexpected(outcome),
      ),
    writeFile: (path, contents, base) =>
      Effect.flatMap(
        workspaceFile({ kind: 'write', path, contents, base }),
        (outcome) => {
          switch (outcome.kind) {
            case 'changedOnDisk':
              return Effect.succeed('changedOnDisk' as const);
            case 'done':
              return Effect.succeed('saved' as const);
            default:
              return unexpected(outcome);
          }
        },
      ),
    onRequestOpen: openDocument,
    onDirtyChange: (path, dirty) =>
      updateState(
        setWorkbenchTabDirty(getState(), `workbench:editor:${path}`, dirty),
      ),
    onError: (error) => {
      // Closing a project rejects its pending I/O as part of disposal.
      if (!disposed) console.error('TeXRA editor pane', error);
    },
  } satisfies Parameters<typeof createEditorPane>[0];
  const fileTree = createEditorPane(editorCallbacks);
  const editors = new Map<string, ReturnType<typeof createEditorPane>>();
  let currentTheme: Theme | undefined;
  function editorFor(tabId: string) {
    let editor = editors.get(tabId);
    if (!editor) {
      editor = createEditorPane(editorCallbacks);
      if (currentTheme) editor.setTheme(currentTheme);
      editors.set(tabId, editor);
    }
    return editor;
  }
  function openDocument(target: string): void {
    const id = `workbench:editor:${target}`;
    // An already active tab emits no activation event. Explicitly reopening it
    // still checks disk, while preserving unsaved edits through the pane's guard.
    if (workbench.activeTabId() === id) void editors.get(id)?.open(target);
    updateState(openWorkbenchTab(getState(), { kind: 'editor', target }));
  }
  const terminalPane = createTerminalPane({
    start: (sessionId, cols, rows) => {
      const initialCommand = workbench.takePendingTerminalCommand(sessionId);
      send({
        command: DESKTOP_WORKSPACE_COMMANDS.TERMINAL_START,
        sessionId,
        cols,
        rows,
        ...(initialCommand ? { initialCommand } : {}),
      });
    },
    sendInput: (sessionId, data) =>
      send({
        command: DESKTOP_WORKSPACE_COMMANDS.TERMINAL_INPUT,
        sessionId,
        data,
      }),
    resize: (sessionId, cols, rows) =>
      send({
        command: DESKTOP_WORKSPACE_COMMANDS.TERMINAL_RESIZE,
        sessionId,
        cols,
        rows,
      }),
    close: (sessionId) =>
      send({ command: DESKTOP_WORKSPACE_COMMANDS.TERMINAL_CLOSE, sessionId }),
  });
  const reviewPane = createReviewPane();
  const pdfPane = createPdfPane();
  const workbench = createWorkbenchController({
    session,
    isActive: options.isActive,
    isBrowserCovered: options.isBrowserCovered,
    confirmDiscard: options.confirmDiscard,
    conversationView: options.conversationView,
    fileTree,
    editorFor,
    closeEditor: (id) => {
      editors.get(id)?.dispose();
      editors.delete(id);
    },
    terminalPane,
    reviewPane,
    pdfPane,
    logsPane: options.logsPane,
    getState,
    updateShell: updateState,
    postMessage: send,
  });

  return {
    session,
    getState,
    updateState,
    conversationView: options.conversationView,
    fileTree,
    openDocument,
    async refreshFiles() {
      await Promise.all([
        fileTree.refresh(),
        ...[...editors.values()].map((editor) => editor.refresh()),
      ]);
    },
    saveActiveEditor() {
      const id = workbench.activeTabId();
      if (id) void editors.get(id)?.save();
    },
    hasUnsavedChanges() {
      return [...editors.values()].some((editor) => editor.hasUnsavedChanges());
    },
    terminalPane,
    reviewPane,
    workbench,
    setTheme(theme: Theme) {
      currentTheme = theme;
      for (const editor of editors.values()) editor.setTheme(theme);
      reviewPane.setTheme(theme);
      terminalPane.refreshTheme();
    },
    dispose() {
      disposed = true;
      workbench.dispose();
      fileTree.dispose();
      for (const editor of editors.values()) editor.dispose();
      terminalPane.disposeAll();
      for (const tab of getState().workbenchTabs) {
        if (tab.kind === 'pdf') pdfPane.dispose(tab.id);
        if (tab.kind === 'browser')
          send({
            command: DESKTOP_WORKSPACE_COMMANDS.BROWSER_CLOSE,
            tabId: tab.id,
          });
      }
      reviewPane.clear();
    },
  };
}

/**
 * The persisted layout, or a fresh one when there is none or it no longer
 * parses (a tab kind this build does not have). The layout is view state, so
 * an unreadable one is reset rather than failing the whole project, and the
 * reset is logged with its cause. The project name shares the blob but is
 * user-typed, not view state: a still-valid one survives the reset, which is
 * written back over the blob.
 */
function restoredLayout(session: string, restored: unknown): DesktopShellState {
  if (restored === null) return initialDesktopShellState();
  const parsed = Schema.decodeUnknownResult(DesktopShellStateSchema)(restored);
  if (Result.isSuccess(parsed)) {
    const state = parsed.success;
    if (
      !state.dockLayout &&
      !state.workbenchTabs.some((tab) => tab.kind === 'agent')
    )
      return openWorkbenchTab(state, { kind: 'agent' });
    return state;
  }
  console.warn(
    `[desktop] resetting the unreadable workbench layout of ${session}: ${parsed.failure.message}`,
  );
  const kept = Schema.decodeUnknownResult(
    DesktopShellStateSchema.mapFields(Struct.pick(['projectName'])),
  )(restored);
  return {
    ...initialDesktopShellState(),
    ...(Result.isSuccess(kept)
      ? { projectName: kept.success.projectName }
      : {}),
  };
}
