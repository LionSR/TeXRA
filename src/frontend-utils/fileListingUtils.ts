// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - log
import * as logger from '../logger/logUtils';

// Local imports - utilities
import { getConfig } from '../utils/configUtils';
import { getWorkspacePath } from '../utils/workspaceFileUtils';

const CHANNEL = 'FrontendUtils';
logger.initialize(CHANNEL);

const IGNORED_FILE_EXTENSIONS = getConfig<string[]>(
  'files.ignored.fileExtensions',
);
const IGNORED_DIRECTORIES = getConfig<string[]>('files.ignored.directories');
const IGNORED_KEYWORDS = getConfig<string[]>('files.ignored.keywords');

export function getFilesIfNotEmpty<T>(files: T[] | undefined): T[] | null {
  return files && files.length > 0 ? files : null;
}

export async function listInputFiles(): Promise<string[]> {
  const workspacePath = getWorkspacePath();
  if (!workspacePath) {
    return [];
  }

  const INCLUDED_INPUT_EXTENSIONS = getConfig<string[]>(
    'files.included.inputExtensions',
  );

  return getFilesRecursively(
    workspacePath,
    workspacePath,
    INCLUDED_INPUT_EXTENSIONS,
    IGNORED_FILE_EXTENSIONS,
    IGNORED_DIRECTORIES,
    IGNORED_KEYWORDS,
    getConfig<string[]>('files.ignored.inputFiles'),
  );
}

export const listReferenceFiles = listInputFiles;

export async function listAuxiliaryFiles(): Promise<string[]> {
  const workspacePath = getWorkspacePath();
  if (!workspacePath) {
    return [];
  }

  const IGNORED_AUXILIARY_KEYWORDS = getConfig<string[]>(
    'files.ignored.auxiliaryKeywords',
  );

  const INCLUDED_AUXILIARY_EXTENSIONS = getConfig<string[]>(
    'files.included.auxiliaryExtensions',
  );

  return getFilesInDirectory(
    workspacePath,
    INCLUDED_AUXILIARY_EXTENSIONS,
    IGNORED_FILE_EXTENSIONS,
    IGNORED_DIRECTORIES,
    [...IGNORED_KEYWORDS, ...IGNORED_AUXILIARY_KEYWORDS],
  );
}

export async function listMediaFiles(): Promise<string[]> {
  const workspacePath = getWorkspacePath();
  if (!workspacePath) {
    return [];
  }

  const IGNORED_FIGURE_DIRECTORIES = getConfig<string[]>(
    'files.ignored.mediaDirectories',
  );

  const INCLUDED_FIGURE_EXTENSIONS = getConfig<string[]>(
    'files.included.mediaExtensions',
  );

  return getFilesRecursively(
    workspacePath,
    workspacePath,
    INCLUDED_FIGURE_EXTENSIONS,
    [],
    IGNORED_FIGURE_DIRECTORIES,
    IGNORED_KEYWORDS,
  );
}

export async function listEditedFiles(baseFileName: string): Promise<string[]> {
  const workspacePath = getWorkspacePath();
  if (!workspacePath) {
    return [];
  }

  const INCLUDED_EDITED_EXTENSIONS = getConfig<string[]>(
    'files.included.editedExtensions',
  );

  const files = await getFilesRecursively(
    workspacePath,
    workspacePath,
    INCLUDED_EDITED_EXTENSIONS,
    IGNORED_FILE_EXTENSIONS,
    [...IGNORED_DIRECTORIES, 'PapersEx'],
    IGNORED_KEYWORDS,
    getConfig<string[]>('files.ignored.inputFiles'),
  );

  // Extract the base name before any round number
  const baseNameMatch = baseFileName.match(/^(.*?)(?:_r\d+|$)/);
  const baseNameBeforeRound = baseNameMatch ? baseNameMatch[1] : baseFileName;

  return files.filter((file) => {
    const fileBaseName = path.basename(file, path.extname(file));
    // Check if it starts with the same base name and or has a different round number
    return (
      (fileBaseName.startsWith(baseFileName) &&
        fileBaseName !== baseFileName) ||
      (fileBaseName.startsWith(baseNameBeforeRound) &&
        fileBaseName.match(/_r\d+/) &&
        fileBaseName !== baseFileName)
    );
  });
}

export async function getFilesInDirectory(
  dir: string,
  includeExtensions: string[] = [],
  excludeExtensions: string[] = [],
  excludeDirectories: string[] = [],
  excludeKeywords: string[] = [],
): Promise<string[]> {
  const dirEntries = await vscode.workspace.fs.readDirectory(
    vscode.Uri.file(dir),
  );
  const files = await Promise.all(
    dirEntries.map(async ([name, type]) => {
      const fullPath = path.join(dir, name);
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(fullPath));
      const isSymbolicLink =
        (stat.type & vscode.FileType.SymbolicLink) ===
        vscode.FileType.SymbolicLink;

      if (
        (type === vscode.FileType.File || isSymbolicLink) &&
        !name.startsWith('.') &&
        (includeExtensions.length === 0 ||
          includeExtensions.some((ext) => name.endsWith(ext))) &&
        !excludeExtensions.some((ext) => name.endsWith(ext)) &&
        !excludeKeywords.some((keyword) => name.includes(keyword)) &&
        !excludeDirectories.includes(path.dirname(name))
      ) {
        return name;
      }
      return null;
    }),
  );
  return files.filter((file): file is string => file != null);
}

export async function getFilesRecursively(
  dir: string,
  root: string,
  includeExtensions: string[] = [],
  excludeExtensions: string[] = [],
  excludeDirectories: string[] = [],
  excludeKeywords: string[] = [],
  excludeFiles: string[] = [],
): Promise<string[]> {
  const dirEntries = await vscode.workspace.fs.readDirectory(
    vscode.Uri.file(dir),
  );

  // Convert all directory names to lowercase for case-insensitive comparison
  const normalizedExcludeDirs = new Set(
    excludeDirectories.map((d) => d.toLowerCase()),
  );

  const files = await Promise.all(
    dirEntries.map(async ([name, type]) => {
      const fullPath = path.join(dir, name);
      const relativePath = path.relative(root, fullPath);

      // Check if any parent directory should be excluded
      const pathParts = relativePath.split(path.sep);
      if (
        pathParts.some((part) => normalizedExcludeDirs.has(part.toLowerCase()))
      ) {
        return [];
      }

      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(fullPath));
      const isSymbolicLink =
        (stat.type & vscode.FileType.SymbolicLink) ===
        vscode.FileType.SymbolicLink;
      const isDirectory =
        (stat.type & vscode.FileType.Directory) === vscode.FileType.Directory;
      const isFile =
        (stat.type & vscode.FileType.File) === vscode.FileType.File;

      if (
        (type === vscode.FileType.Directory ||
          (isSymbolicLink && isDirectory)) &&
        !name.startsWith('.') &&
        !normalizedExcludeDirs.has(name.toLowerCase())
      ) {
        return await getFilesRecursively(
          fullPath,
          root,
          includeExtensions,
          excludeExtensions,
          excludeDirectories,
          excludeKeywords,
          excludeFiles,
        );
      } else if (
        (type === vscode.FileType.File || (isSymbolicLink && isFile)) &&
        !name.startsWith('.') &&
        (includeExtensions.length === 0 ||
          includeExtensions.some((ext) =>
            name.toLowerCase().endsWith(ext.toLowerCase()),
          )) &&
        !excludeExtensions.some((ext) =>
          name.toLowerCase().endsWith(ext.toLowerCase()),
        ) &&
        !excludeKeywords.some((keyword) => name.includes(keyword)) &&
        !excludeFiles.includes(name)
      ) {
        return [relativePath];
      }
      return [];
    }),
  );
  return files.flat();
}
