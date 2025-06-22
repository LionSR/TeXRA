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

  const normalizedIncludeExt = includeExtensions.map((e) => e.toLowerCase());
  const normalizedExcludeExt = excludeExtensions.map((e) => e.toLowerCase());
  const normalizedExcludeKeywords = excludeKeywords.map((k) => k.toLowerCase());
  const normalizedExcludeDirs = new Set(
    excludeDirectories.map((d) => d.toLowerCase()),
  );

  const files = await Promise.all(
    dirEntries.map(async ([name, type]) => {
      const nameLower = name.toLowerCase();
      const fullPath = path.join(dir, name);
      const stat = await AbsoluteFS.stat(fullPath);
      const isSymbolicLink =
        (stat.type & vscode.FileType.SymbolicLink) ===
        vscode.FileType.SymbolicLink;

      if (
        (type === vscode.FileType.File || isSymbolicLink) &&
        !name.startsWith('.') &&
        (normalizedIncludeExt.length === 0 ||
          normalizedIncludeExt.some((ext) => nameLower.endsWith(ext))) &&
        !normalizedExcludeExt.some((ext) => nameLower.endsWith(ext)) &&
        !normalizedExcludeKeywords.some((keyword) =>
          nameLower.includes(keyword),
        ) &&
        !normalizedExcludeDirs.has(path.dirname(name).toLowerCase())
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
  const normalizedIncludeExt = includeExtensions.map((e) => e.toLowerCase());
  const normalizedExcludeExt = excludeExtensions.map((e) => e.toLowerCase());
  const normalizedExcludeDirs = new Set(
    excludeDirectories.map((d) => d.toLowerCase()),
  );
  const normalizedExcludeKeywords = excludeKeywords.map((k) => k.toLowerCase());
  const normalizedExcludeFiles = excludeFiles.map((f) => f.toLowerCase());

  const files = await Promise.all(
    dirEntries.map(async ([name, type]) => {
      const nameLower = name.toLowerCase();
      const fullPath = path.join(dir, name);
      const relativePath = path.relative(root, fullPath);

      const pathParts = relativePath.split(path.sep);
      if (
        pathParts.some((part) => normalizedExcludeDirs.has(part.toLowerCase()))
      ) {
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
        !normalizedExcludeDirs.has(nameLower)
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
        (normalizedIncludeExt.length === 0 ||
          normalizedIncludeExt.some((ext) => nameLower.endsWith(ext))) &&
        !normalizedExcludeExt.some((ext) => nameLower.endsWith(ext)) &&
        !normalizedExcludeKeywords.some((keyword) =>
          nameLower.includes(keyword),
        ) &&
        !normalizedExcludeFiles.includes(nameLower)
      ) {
        return [relativePath];
      }
      return [];
    }),
  );
  return files.flat();
}
