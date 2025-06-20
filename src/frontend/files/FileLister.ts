// Standard library imports
import * as path from 'path';

// Local imports - utilities
import { getConfig } from '@utils/config';
import { WorkspaceFileManager } from '@utils/files';
import { getIncludedExtensions } from '@utils/fileTypeUtils';

// Local imports - generic file operations
import { getFilesInDirectory, getFilesRecursively } from './listing';

export type FileCategory = 'input' | 'reference' | 'auxiliary' | 'media';

interface FileListerConfig {
  ignoredFileExtensions: string[];
  ignoredDirectories: string[];
  ignoredKeywords: string[];
  ignoredInputFiles: string[];
  ignoredAuxiliaryKeywords: string[];
  ignoredMediaDirectories: string[];
}

export class FileLister {
  private static config: FileListerConfig = FileLister.loadConfig();

  private static loadConfig(): FileListerConfig {
    return {
      ignoredFileExtensions: getConfig<string[]>(
        'files.ignored.fileExtensions',
      ),
      ignoredDirectories: getConfig<string[]>('files.ignored.directories'),
      ignoredKeywords: getConfig<string[]>('files.ignored.keywords'),
      ignoredInputFiles: getConfig<string[]>('files.ignored.inputFiles'),
      ignoredAuxiliaryKeywords: getConfig<string[]>(
        'files.ignored.auxiliaryKeywords',
      ),
      ignoredMediaDirectories: getConfig<string[]>(
        'files.ignored.mediaDirectories',
      ),
    };
  }

  public static refreshConfig(): void {
    this.config = this.loadConfig();
  }

  private static get workspacePath(): string | undefined {
    return WorkspaceFileManager.getWorkspacePath();
  }

  public static async list(category: FileCategory): Promise<string[]> {
    const workspacePath = this.workspacePath;
    if (!workspacePath) {
      return [];
    }

    switch (category) {
      case 'input':
      case 'reference': {
        const extensions = getIncludedExtensions('input');
        return getFilesRecursively(
          workspacePath,
          workspacePath,
          extensions,
          this.config.ignoredFileExtensions,
          this.config.ignoredDirectories,
          this.config.ignoredKeywords,
          this.config.ignoredInputFiles,
        );
      }
      case 'auxiliary': {
        const extensions = getIncludedExtensions('auxiliary');
        return getFilesInDirectory(
          workspacePath,
          extensions,
          this.config.ignoredFileExtensions,
          this.config.ignoredDirectories,
          [
            ...this.config.ignoredKeywords,
            ...this.config.ignoredAuxiliaryKeywords,
          ],
        );
      }
      case 'media': {
        const extensions = getIncludedExtensions('media');
        return getFilesRecursively(
          workspacePath,
          workspacePath,
          extensions,
          [],
          this.config.ignoredMediaDirectories,
          this.config.ignoredKeywords,
        );
      }
      default:
        return [];
    }
  }

  public static async listEditedFiles(baseFileName: string): Promise<string[]> {
    const workspacePath = this.workspacePath;
    if (!workspacePath) {
      return [];
    }
    const extensions = getIncludedExtensions('edited');
    const files = await getFilesRecursively(
      workspacePath,
      workspacePath,
      extensions,
      this.config.ignoredFileExtensions,
      [...this.config.ignoredDirectories, 'PapersEx'],
      this.config.ignoredKeywords,
      this.config.ignoredInputFiles,
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

  // Convenience wrappers
  public static listInputFiles = () => this.list('input');
  public static listReferenceFiles = () => this.list('reference');
  public static listAuxiliaryFiles = () => this.list('auxiliary');
  public static listMediaFiles = () => this.list('media');
}

export async function listInputFiles(): Promise<string[]> {
  return FileLister.listInputFiles();
}

export async function listReferenceFiles(): Promise<string[]> {
  return FileLister.listReferenceFiles();
}

export async function listAuxiliaryFiles(): Promise<string[]> {
  return FileLister.listAuxiliaryFiles();
}

export async function listMediaFiles(): Promise<string[]> {
  return FileLister.listMediaFiles();
}

export async function listEditedFiles(baseFileName: string): Promise<string[]> {
  return FileLister.listEditedFiles(baseFileName);
}
