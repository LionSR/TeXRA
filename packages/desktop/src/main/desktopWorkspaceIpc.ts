// Main-process IPC for the workspace shell surfaces: editor file I/O, terminal
// pty sessions, and embedded browser tabs.
//
// All three are renderer-driven, and the renderer is sandboxed with no node
// integration, so every request lands here. Requests are Zod-validated at the
// boundary and — for file I/O — confined to the workspace root before touching
// disk: a path from the renderer is untrusted input, and `../` traversal would
// otherwise read or overwrite anything the user can reach.

import { basename, dirname, join } from 'node:path';
import { isFileNotFoundError } from '@common/errors';
import {
  loadFileListSettings,
  passesFileFilters,
  prepareFileFilters,
  shouldVisitDirectory,
} from '@common/files/fileListingRules';
import { getIncludedExtensions } from '@common/files/fileTypeUtils';
import { platform } from '@platform/platform';
import { normalizeFilePath } from '@utils/core';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { isPathWithin } from '@utils/core/pathCore';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { isDirectory, isFile, isSymlink } from '@utils/files/fsEntryType';
import { OFFICE_EXTENSIONS } from '@utils/files/mimeUtils';

import {
  DESKTOP_WORKSPACE_COMMANDS,
  DesktopWorkspaceInboundMessageSchema,
  EMPTY_DESKTOP_ENVIRONMENT_SUMMARY,
  type DesktopBrowserBounds,
  type DesktopEnvironmentSummary,
} from '../shared/desktopWorkspaceMessages.js';
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
  getEnvironmentSummary?(): Promise<DesktopEnvironmentSummary>;
  onAsyncError?(error: unknown): void;
}

export interface DesktopWorkspaceIpc extends DesktopMessageHandler {
  /**
   * Releases resources owned by the current renderer document.
   *
   * Renderer reload creates a new terminal-id namespace and a new browser-tab
   * layout, so neither resource may survive across that boundary.
   */
  disposeRendererResources(): void;
}

/** Lexical workspace containment check: rejects `..` traversal, or throws. */
function locateWorkspaceTarget(inputPath: string): {
  absolutePath: string;
  root: string;
} {
  const located = WorkspaceFS.locatePath(inputPath);
  if (located.kind !== 'workspace') {
    throw new Error('Only files inside the workspace folder can be opened.');
  }

  const root = WorkspaceFS.getPath();
  if (!root) {
    throw new Error('Workspace path is not available.');
  }
  return { absolutePath: located.absolutePath, root };
}

/**
 * Resolves a renderer-supplied path inside the workspace, or throws.
 *
 * The lexical check rejects `..` traversal first. Canonical paths are then
 * compared so a workspace symlink cannot lead the editor outside the project.
 */
async function resolveWorkspacePath(inputPath: string): Promise<string> {
  const { absolutePath, root } = locateWorkspaceTarget(inputPath);
  const [canonicalRoot, canonicalTarget] = await Promise.all([
    platform().fs.realPath(root),
    platform().fs.realPath(absolutePath),
  ]);
  if (!isPathWithin(canonicalRoot, canonicalTarget)) {
    throw new Error('Only files inside the workspace folder can be opened.');
  }
  return canonicalTarget;
}

/**
 * Resolves a write target without requiring the file itself to still exist.
 * The canonical parent remains mandatory, so recreating an externally deleted
 * file cannot bypass the workspace or symlink boundary.
 */
async function resolveWorkspaceWritePath(inputPath: string): Promise<string> {
  try {
    return await resolveWorkspacePath(inputPath);
  } catch (error) {
    if (!isFileNotFoundError(error)) throw error;
  }

  const { absolutePath, root } = locateWorkspaceTarget(inputPath);

  // A dangling symlink also makes realPath fail with ENOENT. It must remain
  // rejected: writing through it could create a target outside the workspace.
  try {
    if (await platform().fs.isSymlink(absolutePath)) {
      throw new Error('Symbolic links cannot be recreated by the editor.');
    }
  } catch (error) {
    if (!isFileNotFoundError(error)) throw error;
  }

  let canonicalRoot: string;
  let canonicalParent: string;
  try {
    [canonicalRoot, canonicalParent] = await Promise.all([
      platform().fs.realPath(root),
      platform().fs.realPath(dirname(absolutePath)),
    ]);
  } catch (error) {
    if (isFileNotFoundError(error)) {
      throw new Error(
        'The file cannot be recreated because its parent folder no longer exists.',
      );
    }
    throw error;
  }
  const canonicalTarget = join(canonicalParent, basename(absolutePath));
  if (!isPathWithin(canonicalRoot, canonicalTarget)) {
    throw new Error('Only files inside the workspace folder can be opened.');
  }
  return canonicalTarget;
}

export function createDesktopWorkspaceIpc(
  renderer: DesktopRenderer,
  options: DesktopWorkspaceIpcOptions,
): DesktopWorkspaceIpc {
  const reportError = (error: unknown) => options.onAsyncError?.(error);

  function postFileError(
    requestId: string,
    path: string,
    error: unknown,
  ): void {
    renderer.postToRenderer({
      command: DESKTOP_WORKSPACE_COMMANDS.FILE_ERROR,
      requestId,
      path,
      message: toErrorMessage(error),
    });
  }

  async function listFiles(
    requestId: string,
    directory: string,
  ): Promise<void> {
    const normalizedDirectory = normalizeFilePath(directory)
      .replace(/^\.\//, '')
      .replace(/\/$/, '');
    try {
      const root = WorkspaceFS.getPath();
      if (!root) {
        renderer.postToRenderer({
          command: DESKTOP_WORKSPACE_COMMANDS.FILES_LISTED,
          requestId,
          directory: normalizedDirectory,
          files: [],
        });
        return;
      }

      const settings = loadFileListSettings();
      // The project tree is a code editor, not the agent input picker. Reuse
      // the shared ignore policy, but do not inherit
      // the input picker's `.ts`/`.js`/`.json` exclusions. Only known binary
      // media and office formats are hidden from this text editor.
      const filters = prepareFileFilters({
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
      });
      const absoluteDirectory = normalizedDirectory
        ? await resolveWorkspacePath(normalizedDirectory)
        : root;
      const entries = await platform().fs.readDirectory(absoluteDirectory);
      const files = entries
        .toSorted(([left], [right]) =>
          left.localeCompare(right, undefined, {
            numeric: true,
            sensitivity: 'base',
          }),
        )
        .flatMap(([name, type]) => {
          if (isSymlink(type)) return [];
          const path = normalizeFilePath(
            normalizedDirectory ? join(normalizedDirectory, name) : name,
          );
          if (isDirectory(type)) {
            return shouldVisitDirectory(path, filters)
              ? [{ path, isDirectory: true }]
              : [];
          }
          return isFile(type) && passesFileFilters(path, filters)
            ? [{ path, isDirectory: false }]
            : [];
        });
      renderer.postToRenderer({
        command: DESKTOP_WORKSPACE_COMMANDS.FILES_LISTED,
        requestId,
        directory: normalizedDirectory,
        files,
      });
    } catch (error) {
      reportError(error);
      renderer.postToRenderer({
        command: DESKTOP_WORKSPACE_COMMANDS.FILES_LIST_ERROR,
        requestId,
        directory: normalizedDirectory,
        message: toErrorMessage(error),
      });
    }
  }

  async function readFile(requestId: string, path: string): Promise<void> {
    try {
      const contents = await WorkspaceFS.read(await resolveWorkspacePath(path));
      renderer.postToRenderer({
        command: DESKTOP_WORKSPACE_COMMANDS.FILE_READ,
        requestId,
        path,
        contents,
      });
    } catch (error) {
      reportError(error);
      postFileError(requestId, path, error);
    }
  }

  async function writeFile(
    requestId: string,
    path: string,
    contents: string,
  ): Promise<void> {
    try {
      await WorkspaceFS.write(await resolveWorkspaceWritePath(path), contents);
      renderer.postToRenderer({
        command: DESKTOP_WORKSPACE_COMMANDS.FILE_WRITTEN,
        requestId,
        path,
      });
    } catch (error) {
      reportError(error);
      postFileError(requestId, path, error);
    }
  }

  async function startTerminal(
    sessionId: string,
    cols: number,
    rows: number,
    initialCommand?: string,
  ): Promise<void> {
    try {
      const session = await options.ptyHost.create({
        id: sessionId,
        cols,
        rows,
      });
      if (!session) return;
      if (initialCommand) {
        session.write(`${initialCommand}\r`);
      }
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
    disposeRendererResources() {
      options.ptyHost.disposeAll();
      options.browserViews.disposeAll();
    },

    handleMessage(message: DesktopCommandMessage) {
      const parsed = DesktopWorkspaceInboundMessageSchema.safeParse(message);
      if (!parsed.success) return false;
      const data = parsed.data;

      switch (data.command) {
        case DESKTOP_WORKSPACE_COMMANDS.LIST_FILES:
          void listFiles(data.requestId, data.directory);
          return true;
        case DESKTOP_WORKSPACE_COMMANDS.READ_FILE:
          void readFile(data.requestId, data.path);
          return true;
        case DESKTOP_WORKSPACE_COMMANDS.WRITE_FILE:
          void writeFile(data.requestId, data.path, data.contents);
          return true;

        case DESKTOP_WORKSPACE_COMMANDS.TERMINAL_START:
          void startTerminal(
            data.sessionId,
            data.cols,
            data.rows,
            data.initialCommand,
          );
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
        case DESKTOP_WORKSPACE_COMMANDS.ENVIRONMENT_REQUEST: {
          const postEnvironment = (environment: DesktopEnvironmentSummary) =>
            renderer.postToRenderer({
              command: DESKTOP_WORKSPACE_COMMANDS.ENVIRONMENT_STATE,
              environment,
            });
          if (!options.getEnvironmentSummary) {
            postEnvironment(EMPTY_DESKTOP_ENVIRONMENT_SUMMARY);
            return true;
          }
          void options
            .getEnvironmentSummary()
            .then(postEnvironment)
            .catch((error: unknown) => {
              reportError(error);
              postEnvironment(EMPTY_DESKTOP_ENVIRONMENT_SUMMARY);
            });
          return true;
        }
      }
    },
  };
}
