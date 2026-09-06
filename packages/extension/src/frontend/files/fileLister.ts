import * as vscode from 'vscode';

import {
  getFileListConfig,
  loadFileListSettings,
  type FileFilterConfig,
  type ListableFileType,
} from '@common/files/fileListingRules';
import { createLog } from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files/workspaceFS';

import { getFilesRecursively } from './listing';

const log = createLog('FileLister');

export class FileLister {
  public static initialize(context: vscode.ExtensionContext): void {
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

  public list(fileType: ListableFileType): Promise<string[]> {
    return this.listFiles(getFileListConfig(fileType, this.settings));
  }

  private async listFiles(config: FileFilterConfig): Promise<string[]> {
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
