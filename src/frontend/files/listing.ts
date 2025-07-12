// Standard library imports
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - utilities
import { AbsoluteFS } from '@utils/files';

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
      const isSymbolicLink = await AbsoluteFS.isSymbolicLink(fullPath);

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

      const isSymbolicLink = await AbsoluteFS.isSymbolicLink(fullPath);
      const isDirectory = await AbsoluteFS.isDir(fullPath);
      const isFile = await AbsoluteFS.isFile(fullPath);

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
