import { isAbsolute, relative, resolve } from 'node:path';

import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { platform, tryPlatform } from '@platform/platform';
import {
  getEditedFileListConfig,
  getFileListConfig,
  loadFileListSettings,
  matchesEditedFile,
  type FileListConfig,
  type ListableFileType,
} from '@common/files/fileListingRules';
import { listWorkspaceFiles } from '@common/files/workspaceFileListing';
import { MAIN_VIEW_COMMANDS } from '@common/webview/mainViewCommands';
import { normalizeFilePath } from '@shared/utils/path';
import { getConfig } from '@utils/config/configUtils';

import type {
  DesktopCommandMessage,
  DesktopMessageHandler,
} from './desktopIpcTypes.js';

export interface DesktopFileSelectionDialogOptions {
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

type DesktopMultiFileType = keyof typeof MULTI_SET_COMMAND_BY_FILE_TYPE;

function getListSettings() {
  return loadFileListSettings(getConfig);
}

function readDirectory(directory: string) {
  return (tryPlatform()?.fs ?? nodeFilesystem).readDirectory(directory);
}

async function listFiles(
  root: string,
  rawConfig: FileListConfig,
): Promise<string[]> {
  return listWorkspaceFiles({
    root,
    config: rawConfig,
    readDirectory,
  });
}

function resolveWorkspaceFile(workspacePath: string, filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(workspacePath, filePath);
}

function toWorkspaceRelative(workspacePath: string, filePath: string): string {
  const absolutePath = resolveWorkspaceFile(workspacePath, filePath);
  const relativePath = relative(workspacePath, absolutePath);
  return relativePath.startsWith('..') || isAbsolute(relativePath)
    ? normalizeFilePath(absolutePath)
    : normalizeFilePath(relativePath);
}

export function createDesktopFileSelection(
  options: DesktopFileSelectionOptions,
): DesktopFileSelection {
  const getWorkspacePath =
    options.getWorkspacePath ?? (() => platform().workspace.getWorkspacePath());
  const onError =
    options.onError ??
    ((error) => {
      console.error(error);
    });

  function runAsync(work: Promise<void>): void {
    void work.catch(onError);
  }

  function postFileList(
    fileType: keyof typeof SET_COMMAND_BY_FILE_TYPE,
    files: string[],
    additionalPayload: Record<string, unknown> = {},
  ) {
    options.postToRenderer({
      command: SET_COMMAND_BY_FILE_TYPE[fileType],
      files,
      ...additionalPayload,
    });
  }

  function postMultiFileList(fileType: DesktopMultiFileType, files: string[]) {
    options.postToRenderer({
      command: MULTI_SET_COMMAND_BY_FILE_TYPE[fileType],
      files,
    });
  }

  async function list(fileType: ListableFileType): Promise<string[]> {
    const workspacePath = getWorkspacePath();
    const config = getFileListConfig(fileType, getListSettings());
    if (!workspacePath || !config) return [];
    return listFiles(workspacePath, config);
  }

  async function requestSingleFileList(
    fileType: keyof typeof SET_COMMAND_BY_FILE_TYPE,
    listOptions: { preserveBaseFile?: boolean } = {},
  ) {
    const files = await list(
      fileType === 'base' ? 'input' : (fileType as ListableFileType),
    );
    postFileList(
      fileType,
      files,
      listOptions.preserveBaseFile ? { preserveBaseFile: true } : {},
    );
  }

  // Multi-list categories (input/context/media) are user-owned and only
  // mutated via the picker / drag-drop / Add opened — so we just refresh
  // the still-single-slot base-file dropdown and the empty-workspace banner.
  async function refreshDiskBackedDropdowns() {
    const inputFiles = await list('input');
    postFileList('base', inputFiles, { preserveBaseFile: true });
    options.postToRenderer({
      command:
        inputFiles.length === 0
          ? MAIN_VIEW_COMMANDS.SHOW_GETTING_STARTED_BANNER
          : MAIN_VIEW_COMMANDS.HIDE_GETTING_STARTED_BANNER,
    });
  }

  async function updateEditedFiles(baseFile?: string) {
    if (!baseFile) {
      postFileList('edited', []);
      return;
    }
    const workspacePath = getWorkspacePath();
    const config = getEditedFileListConfig(getListSettings());
    if (!workspacePath) {
      postFileList('edited', []);
      return;
    }
    const files = (await listFiles(workspacePath, config)).filter((file) =>
      matchesEditedFile(file, baseFile),
    );
    postFileList('edited', files);
  }

  function isDesktopMultiFileType(
    value: unknown,
  ): value is DesktopMultiFileType {
    return value === 'input' || value === 'context' || value === 'media';
  }

  function getDialogConfig(fileType: DesktopMultiFileType): {
    title: string;
    listType: ListableFileType;
  } {
    switch (fileType) {
      case 'context':
        return { title: 'Select context files', listType: 'context' };
      case 'media':
        return { title: 'Select media files', listType: 'media' };
      case 'input':
        return { title: 'Select input files', listType: 'input' };
    }
  }

  async function selectMultipleFiles(message: DesktopCommandMessage) {
    if (
      !options.showOpenFileDialog ||
      !isDesktopMultiFileType(message.fileType)
    ) {
      return;
    }
    const workspacePath = getWorkspacePath();
    if (!workspacePath) return;

    const { title, listType } = getDialogConfig(message.fileType);
    const listConfig = getFileListConfig(listType, getListSettings());
    const currentFile =
      typeof message.currentFile === 'string' ? message.currentFile : undefined;
    const defaultPath =
      currentFile != null
        ? resolveWorkspaceFile(workspacePath, currentFile)
        : workspacePath;
    const selectedFiles = await options.showOpenFileDialog({
      title,
      defaultPath,
      allowMultiple: true,
      filters: [
        {
          name: 'Supported files',
          extensions: listConfig?.extensions ?? ['*'],
        },
      ],
    });
    if (!selectedFiles) return;
    postMultiFileList(
      message.fileType,
      selectedFiles.map((file) => toWorkspaceRelative(workspacePath, file)),
    );
  }

  function handleMessage(message: DesktopCommandMessage): boolean {
    switch (message.command) {
      case MAIN_VIEW_COMMANDS.SELECT_MULTIPLE_FILES:
        runAsync(selectMultipleFiles(message));
        return true;
      case MAIN_VIEW_COMMANDS.REQUEST_BASE_FILE:
        runAsync(
          requestSingleFileList('base', {
            preserveBaseFile: message.preserveBaseFile === true,
          }),
        );
        return true;
      case MAIN_VIEW_COMMANDS.REFRESH_ALL_FILES:
        runAsync(refreshDiskBackedDropdowns());
        return true;
      case MAIN_VIEW_COMMANDS.REQUEST_EDITED_FILE:
        runAsync(
          updateEditedFiles(
            typeof message.baseFile === 'string' ? message.baseFile : undefined,
          ),
        );
        return true;
      default:
        return false;
    }
  }

  return { handleMessage };
}
