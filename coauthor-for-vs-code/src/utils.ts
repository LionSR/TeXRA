import * as vscode from 'vscode';
import * as path from 'path';
import {
  getWorkspacePath,
  getRelativePath,
  ensureArray,
  getNestedConfig,
} from './utils/commonUtils';
import { log, initializeLogging } from './utils/logUtils';

const CHANNEL_NAME = 'Coauthor Utils';
initializeLogging(CHANNEL_NAME);

export async function listInputFiles(): Promise<string[]> {
  const category = 'List-Input-Files';
  const workspacePath = getWorkspacePath();
  if (!workspacePath) return [];

  const ignoredFileExtensions = getNestedConfig<string[]>(
    'files.ignored.fileExtensions',
    [],
  );
  const ignoredDirectories = getNestedConfig<string[]>(
    'files.ignored.directories',
    [],
  );
  const ignoredKeywords = getNestedConfig<string[]>(
    'files.ignored.keywords',
    [],
  );
  const ignoredInputFiles = getNestedConfig<string[]>(
    'files.ignored.inputFiles',
    [],
  );

  log(
    CHANNEL_NAME,
    category,
    `Ignored Extensions: ${JSON.stringify(ignoredFileExtensions)}`,
  );
  log(
    CHANNEL_NAME,
    category,
    `Ignored Directories: ${JSON.stringify(ignoredDirectories)}`,
  );
  log(
    CHANNEL_NAME,
    category,
    `Ignored Keywords: ${JSON.stringify(ignoredKeywords)}`,
  );
  log(
    CHANNEL_NAME,
    category,
    `Ignored Input Files: ${JSON.stringify(ignoredInputFiles)}`,
  );

  return getFilesRecursively(
    workspacePath,
    workspacePath,
    ['.txt', '.tex', '.md'],
    ignoredFileExtensions,
    ignoredDirectories,
    ignoredKeywords,
    ignoredInputFiles,
  );
}

export const listSampleFiles = listInputFiles;

export async function listAuxFiles(): Promise<string[]> {
  const workspacePath = getWorkspacePath();
  if (!workspacePath) return [];

  const ignoredExtensions = getNestedConfig<string[]>(
    'files.ignored.fileExtensions',
    [],
  );
  const ignoredKeywords = getNestedConfig<string[]>(
    'files.ignored.keywords',
    [],
  );
  const additionalIgnoredAuxKeywords = getNestedConfig<string[]>(
    'files.ignored.auxKeywords',
    [],
  );
  const ignoredDirectories = getNestedConfig<string[]>(
    'files.ignored.directories',
    [],
  );

  const safeIgnoredKeywords = ignoredKeywords || [];
  const safeAuxKeywords = additionalIgnoredAuxKeywords || [];

  const combinedIgnoredKeywords = [
    ...new Set([...safeIgnoredKeywords, ...safeAuxKeywords]),
  ];

  return getFilesInDirectory(
    workspacePath,
    ['.txt', '.tex', '.cls', '.md'],
    ignoredExtensions || [],
    ignoredDirectories || [],
    combinedIgnoredKeywords,
  );
}

export async function listFigureFiles(): Promise<string[]> {
  const workspacePath = getWorkspacePath();
  if (!workspacePath) return [];

  const includedFigureExtensions = getNestedConfig<string[]>(
    'files.included.figureExtensions',
    ['.png', '.pdf', '.jpeg', '.jpg', '.svg'],
  );
  const ignoredFigureDirectories = getNestedConfig<string[]>(
    'files.ignored.figureDirectories',
    [],
  );
  const ignoredKeywords = getNestedConfig<string[]>(
    'files.ignored.keywords',
    [],
  );

  return getFilesRecursively(
    workspacePath,
    workspacePath,
    includedFigureExtensions,
    [],
    ignoredFigureDirectories,
    ignoredKeywords,
  );
}

export async function listEditedFiles(baseFileName: string): Promise<string[]> {
  const workspacePath = getWorkspacePath();
  if (!workspacePath) return [];
  
  const ignoredExtensions = getNestedConfig<string[]>(
    'files.ignored.fileExtensions',
    [],
  );
  const ignoredKeywords = getNestedConfig<string[]>(
    'files.ignored.keywords',
    [],
  );
  const ignoredInputFiles = getNestedConfig<string[]>(
    'files.ignored.inputFiles',
    [],
  );
  const ignoredDirectories = getNestedConfig<string[]>(
    'files.ignored.directories',
    [],
  );
  const files = await getFilesRecursively(
    workspacePath,
    workspacePath,
    ['.txt', '.tex'],
    ignoredExtensions,
    [...ignoredDirectories, 'Diffs', 'PapersEx'],
    ignoredKeywords,
    ignoredInputFiles,
  );

  return files.filter((file) => {
    const fileBaseName = path.basename(file, path.extname(file));
    return (
      fileBaseName.startsWith(baseFileName) && fileBaseName !== baseFileName
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
  return files.filter((file): file is string => file !== null);
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

      if (
        (type === vscode.FileType.Directory || isSymbolicLink) &&
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
        type === vscode.FileType.File &&
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
