import { isAbsolute, relative, resolve } from 'node:path';

import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { platform, tryPlatform } from '@platform/platform';
import { getFilterExtensions } from '@common/files/fileTypeUtils';
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
}

export interface DesktopFileSelectionOptions {
  postToRenderer(message: unknown): void;
  getWorkspacePath?: () => string | undefined;
  showOpenFileDialog?: (
    options: DesktopFileSelectionDialogOptions,
  ) => Promise<string | undefined>;
  onError?: (error: unknown) => void;
}

export type DesktopFileSelection = DesktopMessageHandler;

const RESPONSE_BY_SELECT_COMMAND = {
  [MAIN_VIEW_COMMANDS.SELECT_INPUT_FILE]:
    MAIN_VIEW_COMMANDS.INPUT_FILE_SELECTED,
  [MAIN_VIEW_COMMANDS.SELECT_REFERENCE_FILE]:
    MAIN_VIEW_COMMANDS.REFERENCE_FILE_SELECTED,
  [MAIN_VIEW_COMMANDS.SELECT_AUXILIARY_FILE]:
    MAIN_VIEW_COMMANDS.AUXILIARY_FILE_SELECTED,
  [MAIN_VIEW_COMMANDS.SELECT_MEDIA_FILE]:
    MAIN_VIEW_COMMANDS.MEDIA_FILE_SELECTED,
} as const;

const TYPE_BY_SELECT_COMMAND = {
  [MAIN_VIEW_COMMANDS.SELECT_INPUT_FILE]: 'input',
  [MAIN_VIEW_COMMANDS.SELECT_REFERENCE_FILE]: 'reference',
  [MAIN_VIEW_COMMANDS.SELECT_AUXILIARY_FILE]: 'auxiliary',
  [MAIN_VIEW_COMMANDS.SELECT_MEDIA_FILE]: 'media',
} as const;

const SET_COMMAND_BY_FILE_TYPE = {
  input: MAIN_VIEW_COMMANDS.SET_INPUT_FILE,
  reference: MAIN_VIEW_COMMANDS.SET_REFERENCE_FILE,
  auxiliary: MAIN_VIEW_COMMANDS.SET_AUXILIARY_FILE,
  media: MAIN_VIEW_COMMANDS.SET_MEDIA_FILE,
  edited: MAIN_VIEW_COMMANDS.SET_EDITED_FILE,
  base: MAIN_VIEW_COMMANDS.SET_BASE_FILE,
} as const;

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

  async function requestAllSingleFiles() {
    const [inputFiles, referenceFiles, auxiliaryFiles, mediaFiles] =
      await Promise.all([
        list('input'),
        list('reference'),
        list('auxiliary'),
        list('media'),
      ]);
    options.postToRenderer({
      command: MAIN_VIEW_COMMANDS.SET_ALL_SINGLE_FILES,
      inputFiles,
      referenceFiles,
      auxiliaryFiles,
      mediaFiles,
    });
  }

  async function selectSingleFile(
    command: keyof typeof TYPE_BY_SELECT_COMMAND,
  ) {
    const workspacePath = getWorkspacePath();
    if (!workspacePath || !options.showOpenFileDialog) return;
    const fileType = TYPE_BY_SELECT_COMMAND[command];
    const selected = await options.showOpenFileDialog({
      title: `Select ${fileType} file`,
      defaultPath: workspacePath,
      filters: [
        {
          name: `${fileType} files`,
          extensions: getFilterExtensions(fileType),
        },
      ],
    });
    if (!selected) return;
    options.postToRenderer({
      command: RESPONSE_BY_SELECT_COMMAND[command],
      filePath: toWorkspaceRelative(workspacePath, selected),
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

  function handleMessage(message: DesktopCommandMessage): boolean {
    switch (message.command) {
      case MAIN_VIEW_COMMANDS.REQUEST_INPUT_FILE:
        runAsync(requestSingleFileList('input'));
        return true;
      case MAIN_VIEW_COMMANDS.REQUEST_REFERENCE_FILE:
        runAsync(requestSingleFileList('reference'));
        return true;
      case MAIN_VIEW_COMMANDS.REQUEST_AUXILIARY_FILE:
        runAsync(requestSingleFileList('auxiliary'));
        return true;
      case MAIN_VIEW_COMMANDS.REQUEST_MEDIA_FILE:
        runAsync(requestSingleFileList('media'));
        return true;
      case MAIN_VIEW_COMMANDS.REQUEST_BASE_FILE:
        runAsync(
          requestSingleFileList('base', {
            preserveBaseFile: message.preserveBaseFile === true,
          }),
        );
        return true;
      case MAIN_VIEW_COMMANDS.REFRESH_ALL_FILES:
        runAsync(requestAllSingleFiles());
        return true;
      case MAIN_VIEW_COMMANDS.SELECT_INPUT_FILE:
      case MAIN_VIEW_COMMANDS.SELECT_REFERENCE_FILE:
      case MAIN_VIEW_COMMANDS.SELECT_AUXILIARY_FILE:
      case MAIN_VIEW_COMMANDS.SELECT_MEDIA_FILE:
        runAsync(selectSingleFile(message.command));
        return true;
      case MAIN_VIEW_COMMANDS.INPUT_FILE_SELECTED:
        runAsync(
          updateEditedFiles(
            typeof message.filePath === 'string' ? message.filePath : undefined,
          ),
        );
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
