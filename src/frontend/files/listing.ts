// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - utilities
import { AbsoluteFS } from '@utils/files';

export function getFilesIfNotEmpty<T>(files: T[] | undefined): T[] | null {
  return files && files.length > 0 ? files : null;
}

export async function getFilesInDirectory(
  dir: string,
  includeExtensions: string[] = [],
  excludeExtensions: string[] = [],
  excludeDirectories: string[] = [],
  excludeKeywords: string[] = [],
): Promise<string[]> {
  const dirEntries = await AbsoluteFS.readDir(dir);
  const files = await Promise.all(
    dirEntries.map(async ([name, type]) => {
      const fullPath = path.join(dir, name);
      const stat = await AbsoluteFS.stat(fullPath);
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
  return files.filter(
    (file): file is string => file !== null && file !== undefined,
  );
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
  const dirEntries = await AbsoluteFS.readDir(dir);

  const normalizedExcludeDirs = new Set(excludeDirectories);

  const files = await Promise.all(
    dirEntries.map(async ([name, type]) => {
      const fullPath = path.join(dir, name);
      const relativePath = path.relative(root, fullPath);

      const pathParts = relativePath.split(path.sep);
      if (pathParts.some((part) => normalizedExcludeDirs.has(part))) {
        return [];
      }

      const stat = await AbsoluteFS.stat(fullPath);
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
        !normalizedExcludeDirs.has(name)
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
          includeExtensions.some((ext) => name.endsWith(ext))) &&
        !excludeExtensions.some((ext) => name.endsWith(ext)) &&
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
