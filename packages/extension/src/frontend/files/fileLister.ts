import * as vscode from 'vscode';

import {
  getEditedFileListConfig,
  getFileListConfig,
  loadFileListSettings,
  matchesEditedFile,
  type FileListSettings,
  type ListableFileType,
} from '@common/files/fileListingRules';
import * as logger from '@logger/logUtils';
import { getConfig, watchConfig } from '@utils/config';
import { WorkspaceFS } from '@utils/files';

import { getFilesRecursively } from './listing';

const CHANNEL = 'FileLister';

export class FileLister {
  private static instance: FileLister | null = null;

  public static initialize(context: vscode.ExtensionContext): void {
    this.getInstance();
    watchConfig(context, 'texra.files', () => this.getInstance().refresh());
    context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() =>
        this.getInstance().refresh(),
      ),
    );
  }

  public static getInstance(): FileLister {
    if (!this.instance) {
      this.instance = new FileLister();
    }
    return this.instance;
  }

  private workspacePath: string | undefined;
  private settings: FileListSettings = loadFileListSettings(
    (_key, fallback) => fallback,
  );

  private constructor() {
    this.refresh();
  }

  public refresh(): void {
    this.workspacePath = WorkspaceFS.getPath();
    this.settings = loadFileListSettings((key, fallback) =>
      getConfig(key, fallback),
    );
  }

  public async list(fileType: ListableFileType): Promise<string[]> {
    if (!this.workspacePath) {
      logger.warn(CHANNEL, 'No workspace folder found');
      return [];
    }

    const config = getFileListConfig(fileType, this.settings);
    if (!config) {
      return [];
    }

    return getFilesRecursively(
      this.workspacePath,
      this.workspacePath,
      config.extensions,
      config.ignoredExtensions,
      config.ignoredDirs,
      config.ignoredKeywords,
      config.ignoredFiles,
    );
  }

  public async listEditedFiles(baseFileName: string): Promise<string[]> {
    if (!this.workspacePath) {
      logger.warn(CHANNEL, 'No workspace folder found');
      return [];
    }

    const config = getEditedFileListConfig(this.settings);
    const files = await getFilesRecursively(
      this.workspacePath,
      this.workspacePath,
      config.extensions,
      config.ignoredExtensions,
      config.ignoredDirs,
      config.ignoredKeywords,
      config.ignoredFiles,
    );

    return files.filter((file) => matchesEditedFile(file, baseFileName));
  }
}

/**
 * Lazy accessor — returns the singleton without forcing construction at import time.
 * Direct use of `FileLister.getInstance()` is equivalent; this exists for convenience.
 */
export function getFileLister(): FileLister {
  return FileLister.getInstance();
}
