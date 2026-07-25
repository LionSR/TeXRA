// Main-process IPC for the workspace shell surfaces: editor file I/O, terminal
// pty sessions, and embedded browser tabs.
//
// All three are renderer-driven, and the renderer is sandboxed with no node
// integration, so every request lands here. Requests are Zod-validated at the
// boundary and — for file I/O — confined to the workspace root before touching
// disk: a path from the renderer is untrusted input, and `../` traversal would
// otherwise read or overwrite anything the user can reach.

import { listWorkspaceFiles } from '@common/files/workspaceFileListing';
import { loadFileListSettings } from '@common/files/fileListingRules';
import { getIncludedExtensions } from '@common/files/fileTypeUtils';
import { platform } from '@platform/platform';
import { WorkspaceFS } from '@utils/files';
import { getConfig } from '@utils/config/configUtils';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { OFFICE_EXTENSIONS } from '@utils/files/mimeUtils';

import {
  DESKTOP_WORKSPACE_COMMANDS,
  DesktopWorkspaceInboundMessageSchema,
  type DesktopBrowserBounds,
} from '../desktopWorkspaceMessages.js';
import type {
  DesktopCommandMessage,
  DesktopMessageHandler,
  DesktopRenderer,
} from './desktopIpcTypes.js';
import type { DesktopPtyHost } from './desktopPtyHost.js';
import type { DesktopBrowserViews } from './desktopBrowserViews.js';

export interface DesktopWorkspaceIpcOptions {
  ptyHost: DesktopPtyHost;
  browserViews: DesktopBrowserViews;
  /**
   * Translates renderer-reported CSS pixel bounds into window coordinates.
   * A WebContentsView is positioned in device-independent window space, which
   * differs from the renderer's own coordinates under display zoom.
   */
  toWindowBounds(bounds: DesktopBrowserBounds): DesktopBrowserBounds;
  onAsyncError?(error: unknown): void;
}

/**
 * Resolves a renderer-supplied path inside the workspace, or throws.
 *
 * `WorkspaceFS.locatePath` classifies anything escaping the root as
 * 'external'; refusing those is what stops `../../.ssh/id_rsa` from being
 * readable through the editor pane.
 */
function resolveWorkspacePath(inputPath: string): string {
  const located = WorkspaceFS.locatePath(inputPath);
  if (located.kind !== 'workspace') {
    throw new Error('Only files inside the workspace folder can be opened.');
  }
  return located.absolutePath;
}

export function createDesktopWorkspaceIpc(
  renderer: DesktopRenderer,
  options: DesktopWorkspaceIpcOptions,
): DesktopMessageHandler {
  const reportError = (error: unknown) => options.onAsyncError?.(error);

  function postFileError(path: string, error: unknown): void {
    renderer.postToRenderer({
      command: DESKTOP_WORKSPACE_COMMANDS.FILE_ERROR,
      path,
      message: toErrorMessage(error),
    });
  }

  async function listFiles(): Promise<void> {
    try {
      const root = WorkspaceFS.getPath();
      const settings = loadFileListSettings(getConfig);
      // The project tree is a code editor, not the agent input picker. Reuse
      // the shared traversal and ignore-directory policy, but do not inherit
      // the input picker's `.ts`/`.js`/`.json` exclusions. Only known binary
      // media and office formats are hidden from this text editor.
      const config = {
        extensions: [],
        ignoredExtensions: [
          ...new Set([
            ...getIncludedExtensions('media'),
            ...OFFICE_EXTENSIONS,
            '.vsix',
          ]),
        ],
        ignoredDirs: settings.ignoredDirectories,
        ignoredKeywords: [],
        ignoredFiles: [],
      };
      const files = root
        ? await listWorkspaceFiles({
            root,
            config,
            readDirectory: (directory) =>
              platform().fs.readDirectory(directory),
          })
        : [];
      renderer.postToRenderer({
        command: DESKTOP_WORKSPACE_COMMANDS.FILES_LISTED,
        files: files.map((path) => ({ path, isDirectory: false })),
      });
    } catch (error) {
      reportError(error);
      postFileError('', error);
    }
  }

  async function readFile(path: string): Promise<void> {
    try {
      const contents = await WorkspaceFS.read(resolveWorkspacePath(path));
      renderer.postToRenderer({
        command: DESKTOP_WORKSPACE_COMMANDS.FILE_READ,
        path,
        contents,
      });
    } catch (error) {
      reportError(error);
      postFileError(path, error);
    }
  }

  async function writeFile(path: string, contents: string): Promise<void> {
    try {
      await WorkspaceFS.write(resolveWorkspacePath(path), contents);
      renderer.postToRenderer({
        command: DESKTOP_WORKSPACE_COMMANDS.FILE_WRITTEN,
        path,
      });
    } catch (error) {
      reportError(error);
      postFileError(path, error);
    }
  }

  async function startTerminal(
    sessionId: string,
    cols: number,
    rows: number,
  ): Promise<void> {
    try {
      await options.ptyHost.create({ id: sessionId, cols, rows });
    } catch (error) {
      reportError(error);
      // Surface in the terminal itself: a silent no-op looks like a shell that
      // never printed a prompt.
      renderer.postToRenderer({
        command: DESKTOP_WORKSPACE_COMMANDS.TERMINAL_ERROR,
        sessionId,
        message: `Could not start a terminal: ${toErrorMessage(error)}`,
      });
    }
  }

  return {
    handleMessage(message: DesktopCommandMessage) {
      const parsed = DesktopWorkspaceInboundMessageSchema.safeParse(message);
      if (!parsed.success) return false;
      const data = parsed.data;

      switch (data.command) {
        case DESKTOP_WORKSPACE_COMMANDS.LIST_FILES:
          void listFiles();
          return true;
        case DESKTOP_WORKSPACE_COMMANDS.READ_FILE:
          void readFile(data.path);
          return true;
        case DESKTOP_WORKSPACE_COMMANDS.WRITE_FILE:
          void writeFile(data.path, data.contents);
          return true;

        case DESKTOP_WORKSPACE_COMMANDS.TERMINAL_START:
          void startTerminal(data.sessionId, data.cols, data.rows);
          return true;
        case DESKTOP_WORKSPACE_COMMANDS.TERMINAL_INPUT:
          options.ptyHost.get(data.sessionId)?.write(data.data);
          return true;
        case DESKTOP_WORKSPACE_COMMANDS.TERMINAL_RESIZE:
          options.ptyHost.get(data.sessionId)?.resize(data.cols, data.rows);
          return true;
        case DESKTOP_WORKSPACE_COMMANDS.TERMINAL_CLOSE:
          options.ptyHost.get(data.sessionId)?.dispose();
          return true;

        case DESKTOP_WORKSPACE_COMMANDS.BROWSER_OPEN:
          options.browserViews.open(data.tabId, data.url);
          return true;
        case DESKTOP_WORKSPACE_COMMANDS.BROWSER_BOUNDS:
          options.browserViews.show(
            data.tabId,
            options.toWindowBounds(data.bounds),
          );
          return true;
        case DESKTOP_WORKSPACE_COMMANDS.BROWSER_HIDE:
          options.browserViews.hideAll();
          return true;
        case DESKTOP_WORKSPACE_COMMANDS.BROWSER_NAVIGATE:
          options.browserViews.navigate(data.tabId, data.url);
          return true;
        case DESKTOP_WORKSPACE_COMMANDS.BROWSER_BACK:
          options.browserViews.goBack(data.tabId);
          return true;
        case DESKTOP_WORKSPACE_COMMANDS.BROWSER_FORWARD:
          options.browserViews.goForward(data.tabId);
          return true;
        case DESKTOP_WORKSPACE_COMMANDS.BROWSER_RELOAD:
          options.browserViews.reload(data.tabId);
          return true;
        case DESKTOP_WORKSPACE_COMMANDS.BROWSER_CLOSE:
          options.browserViews.close(data.tabId);
          return true;
      }
    },
  };
}
