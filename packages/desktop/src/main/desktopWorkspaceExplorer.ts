import { basename, isAbsolute, relative, resolve } from 'node:path';

import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { tryPlatform } from '@platform/platform';
import { getWorkspaceProvider } from '@agent/core/workspace';
import {
  getFileListConfig,
  loadFileListSettings,
  type ListableFileType,
} from '@common/files/fileListingRules';
import {
  buildWorkspaceTree,
  listWorkspaceFiles,
  type WorkspaceTreeNode,
} from '@common/files/workspaceFileListing';
import { MAIN_VIEW_COMMANDS } from '@common/webview/mainViewCommands';
import { normalizeFilePath } from '@shared/utils/path';
import { getConfig } from '@utils/config/configUtils';

import {
  DESKTOP_WORKSPACE_EXPLORER_COMMANDS,
  DesktopWorkspaceOpenFileMessageSchema,
  DesktopWorkspaceSelectFileMessageSchema,
  type DesktopWorkspaceFileCategory,
} from '../desktopWorkspaceExplorerMessages.js';
import type {
  DesktopCommandMessage,
  DesktopMessageHandler,
} from './desktopIpcTypes.js';

export interface DesktopWorkspaceExplorerOptions {
  postToRenderer(message: unknown): void;
  getWorkspacePath?: () => string | undefined;
  openPath?: (filePath: string) => Promise<void>;
  onError?: (error: unknown) => void;
}

export type DesktopWorkspaceExplorer = DesktopMessageHandler;

const SELECTED_COMMAND_BY_FILE_TYPE = {
  input: MAIN_VIEW_COMMANDS.INPUT_FILE_SELECTED,
  reference: MAIN_VIEW_COMMANDS.REFERENCE_FILE_SELECTED,
  auxiliary: MAIN_VIEW_COMMANDS.AUXILIARY_FILE_SELECTED,
  media: MAIN_VIEW_COMMANDS.MEDIA_FILE_SELECTED,
} as const satisfies Record<DesktopWorkspaceFileCategory, string>;

function getListSettings() {
  return loadFileListSettings(getConfig);
}

function readDirectory(directory: string) {
  return (tryPlatform()?.fs ?? nodeFilesystem).readDirectory(directory);
}

function resolveWorkspaceFile(workspacePath: string, filePath: string): string {
  return isAbsolute(filePath) ? filePath : resolve(workspacePath, filePath);
}

function toWorkspaceRelative(workspacePath: string, filePath: string): string {
  const absolutePath = resolveWorkspaceFile(workspacePath, filePath);
  const relativePath = relative(workspacePath, absolutePath);
  if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
    throw new Error(
      'Workspace explorer file paths must stay in the workspace.',
    );
  }
  return normalizeFilePath(relativePath);
}

async function listForConfig(
  workspacePath: string,
  fileType: ListableFileType,
): Promise<string[]> {
  const config = getFileListConfig(fileType, getListSettings());
  if (!config) return [];
  return listWorkspaceFiles({
    root: workspacePath,
    config,
    readDirectory,
  });
}

function addCategories(
  categoriesByFile: Map<string, DesktopWorkspaceFileCategory[]>,
  fileType: DesktopWorkspaceFileCategory,
  files: readonly string[],
): void {
  for (const file of files) {
    const categories = categoriesByFile.get(file) ?? [];
    if (!categories.includes(fileType)) {
      categories.push(fileType);
    }
    categoriesByFile.set(file, categories);
  }
}

async function loadWorkspaceTree(
  workspacePath: string,
): Promise<{ files: string[]; tree: WorkspaceTreeNode[] }> {
  const [inputFiles, referenceFiles, auxiliaryFiles, mediaFiles] =
    await Promise.all([
      listForConfig(workspacePath, 'input'),
      listForConfig(workspacePath, 'reference'),
      listForConfig(workspacePath, 'auxiliary'),
      listForConfig(workspacePath, 'media'),
    ]);
  const files = [
    ...new Set([
      ...inputFiles,
      ...referenceFiles,
      ...auxiliaryFiles,
      ...mediaFiles,
    ]),
  ].sort((left, right) => left.localeCompare(right));
  const categoriesByFile = new Map<string, DesktopWorkspaceFileCategory[]>();
  addCategories(categoriesByFile, 'input', inputFiles);
  addCategories(categoriesByFile, 'reference', referenceFiles);
  addCategories(categoriesByFile, 'auxiliary', auxiliaryFiles);
  addCategories(categoriesByFile, 'media', mediaFiles);
  return { files, tree: buildWorkspaceTree(files, categoriesByFile) };
}

export function createDesktopWorkspaceExplorer(
  options: DesktopWorkspaceExplorerOptions,
): DesktopWorkspaceExplorer {
  const getWorkspacePath =
    options.getWorkspacePath ??
    (() => getWorkspaceProvider().getWorkspacePath());
  const onError =
    options.onError ??
    ((error) => {
      console.error(error);
    });

  function runAsync(work: Promise<void>): void {
    void work.catch(onError);
  }

  async function requestTree(): Promise<void> {
    const workspacePath = getWorkspacePath();
    if (!workspacePath) {
      options.postToRenderer({
        command: DESKTOP_WORKSPACE_EXPLORER_COMMANDS.SET_TREE,
        workspaceName: undefined,
        files: [],
        tree: [],
      });
      return;
    }
    const { files, tree } = await loadWorkspaceTree(workspacePath);
    options.postToRenderer({
      command: DESKTOP_WORKSPACE_EXPLORER_COMMANDS.SET_TREE,
      workspaceName: basename(workspacePath),
      files,
      tree,
    });
  }

  async function openFile(message: DesktopCommandMessage): Promise<void> {
    const parsed = DesktopWorkspaceOpenFileMessageSchema.parse(message);
    const workspacePath = getWorkspacePath();
    if (!workspacePath || !options.openPath) return;
    const relativePath = toWorkspaceRelative(workspacePath, parsed.filePath);
    await options.openPath(resolve(workspacePath, relativePath));
  }

  async function selectFile(message: DesktopCommandMessage): Promise<void> {
    const parsed = DesktopWorkspaceSelectFileMessageSchema.parse(message);
    const workspacePath = getWorkspacePath();
    if (!workspacePath) return;
    const relativePath = toWorkspaceRelative(workspacePath, parsed.filePath);
    options.postToRenderer({
      command: SELECTED_COMMAND_BY_FILE_TYPE[parsed.fileType],
      filePath: relativePath,
    });
  }

  return {
    handleMessage(message: DesktopCommandMessage): boolean {
      switch (message.command) {
        case DESKTOP_WORKSPACE_EXPLORER_COMMANDS.REQUEST_TREE:
          runAsync(requestTree());
          return true;
        case DESKTOP_WORKSPACE_EXPLORER_COMMANDS.OPEN_FILE:
          runAsync(openFile(message));
          return true;
        case DESKTOP_WORKSPACE_EXPLORER_COMMANDS.SELECT_FILE:
          runAsync(selectFile(message));
          return true;
        default:
          return false;
      }
    },
  };
}
