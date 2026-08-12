import * as vscode from 'vscode';

import {
  getEditedFileListConfig,
  getFileListConfig,
  loadFileListSettings,
  matchesEditedFile,
  type FileListConfig,
  type ListableFileType,
} from '@common/files/fileListingRules';
import { createLog } from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files/workspaceFS';

import { getFilesRecursively } from './listing';

const log = createLog('FileLister');

export class FileLister {
  public static initialize(context: vscode.ExtensionContext): void {
    getFileLister();
    context.subscriptions.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() =>
        getFileLister().refresh(),
      ),
    );
  }

  private workspacePath = WorkspaceFS.getPath();
  private settings = loadFileListSettings();

  public refresh(): void {
    this.workspacePath = WorkspaceFS.getPath();
    this.settings = loadFileListSettings();
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
      log.warn('No workspace folder found');
      return [];
    }
    return getFilesRecursively(this.workspacePath, config);
  }
}

let instance: FileLister | undefined;

/** Lazy accessor — the singleton is constructed on first use, not at import time. */
export function getFileLister(): FileLister {
  instance ??= new FileLister();
  return instance;
}
