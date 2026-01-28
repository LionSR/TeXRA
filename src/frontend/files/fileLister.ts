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

    const loadIgnoreList = (configKey: string): string[] =>
      getConfig<string[]>(configKey, []).map((v) => v.toLowerCase());

    this.ignoredFileExtensions = loadIgnoreList(
      'texra.files.ignored.fileExtensions',
    );
    this.ignoredDirectories = loadIgnoreList('texra.files.ignored.directories');
    this.ignoredKeywords = loadIgnoreList('texra.files.ignored.keywords');
    this.ignoredInputFiles = loadIgnoreList('texra.files.ignored.inputFiles');
    this.ignoredInputDirectories = loadIgnoreList(
      'texra.files.ignored.inputDirectories',
    );
    this.ignoredAuxKeywords = loadIgnoreList(
      'texra.files.ignored.auxiliaryKeywords',
    );
    this.ignoredMediaDirs = loadIgnoreList(
      'texra.files.ignored.mediaDirectories',
    );
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
          ignoredDirs: [
            ...this.ignoredDirectories,
            ...this.ignoredInputDirectories,
          ],
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
          ignoredKeywords: [
            ...this.ignoredKeywords,
            ...this.ignoredAuxKeywords,
          ],
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
    if (!this.workspacePath) {
      logger.warn(CHANNEL, 'No workspace folder found');
      return [];
    }

    const config = this.getListConfig(fileType);
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

    const files = await getFilesRecursively(
      this.workspacePath,
      this.workspacePath,
      getIncludedExtensions('edited'),
      this.ignoredFileExtensions,
      [...this.ignoredDirectories, ...this.ignoredInputDirectories],
      this.ignoredKeywords,
      this.ignoredInputFiles,
    );

    // Extract the base name without round suffix (e.g., "paper_r2" -> "paper")
    const baseNameWithoutRound =
      baseFileName.match(/^(.*?)(?:_r\d+)?$/)?.[1] ?? baseFileName;

    return files.filter((file) => {
      const fileBase = path.basename(file, path.extname(file));
      if (fileBase === baseFileName) return false;

      // Match files that start with the base name or have round suffixes
      if (fileBase.startsWith(baseFileName)) return true;
      if (
        fileBase.startsWith(baseNameWithoutRound) &&
        /_r\d+/.test(fileBase)
      ) {
        return true;
      }
      return false;
    });
  }
}

export const fileLister = FileLister.getInstance();
