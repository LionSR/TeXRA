// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '@logger/logUtils';

// Local imports - utilities
import { getConfig, watchConfig } from '@utils/config';
import { WorkspaceFS } from '@utils/files';
import { getIncludedExtensions, FileType } from '@common/files/fileTypeUtils';
import { getFilesInDirectory, getFilesRecursively } from './listing';

const CHANNEL = 'FileLister';
logger.initialize(CHANNEL);

export type ListableFileType = Exclude<FileType, 'audio'>;

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
  private ignoredAuxKeywords: string[] = [];
  private ignoredMediaDirs: string[] = [];

  private constructor() {
    this.refresh();
  }

  public refresh(): void {
    this.workspacePath = WorkspaceFS.getPath();
    this.ignoredFileExtensions = getConfig<string[]>(
      'files.ignored.fileExtensions',
      [],
    ).map((e) => e.toLowerCase());
    this.ignoredDirectories = getConfig<string[]>(
      'files.ignored.directories',
      [],
    ).map((d) => d.toLowerCase());
    this.ignoredKeywords = getConfig<string[]>(
      'files.ignored.keywords',
      [],
    ).map((k) => k.toLowerCase());
    this.ignoredInputFiles = getConfig<string[]>(
      'files.ignored.inputFiles',
      [],
    ).map((f) => f.toLowerCase());
    this.ignoredAuxKeywords = getConfig<string[]>(
      'files.ignored.auxiliaryKeywords',
      [],
    ).map((k) => k.toLowerCase());
    this.ignoredMediaDirs = getConfig<string[]>(
      'files.ignored.mediaDirectories',
      [],
    ).map((d) => d.toLowerCase());
  }

  private get workspace(): string | null {
    return this.workspacePath ?? null;
  }

  public async list(fileType: ListableFileType): Promise<string[]> {
    const workspace = this.workspace;
    if (!workspace) {
      logger.warn(CHANNEL, 'No workspace folder found');
      return [];
    }

    switch (fileType) {
      case 'input':
      case 'reference':
        return getFilesRecursively(
          workspace,
          workspace,
          getIncludedExtensions(fileType),
          this.ignoredFileExtensions,
          this.ignoredDirectories,
          this.ignoredKeywords,
          this.ignoredInputFiles,
        );
      case 'auxiliary':
        return getFilesInDirectory(
          workspace,
          getIncludedExtensions('auxiliary'),
          this.ignoredFileExtensions,
          this.ignoredDirectories,
          [...this.ignoredKeywords, ...this.ignoredAuxKeywords],
        );
      case 'media':
        return getFilesRecursively(
          workspace,
          workspace,
          getIncludedExtensions('media'),
          [],
          this.ignoredMediaDirs,
          this.ignoredKeywords,
        );
      case 'edited':
        // Handled separately
        return [];
    }
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
      [...this.ignoredDirectories, 'PapersEx'],
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
