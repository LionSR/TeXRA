import * as vscode from 'vscode';

import {
  getEditedFileListConfig,
  getFileListConfig,
  loadFileListSettings,
  matchesEditedFile,
  type FileListConfig,
  type ListableFileType,
} from '@common/files/fileListingRules';
import * as logger from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files';
import { getConfig, watchConfig } from '@utils/config/configUtils';

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

  private workspacePath = WorkspaceFS.getPath();
  private settings = loadFileListSettings(getConfig);

  private constructor() {}

  public refresh(): void {
    this.workspacePath = WorkspaceFS.getPath();
    this.settings = loadFileListSettings(getConfig);
  }

  public async list(fileType: ListableFileType): Promise<string[]> {
    const config = getFileListConfig(fileType, this.settings);
    if (!config) {
      return [];
    }
    return this.listFiles(config);
  }

  public async listEditedFiles(baseFileName: string): Promise<string[]> {
    const files = await this.listFiles(getEditedFileListConfig(this.settings));
    return files.filter((file) => matchesEditedFile(file, baseFileName));
  }

  private async listFiles(config: FileListConfig): Promise<string[]> {
    if (!this.workspacePath) {
      logger.warn(CHANNEL, 'No workspace folder found');
      return [];
    }
    return getFilesRecursively(this.workspacePath, config);
  }
}

/**
 * Lazy accessor — returns the singleton without forcing construction at import time.
 * Direct use of `FileLister.getInstance()` is equivalent; this exists for convenience.
 */
export function getFileLister(): FileLister {
  return FileLister.getInstance();
}
