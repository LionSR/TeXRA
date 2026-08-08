import { getBasename, getFileStem, normalizeFilePath } from '@utils/core';

import { FILE_HANDLING_RULES } from './fileHandlingRules';
import { getIncludedExtensions, type ExtensionCategory } from './fileTypeUtils';

export type ListableFileType = Exclude<ExtensionCategory, 'audio'>;

export interface FileListSettings {
  ignoredFileExtensions: string[];
  ignoredDirectories: string[];
  ignoredKeywords: string[];
  ignoredInputFiles: string[];
  ignoredInputDirectories: string[];
  ignoredMediaDirs: string[];
}

export interface FileListConfig {
  extensions: string[];
  ignoredExtensions: string[];
  ignoredDirs: string[];
  ignoredKeywords: string[];
  ignoredFiles: string[];
}

export interface PreparedFileFilters {
  includeExt: string[];
  excludeExt: string[];
  excludeKeywords: string[];
  excludeDirs: string[];
  excludeFiles: string[];
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
    ignoredInputDirectories: [...ignored.inputDirectories],
    ignoredMediaDirs: [...ignored.mediaDirectories],
  };
}

function buildInputLikeConfig(
  category: 'input' | 'edited',
  settings: FileListSettings,
): FileListConfig {
  return {
    extensions: getIncludedExtensions(category),
    ignoredExtensions: settings.ignoredFileExtensions,
    ignoredDirs: [
      ...settings.ignoredDirectories,
      ...settings.ignoredInputDirectories,
    ],
    ignoredKeywords: settings.ignoredKeywords,
    ignoredFiles: settings.ignoredInputFiles,
  };
}

export function getFileListConfig(
  fileType: ListableFileType,
  settings: FileListSettings,
): FileListConfig | null {
  switch (fileType) {
    case 'input':
      return buildInputLikeConfig('input', settings);
    case 'context':
      return {
        extensions: getIncludedExtensions('context'),
        ignoredExtensions: settings.ignoredFileExtensions,
        ignoredDirs: settings.ignoredDirectories,
        ignoredKeywords: settings.ignoredKeywords,
        ignoredFiles: settings.ignoredInputFiles,
      };
    case 'media':
      return {
        extensions: getIncludedExtensions('media'),
        ignoredExtensions: [],
        ignoredDirs: settings.ignoredMediaDirs,
        ignoredKeywords: settings.ignoredKeywords,
        ignoredFiles: [],
      };
    case 'edited':
      return null;
  }
}

export function getEditedFileListConfig(
  settings: FileListSettings,
): FileListConfig {
  return buildInputLikeConfig('edited', settings);
}

function sanitizeDirectories(directories: readonly string[]): string[] {
  return trimNonEmpty(directories).map((dir) =>
    normalizeFilePath(dir).replace(/^\//, '').replace(/\/$/, ''),
  );
}

export function prepareFileFilters(
  config: FileListConfig,
): PreparedFileFilters {
  const sanitizedDirs = sanitizeDirectories(config.ignoredDirs);
  return {
    includeExt: normalizeList(config.extensions),
    excludeExt: normalizeList(config.ignoredExtensions),
    excludeKeywords: normalizeList(config.ignoredKeywords),
    excludeDirs: sanitizedDirs.map((dir) => dir.toLowerCase()),
    excludeFiles: normalizeList(config.ignoredFiles),
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
    filters.includeExt.length > 0 &&
    !filters.includeExt.some((ext) => lowerPath.endsWith(ext))
  ) {
    return false;
  }
  if (filters.excludeExt.some((ext) => lowerPath.endsWith(ext))) return false;
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

/**
 * Trailing/embedded `_r{N}` round token used by mid-era workflow output
 * filenames (`<base>_r{round}`). No shared owner function covers this
 * end-anchored form — `extractLastRoundMatch`'s `/_r(\d+)_/g` requires a
 * trailing underscore and does not match it (verified) — so this module owns
 * it for both call sites below.
 */
const ROUND_TOKEN_SOURCE = '_r\\d+';
const TRAILING_ROUND_TOKEN_REGEX = new RegExp(
  `^(.+?)(?:${ROUND_TOKEN_SOURCE})?$`,
);
const ROUND_TOKEN_REGEX = new RegExp(ROUND_TOKEN_SOURCE);

function getBaseNameWithoutRound(baseName: string): string {
  return baseName.match(TRAILING_ROUND_TOKEN_REGEX)?.[1] ?? baseName;
}

export function matchesEditedFile(
  filePath: string,
  baseFileName: string,
): boolean {
  const baseName = getFileStem(baseFileName);
  const fileBase = getFileStem(filePath);
  if (fileBase === baseName) return false;
  const baseNameWithoutRound = getBaseNameWithoutRound(baseName);
  return (
    fileBase.startsWith(baseName) ||
    (fileBase.startsWith(baseNameWithoutRound) &&
      ROUND_TOKEN_REGEX.test(fileBase))
  );
}
