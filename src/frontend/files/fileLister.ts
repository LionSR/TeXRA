// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import {
  getIncludedExtensions,
  ExtensionCategory,
} from '@common/files/fileTypeUtils';
import * as logger from '@logger/logUtils';
import { getConfig, watchConfig } from '@utils/config';
import { WorkspaceFS } from '@utils/files';

// Local file imports
import { getFilesRecursively } from './listing';

const CHANNEL = 'FileLister';
logger.initialize(CHANNEL);

export type ListableFileType = Exclude<ExtensionCategory, 'audio'>;

export class FileLister {
  private static instance: FileLister | null = null;

  public static initialize(context: vscode.ExtensionContext): void {
    this.getInstance();
    watchConfig(context, 'texra.files', () => this.getInstance().refresh());
    vscode.workspace.onDidChangeWorkspaceFolders(() =>
      this.getInstance().refresh(),
    );
  }

  public static getInstance(): FileLister {
    if (!this.instance) {
      this.instance = new FileLister();
    }
    return this.instance;
  }

  private workspacePath: string | undefined;
  private ignoredFileExtensions: string[] = [];
  private ignoredDirectories: string[] = [];
  private ignoredKeywords: string[] = [];
  private ignoredInputFiles: string[] = [];
  private ignoredInputDirectories: string[] = [];
  private ignoredAuxKeywords: string[] = [];
  private ignoredMediaDirs: string[] = [];

  private constructor() {
    this.refresh();
  }

  public refresh(): void {
    this.workspacePath = WorkspaceFS.getPath();
    type IgnoreListKey =
      | 'ignoredFileExtensions'
      | 'ignoredDirectories'
      | 'ignoredKeywords'
      | 'ignoredInputFiles'
      | 'ignoredInputDirectories'
      | 'ignoredAuxKeywords'
      | 'ignoredMediaDirs';

    const mappings: Array<{ key: string; target: IgnoreListKey }> = [
      {
        key: 'texra.files.ignored.fileExtensions',
        target: 'ignoredFileExtensions',
      },
      { key: 'texra.files.ignored.directories', target: 'ignoredDirectories' },
      { key: 'texra.files.ignored.keywords', target: 'ignoredKeywords' },
      { key: 'texra.files.ignored.inputFiles', target: 'ignoredInputFiles' },
      {
        key: 'texra.files.ignored.inputDirectories',
        target: 'ignoredInputDirectories',
      },
      {
        key: 'texra.files.ignored.auxiliaryKeywords',
        target: 'ignoredAuxKeywords',
      },
      {
        key: 'texra.files.ignored.mediaDirectories',
        target: 'ignoredMediaDirs',
      },
    ];

    for (const { key, target } of mappings) {
      this[target] = getConfig<string[]>(key, []).map((value) =>
        value.toLowerCase(),
      );
    }
  }

  private get workspace(): string | null {
    return this.workspacePath ?? null;
  }

  /** Get file listing config for each file type */
  private getListConfig(fileType: ListableFileType): {
    extensions: string[];
    ignoredExtensions: string[];
    ignoredDirs: string[];
    ignoredKeywords: string[];
    ignoredFiles?: string[];
  } | null {
    switch (fileType) {
      case 'input':
        return {
          extensions: getIncludedExtensions(fileType),
          ignoredExtensions: this.ignoredFileExtensions,
          ignoredDirs: [...this.ignoredDirectories, ...this.ignoredInputDirectories],
          ignoredKeywords: this.ignoredKeywords,
          ignoredFiles: this.ignoredInputFiles,
        };
      case 'reference':
        return {
          extensions: getIncludedExtensions(fileType),
          ignoredExtensions: this.ignoredFileExtensions,
          ignoredDirs: this.ignoredDirectories,
          ignoredKeywords: this.ignoredKeywords,
          ignoredFiles: this.ignoredInputFiles,
        };
      case 'auxiliary':
        return {
          extensions: getIncludedExtensions('auxiliary'),
          ignoredExtensions: this.ignoredFileExtensions,
          ignoredDirs: this.ignoredDirectories,
          ignoredKeywords: [...this.ignoredKeywords, ...this.ignoredAuxKeywords],
        };
      case 'media':
        return {
          extensions: getIncludedExtensions('media'),
          ignoredExtensions: [],
          ignoredDirs: this.ignoredMediaDirs,
          ignoredKeywords: this.ignoredKeywords,
        };
      case 'edited':
        return null; // Handled separately by listEditedFiles
    }
  }

  public async list(fileType: ListableFileType): Promise<string[]> {
    const workspace = this.workspace;
    if (!workspace) {
      logger.warn(CHANNEL, 'No workspace folder found');
      return [];
    }

    const config = this.getListConfig(fileType);
    if (!config) {
      return [];
    }

    return getFilesRecursively(
      workspace,
      workspace,
      config.extensions,
      config.ignoredExtensions,
      config.ignoredDirs,
      config.ignoredKeywords,
      config.ignoredFiles,
    );
  }

  public async listEditedFiles(baseFileName: string): Promise<string[]> {
    const workspace = this.workspace;
    if (!workspace) {
      logger.warn(CHANNEL, 'No workspace folder found');
      return [];
    }

    const files = await getFilesRecursively(
      workspace,
      workspace,
      getIncludedExtensions('edited'),
      this.ignoredFileExtensions,
      [...this.ignoredDirectories, ...this.ignoredInputDirectories],
      this.ignoredKeywords,
      this.ignoredInputFiles,
    );

    const baseNameMatch = baseFileName.match(/^(.*?)(?:_r\d+|$)/);
    const baseNameBeforeRound = baseNameMatch ? baseNameMatch[1] : baseFileName;

    return files.filter((file) => {
      const fileBase = path.basename(file, path.extname(file));
      return (
        (fileBase.startsWith(baseFileName) && fileBase !== baseFileName) ||
        (fileBase.startsWith(baseNameBeforeRound) &&
          /_r\d+/.test(fileBase) &&
          fileBase !== baseFileName)
      );
    });
  }
}

export const fileLister = FileLister.getInstance();
