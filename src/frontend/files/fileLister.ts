// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - utilities
import { getWorkspacePath } from '@utils/files';
import { getConfig } from '@utils/config';
import { getIncludedExtensions, FileType } from '@utils/fileTypeUtils';

import { getFilesInDirectory, getFilesRecursively } from './listing';

/**
 * Service for listing workspace files with cached configuration.
 */
export class FileLister {
  private workspacePath: string | undefined;
  private ignoredExtensions: string[] = [];
  private ignoredDirectories: string[] = [];
  private ignoredKeywords: string[] = [];
  private ignoredInputFiles: string[] = [];

  constructor() {
    this.refresh();
  }

  /** Refresh workspace path and configuration values. */
  refresh() {
    this.workspacePath = getWorkspacePath();
    this.ignoredExtensions = getConfig<string[]>(
      'files.ignored.fileExtensions',
      [],
    );
    this.ignoredDirectories = getConfig<string[]>(
      'files.ignored.directories',
      [],
    );
    this.ignoredKeywords = getConfig<string[]>('files.ignored.keywords', []);
    this.ignoredInputFiles = getConfig<string[]>(
      'files.ignored.inputFiles',
      [],
    );
  }

  /** List files of the given type using cached configuration. */
  async list(
    type: Extract<FileType, 'input' | 'reference' | 'auxiliary' | 'media'>,
  ): Promise<string[]> {
    if (!this.workspacePath) {
      return [];
    }

    const include = getIncludedExtensions(type);

    switch (type) {
      case 'auxiliary': {
        const extraKeywords = getConfig<string[]>(
          'files.ignored.auxiliaryKeywords',
          [],
        );
        return getFilesInDirectory(
          this.workspacePath,
          include,
          this.ignoredExtensions,
          this.ignoredDirectories,
          [...this.ignoredKeywords, ...extraKeywords],
        );
      }
      case 'media': {
        const mediaDirs = getConfig<string[]>(
          'files.ignored.mediaDirectories',
          [],
        );
        return getFilesRecursively(
          this.workspacePath,
          this.workspacePath,
          include,
          [],
          mediaDirs,
          this.ignoredKeywords,
        );
      }
      default: {
        // input and reference share the same logic
        return getFilesRecursively(
          this.workspacePath,
          this.workspacePath,
          include,
          this.ignoredExtensions,
          this.ignoredDirectories,
          this.ignoredKeywords,
          this.ignoredInputFiles,
        );
      }
    }
  }

  /**
   * List edited files related to the provided base file name.
   */
  async listEditedFiles(baseFileName: string): Promise<string[]> {
    if (!this.workspacePath) {
      return [];
    }

    const files = await getFilesRecursively(
      this.workspacePath,
      this.workspacePath,
      getIncludedExtensions('edited'),
      this.ignoredExtensions,
      [...this.ignoredDirectories, 'PapersEx'],
      this.ignoredKeywords,
      this.ignoredInputFiles,
    );

    const baseNameMatch = baseFileName.match(/^(.*?)(?:_r\d+|$)/);
    const baseNameBeforeRound = baseNameMatch ? baseNameMatch[1] : baseFileName;

    return files.filter((file) => {
      const fileBaseName = path.basename(file, path.extname(file));
      return (
        (fileBaseName.startsWith(baseFileName) &&
          fileBaseName !== baseFileName) ||
        (fileBaseName.startsWith(baseNameBeforeRound) &&
          fileBaseName.match(/_r\d+/) &&
          fileBaseName !== baseFileName)
      );
    });
  }
}

export const fileLister = new FileLister();

export const listInputFiles = () => fileLister.list('input');
export const listReferenceFiles = () => fileLister.list('reference');
export const listAuxiliaryFiles = () => fileLister.list('auxiliary');
export const listMediaFiles = () => fileLister.list('media');
export const listEditedFiles = (base: string) =>
  fileLister.listEditedFiles(base);
