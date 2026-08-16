import { isAbsolute, resolve } from 'node:path';

import {
  getEditedFileListConfig,
  getFileListConfig,
  loadFileListSettings,
  matchesEditedFile,
  type FileListConfig,
  type ListableFileType,
} from '@common/files/fileListingRules';
import { listWorkspaceFiles } from '@common/files/workspaceFileListing';
import { createLog } from '@logger/logUtils';
import { platform } from '@platform/platform';
import { relativeToRoot } from '@platform/defaults/nodeWorkspace';
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';
import {
  MainViewInboundMessageSchema,
  type MainViewInboundMessage,
} from '@shared/schemas';
import { normalizeFilePath } from '@utils/core';

import type {
  DesktopCommandMessage,
  DesktopMessageHandler,
} from './desktopIpcTypes.js';

type MessageFor<C extends MainViewInboundMessage['command']> = Extract<
  MainViewInboundMessage,
  { command: C }
>;

type SelectMultipleFilesMessage = MessageFor<
  typeof MAIN_VIEW_COMMANDS.SELECT_MULTIPLE_FILES
>;

interface DesktopFileSelectionDialogOptions {
  title: string;
  defaultPath?: string;
  filters: Array<{ name: string; extensions: string[] }>;
  allowMultiple?: boolean;
}

export interface DesktopFileSelectionOptions {
  postToRenderer(message: unknown): void;
  getWorkspacePath?: () => string | undefined;
  showOpenFileDialog?: (
    options: DesktopFileSelectionDialogOptions,
  ) => Promise<string[] | undefined>;
  onError?: (error: unknown) => void;
}

export type DesktopFileSelection = DesktopMessageHandler;

// Only base/edited use single-file SET commands; input/context/media
// route through SELECT_MULTIPLE_FILES.
const SET_COMMAND_BY_FILE_TYPE = {
  edited: MAIN_VIEW_COMMANDS.SET_EDITED_FILE,
  base: MAIN_VIEW_COMMANDS.SET_BASE_FILE,
} as const;

const MULTI_SET_COMMAND_BY_FILE_TYPE = {
  input: MAIN_VIEW_COMMANDS.SET_INPUT_FILES,
  context: MAIN_VIEW_COMMANDS.SET_CONTEXT_FILES,
  media: MAIN_VIEW_COMMANDS.SET_MEDIA_FILES,
} as const;

const MULTI_DIALOG_TITLE_BY_FILE_TYPE = {
  input: 'Select input files',
  context: 'Select context files',
  media: 'Select media files',
} as const;

type DesktopMultiFileType = keyof typeof MULTI_SET_COMMAND_BY_FILE_TYPE;

async function listFiles(
  root: string,
  rawConfig: FileListConfig,
): Promise<string[]> {
  return listWorkspaceFiles({
    root,
    config: rawConfig,
    readDirectory: (directory) => platform().fs.readDirectory(directory),
  });
}

/**
 * List the workspace files of one listable type under the current file-list
 * settings. Empty when no workspace is open or the type has no configured
 * rules.
 */
export async function listDesktopWorkspaceFiles(
  fileType: ListableFileType,
  // Not a default parameter: callers inject a getter that returns undefined to
  // mean "no workspace", and a default would discard that and re-read the
  // process-wide workspace instead.
  workspacePath: string | undefined,
): Promise<string[]> {
  const config = getFileListConfig(fileType, loadFileListSettings());
  if (!workspacePath || !config) return [];
  return listFiles(workspacePath, config);
}

function resolveWorkspaceFile(workspacePath: string, filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(workspacePath, filePath);
}

function toWorkspaceRelative(workspacePath: string, filePath: string): string {
  const absolutePath = resolveWorkspaceFile(workspacePath, filePath);
  // relativeToRoot shares the canonicalize-then-compare fallback
  // createNodeWorkspace().asRelativePath uses, so a native dialog pick that
  // resolves through a symlink (e.g. a symlinked folder inside the workspace)
  // lands workspace-relative here too, matching WorkspaceFS.relativePath for
  // the same absolute path. Unlike asRelativePath's identity fallback, an
  // outside-workspace pick stays an explicit normalized absolute path — the
  // renderer must be able to open a file chosen outside the workspace.
  return (
    relativeToRoot(workspacePath, absolutePath) ??
    normalizeFilePath(absolutePath)
  );
}

export function createDesktopFileSelection(
  options: DesktopFileSelectionOptions,
): DesktopFileSelection {
  const getWorkspacePath =
    options.getWorkspacePath ?? (() => platform().workspace.getWorkspacePath());
  const onError = options.onError ?? defaultOnError;

  function runAsync(work: Promise<void>): void {
    void work.catch(onError);
  }

  function postFileList(
    fileType: keyof typeof SET_COMMAND_BY_FILE_TYPE,
    files: string[],
    preserveBaseFile = false,
  ) {
    options.postToRenderer({
      command: SET_COMMAND_BY_FILE_TYPE[fileType],
      files,
      ...(preserveBaseFile && { preserveBaseFile: true }),
    });
  }

  function list(fileType: ListableFileType): Promise<string[]> {
    return listDesktopWorkspaceFiles(fileType, getWorkspacePath());
  }

  // The base file is listed from the input rules: base is a single-slot view
  // over the input list.
  async function requestBaseFileList(preserveBaseFile: boolean) {
    const files = await list('input');
    postFileList('base', files, preserveBaseFile);
  }

  // Multi-list categories (input/context/media) are user-owned and only
  // mutated via the picker / drag-drop / Add opened — so we just refresh
  // the still-single-slot base-file dropdown and the empty-workspace banner.
  async function refreshDiskBackedDropdowns() {
    const inputFiles = await list('input');
    postFileList('base', inputFiles, true);
    options.postToRenderer({
      command:
        inputFiles.length === 0
          ? MAIN_VIEW_COMMANDS.SHOW_GETTING_STARTED_BANNER
          : MAIN_VIEW_COMMANDS.HIDE_GETTING_STARTED_BANNER,
    });
  }

  async function updateEditedFiles(baseFile?: string) {
    const workspacePath = getWorkspacePath();
    if (!baseFile || !workspacePath) {
      postFileList('edited', []);
      return;
    }
    const config = getEditedFileListConfig(loadFileListSettings());
    const files = (await listFiles(workspacePath, config)).filter((file) =>
      matchesEditedFile(file, baseFile),
    );
    postFileList('edited', files);
  }

  function isDesktopMultiFileType(
    value: string,
  ): value is DesktopMultiFileType {
    return Object.hasOwn(MULTI_SET_COMMAND_BY_FILE_TYPE, value);
  }

  async function selectMultipleFiles(message: SelectMultipleFilesMessage) {
    if (!options.showOpenFileDialog) return;
    if (!isDesktopMultiFileType(message.fileType)) {
      // The shared webview posts this for 'output' too, which the desktop has
      // no picker for. Say so rather than dropping it: handleMessage already
      // reported the message as handled.
      createLog('DesktopFileSelection').warn(
        `Unsupported multiple file selection: ${message.fileType}`,
      );
      return;
    }
    const workspacePath = getWorkspacePath();
    if (!workspacePath) return;

    const fileType = message.fileType;
    const listConfig = getFileListConfig(fileType, loadFileListSettings());
    const currentFile = message.currentFile;
    const defaultPath =
      currentFile != null
        ? resolveWorkspaceFile(workspacePath, currentFile)
        : workspacePath;
    const selectedFiles = await options.showOpenFileDialog({
      title: MULTI_DIALOG_TITLE_BY_FILE_TYPE[fileType],
      defaultPath,
      allowMultiple: true,
      filters: [
        {
          name: 'Supported files',
          // Electron's dialog filter extensions must not include the leading
          // dot (unlike getFileListConfig's `.tex`-style entries); the VS
          // Code picker gets this right via getFilterExtensions.
          extensions: (listConfig?.extensions ?? ['*']).map((ext) =>
            ext.replace(/^\./, ''),
          ),
        },
      ],
    });
    if (!selectedFiles) return;
    options.postToRenderer({
      command: MULTI_SET_COMMAND_BY_FILE_TYPE[fileType],
      files: selectedFiles.map((file) =>
        toWorkspaceRelative(workspacePath, file),
      ),
    });
  }

  function dispatch(message: MainViewInboundMessage): boolean {
    switch (message.command) {
      case MAIN_VIEW_COMMANDS.SELECT_MULTIPLE_FILES:
        runAsync(selectMultipleFiles(message));
        return true;
      case MAIN_VIEW_COMMANDS.REQUEST_BASE_FILE:
        runAsync(requestBaseFileList(message.preserveBaseFile === true));
        return true;
      case MAIN_VIEW_COMMANDS.REFRESH_ALL_FILES:
        runAsync(refreshDiskBackedDropdowns());
        return true;
      case MAIN_VIEW_COMMANDS.REQUEST_EDITED_FILE:
        runAsync(updateEditedFiles(message.baseFile));
        return true;
      default:
        return false;
    }
  }

  // Single discriminated-union parse at the entry point, matching every
  // other desktop IPC adapter (see desktopShellIpc.ts) — the switch above
  // then operates on the narrowed variant with no per-case guessing at field
  // types or presence.
  function handleMessage(message: DesktopCommandMessage): boolean {
    const parsed = MainViewInboundMessageSchema.safeParse(message);
    return parsed.success ? dispatch(parsed.data) : false;
  }

  return { handleMessage };
}

function defaultOnError(error: unknown): void {
  console.error(error);
}
