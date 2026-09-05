import { getBasename, normalizeFilePath } from '@utils/core';

import { FILE_HANDLING_RULES } from './fileHandlingRules';
import { getIncludedExtensions, type ExtensionCategory } from './fileTypeUtils';

// Edited files have their own entry point (getEditedFileListConfig), so they
// are not listable through getFileListConfig. The surviving vocabulary matches
// DocumentFileTypeSchema ('input' | 'context' | 'media').
export type ListableFileType = Exclude<ExtensionCategory, 'audio' | 'edited'>;

export interface FileListSettings {
  ignoredFileExtensions: string[];
  ignoredDirectories: string[];
  ignoredKeywords: string[];
  ignoredInputFiles: string[];
  ignoredMediaDirs: string[];
}

/**
 * One include/exclude file-filter shape, shared verbatim from category
 * selection through to normalization — `prepareFileFilters` fills these same
 * fields in place rather than renaming them, so `PreparedFileFilters` only
 * adds `sanitizedDirs` on top.
 */
export interface FileFilterConfig {
  include: string[];
  excludeExtensions: string[];
  excludeDirs: string[];
  excludeKeywords: string[];
  excludeFiles: string[];
}

export interface PreparedFileFilters extends FileFilterConfig {
  /**
   * `excludeDirs` before case-folding. Matching (`containsExcludedDirectory`)
   * lowercases both sides, but the VS Code glob exclude pattern built in
   * `listing.ts` runs against on-disk paths and needs the original case.
   */
  sanitizedDirs: string[];
}

function trimNonEmpty(values: readonly string[]): string[] {
  return values
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function normalizeList(values: readonly string[]): string[] {
  return trimNonEmpty(values).map((value) => value.toLowerCase());
}

export function loadFileListSettings(): FileListSettings {
  const { ignored } = FILE_HANDLING_RULES;
  return {
    ignoredFileExtensions: [...ignored.fileExtensions],
    ignoredDirectories: [...ignored.directories],
    ignoredKeywords: [...ignored.keywords],
    ignoredInputFiles: [...ignored.inputFiles],
    ignoredMediaDirs: [...ignored.mediaDirectories],
  };
}

function buildInputLikeConfig(
  category: 'input' | 'context' | 'edited',
  settings: FileListSettings,
): FileFilterConfig {
  return {
    include: getIncludedExtensions(category),
    excludeExtensions: settings.ignoredFileExtensions,
    excludeDirs: settings.ignoredDirectories,
    excludeKeywords: settings.ignoredKeywords,
    excludeFiles: settings.ignoredInputFiles,
  };
}

export function getFileListConfig(
  fileType: ListableFileType,
  settings: FileListSettings,
): FileFilterConfig {
  switch (fileType) {
    case 'input':
    case 'context':
      return buildInputLikeConfig(fileType, settings);
    case 'media':
      return {
        include: getIncludedExtensions('media'),
        excludeExtensions: [],
        excludeDirs: settings.ignoredMediaDirs,
        excludeKeywords: settings.ignoredKeywords,
        excludeFiles: [],
      };
  }
}

export function getEditedFileListConfig(
  settings: FileListSettings,
): FileFilterConfig {
  return buildInputLikeConfig('edited', settings);
}

function sanitizeDirectories(directories: readonly string[]): string[] {
  return trimNonEmpty(directories).map((dir) =>
    normalizeFilePath(dir).replace(/^\//, '').replace(/\/$/, ''),
  );
}

export function prepareFileFilters(
  config: FileFilterConfig,
): PreparedFileFilters {
  const sanitizedDirs = sanitizeDirectories(config.excludeDirs);
  return {
    include: normalizeList(config.include),
    excludeExtensions: normalizeList(config.excludeExtensions),
    excludeKeywords: normalizeList(config.excludeKeywords),
    excludeDirs: sanitizedDirs.map((dir) => dir.toLowerCase()),
    excludeFiles: normalizeList(config.excludeFiles),
    sanitizedDirs,
  };
}

function containsHiddenSegment(relativePath: string): boolean {
  return normalizeFilePath(relativePath)
    .split('/')
    .some((segment) => segment.startsWith('.') && segment.length > 1);
}

function containsExcludedDirectory(
  relativePath: string,
  excludeDirs: readonly string[],
): boolean {
  const normalizedPath = normalizeFilePath(relativePath).toLowerCase();
  const pathSegments = normalizedPath.split('/');

  return excludeDirs.some((dir) => {
    if (dir.includes('/')) {
      return `/${normalizedPath}/`.includes(`/${dir}/`);
    }
    return pathSegments.includes(dir);
  });
}

export function passesFileFilters(
  relativePath: string,
  filters: PreparedFileFilters,
): boolean {
  if (!relativePath || containsHiddenSegment(relativePath)) return false;
  if (containsExcludedDirectory(relativePath, filters.excludeDirs))
    return false;

  const lowerPath = relativePath.toLowerCase();
  const fileNameLower = getBasename(lowerPath);
  if (filters.excludeFiles.includes(fileNameLower)) return false;
  if (
    filters.include.length > 0 &&
    !filters.include.some((ext) => lowerPath.endsWith(ext))
  ) {
    return false;
  }
  if (filters.excludeExtensions.some((ext) => lowerPath.endsWith(ext)))
    return false;
  if (filters.excludeKeywords.some((kw) => fileNameLower.includes(kw))) {
    return false;
  }
  return true;
}

export function shouldVisitDirectory(
  relativePath: string,
  filters: PreparedFileFilters,
): boolean {
  if (!relativePath) return true;
  if (containsHiddenSegment(relativePath)) return false;
  return !containsExcludedDirectory(relativePath, filters.excludeDirs);
}
