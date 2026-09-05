// The document resources of one paper. Selection changes which owner is visible;
// only tab closure, paper closure, or document disposal releases its resources.

import { nothing, type TemplateResult } from 'lit';

import type { SessionSurfaces } from '@progressView/frontend/sessionSurfaces';
import type { Theme } from '@shared/schemas';
import { postMessage } from '@shared/hostBridge';

import {
  DesktopTaskShellStateSchema,
  initialDesktopTaskShellState,
  openWorkbenchTab,
  setWorkbenchTabDirty,
  type DesktopTaskShellState,
} from '../shared/desktopTaskShell';
import { DESKTOP_WORKSPACE_COMMANDS } from '../shared/desktopWorkspaceMessages';
import { createEditorPane } from './editorPane';
import {
  disposePendingFileRequests,
  requestFileRead,
  requestFileWrite,
  requestFiles,
} from './fileRequests';
import { createPdfPane } from './pdfPane';
import { createReviewPane } from './reviewPane';
import { createTerminalPane } from './terminalPane';
import { createWorkbenchController } from './workbenchController';

export function createPaperWorkbench(options: {
  session: string;
  root: string | undefined;
  surfaces: SessionSurfaces;
  settingsView: HTMLElement;
  logsPane: HTMLElement;
  isActive(): boolean;
  subagentsTemplate(): TemplateResult | typeof nothing;
  onLayoutChanged(
    session: string,
    previous: DesktopTaskShellState,
    next: DesktopTaskShellState,
  ): void;
}) {
  const { session, surfaces } = options;
  const surface = surfaces.get(session);
  if (!surface) throw new Error(`No surface for paper ${session}.`);
  const restored = surface.surface$.get().workbench;
  const layout =
    restored === null
      ? initialDesktopTaskShellState()
      : DesktopTaskShellStateSchema.parse(restored);
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
  const getState = () =>
    surface.surface$.get().workbench as DesktopTaskShellState;
  function updateState(next: DesktopTaskShellState): void {
    if (disposed) return;
    const previous = getState();
    if (previous === next) return;
    surfaces.act(session, { kind: 'workbench', layout: next });
    options.onLayoutChanged(session, previous, next);
  }
  const send = (command: string, payload?: Record<string, unknown>) =>
    postMessage(command, { ...payload, session });
  const editorPane = createEditorPane({
    listFiles: (directory) => requestFiles(session, directory),
    readFile: (path) => requestFileRead(session, path),
    writeFile: (path, contents) => requestFileWrite(session, path, contents),
    onRequestOpen: (path) =>
      updateState(
        openWorkbenchTab(getState(), { kind: 'editor', target: path }),
      ),
    onDirtyChange: (path, dirty) =>
      updateState(
        setWorkbenchTabDirty(getState(), `workbench:editor:${path}`, dirty),
      ),
    onError: (error) => {
      // Closing a paper rejects its pending I/O as part of disposal.
      if (!disposed) console.error('TeXRA editor pane', error);
    },
  });
  const terminalPane = createTerminalPane({
    start: (sessionId, cols, rows) => {
      const initialCommand = workbench.takePendingTerminalCommand(sessionId);
      send(DESKTOP_WORKSPACE_COMMANDS.TERMINAL_START, {
        sessionId,
        cols,
        rows,
        ...(initialCommand ? { initialCommand } : {}),
      });
    },
    sendInput: (sessionId, data) =>
      send(DESKTOP_WORKSPACE_COMMANDS.TERMINAL_INPUT, { sessionId, data }),
    resize: (sessionId, cols, rows) =>
      send(DESKTOP_WORKSPACE_COMMANDS.TERMINAL_RESIZE, {
        sessionId,
        cols,
        rows,
      }),
    close: (sessionId) =>
      send(DESKTOP_WORKSPACE_COMMANDS.TERMINAL_CLOSE, { sessionId }),
  });
  const reviewPane = createReviewPane();
  const pdfPane = createPdfPane();
  const workbench = createWorkbenchController({
    session,
    isActive: options.isActive,
    editorPane,
    terminalPane,
    reviewPane,
    pdfPane,
    subagentsTemplate: options.subagentsTemplate,
    settingsView: options.settingsView,
    logsPane: options.logsPane,
    getState,
    getWorkspacePath: () => options.root,
    updateShell: updateState,
    postMessage: send,
  });

  return {
    session,
    getState,
    updateState,
    editorPane,
    terminalPane,
    reviewPane,
    workbench,
    setTheme(theme: Theme) {
      editorPane.setTheme(theme);
      reviewPane.setTheme(theme);
    },
    dispose() {
      disposed = true;
      editorPane.dispose();
      disposePendingFileRequests(session);
      terminalPane.disposeAll();
      for (const tab of getState().workbenchTabs) {
        if (tab.kind === 'pdf') pdfPane.dispose(tab.id);
        if (tab.kind === 'browser')
          send(DESKTOP_WORKSPACE_COMMANDS.BROWSER_CLOSE, { tabId: tab.id });
      }
      reviewPane.clear();
    },
  };
}
