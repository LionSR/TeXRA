// Local imports - common webview
import { MAIN_VIEW_COMMANDS } from '@common/webview/commands';

// Local imports - shared utilities
import { postMessage } from '@shared/hostBridge';

// Local imports - shared schemas
import type { MultipleDocumentFileType } from '@shared/schemas';

type FileWithPath = File & {
  path?: string;
};

const FILE_URI_PREFIX = 'file:';
const FILE_URI_TEXT_TYPES = [
  'text/uri-list',
  'application/vnd.code.tree.resource',
];

function decodeFileUri(value: string): string | null {
  if (!value.startsWith(FILE_URI_PREFIX)) {
    return null;
  }

  try {
    const url = new URL(value);
    if (url.protocol !== 'file:') return null;
    const pathname = decodeURIComponent(url.pathname);
    if (url.hostname && url.hostname !== 'localhost') {
      return `//${url.hostname}${pathname}`;
    }
    return pathname.replace(/^\/([A-Za-z]:)/, '$1');
  } catch {
    return null;
  }
}

function normalizeLocalPath(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  return decodeFileUri(trimmed) ?? trimmed;
}

function normalizeFileUri(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  return decodeFileUri(trimmed);
}

function addLocalPath(
  paths: Set<string>,
  value: string | null | undefined,
): void {
  if (!value) return;
  const path = normalizeLocalPath(value);
  if (path) paths.add(path);
}

function addFileUri(
  paths: Set<string>,
  value: string | null | undefined,
): void {
  if (!value) return;
  const path = normalizeFileUri(value);
  if (path) paths.add(path);
}

function hasFileUri(dataTransfer: DataTransfer, type: string): boolean {
  const data = dataTransfer.getData(type);
  if (!data) return false;
  return data.split(/\r?\n/).some((line) => normalizeFileUri(line) != null);
}

/** Return true when the drag payload appears to contain files or file URIs. */
export function hasDroppedFilePayload(
  dataTransfer: DataTransfer | null,
): boolean {
  if (!dataTransfer) return false;
  const types = [...(dataTransfer.types ?? [])];
  if (types.includes('Files')) return true;
  if (types.includes('application/vnd.code.tree.resource')) return true;
  return types.includes('text/uri-list')
    ? hasFileUri(dataTransfer, 'text/uri-list')
    : false;
}

/** Extract absolute paths or file URIs from a drop payload. */
export function extractDroppedFilePaths(
  dataTransfer: DataTransfer | null,
): string[] {
  if (!dataTransfer) return [];

  const paths = new Set<string>();
  for (const file of dataTransfer.files ?? []) {
    addLocalPath(paths, (file as FileWithPath).path);
  }

  for (const type of FILE_URI_TEXT_TYPES) {
    const data = dataTransfer.getData(type);
    if (!data) continue;
    for (const line of data.split(/\r?\n/)) {
      addFileUri(paths, line);
    }
  }

  return [...paths];
}

export function postDroppedFiles(
  paths: string[],
  target?: MultipleDocumentFileType,
): boolean {
  const uniquePaths = [...new Set(paths.filter(Boolean))];
  if (uniquePaths.length === 0) return false;

  postMessage(MAIN_VIEW_COMMANDS.ATTACH_DROPPED_FILES, {
    paths: uniquePaths,
    ...(target ? { target } : {}),
  });
  return true;
}
