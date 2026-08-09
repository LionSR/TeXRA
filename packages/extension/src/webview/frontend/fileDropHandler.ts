// Local imports - common webview
import { MAIN_VIEW_COMMANDS } from '@shared/ipc';

// Local imports - shared utilities
import { postMessage } from '@shared/hostBridge';

// Local imports - shared schemas
import type { MultipleDocumentFileType } from '@shared/schemas';
import { tryParseUrl, unique } from '@utils/core';

// Third-party type imports
import type { ReactiveController, ReactiveControllerHost } from 'lit';

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

  const url = tryParseUrl(value);
  if (!url || url.protocol !== 'file:') return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (url.hostname && url.hostname !== 'localhost') {
    return `//${url.hostname}${pathname}`;
  }
  return pathname.replace(/^\/([A-Za-z]:)/, '$1');
}

function normalizeDroppedPath(
  value: string | null | undefined,
  fallbackToRaw: boolean,
): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const decoded = decodeFileUri(trimmed);
  return fallbackToRaw ? (decoded ?? trimmed) : decoded;
}

function hasFileUri(dataTransfer: DataTransfer, type: string): boolean {
  // During `dragenter`/`dragover` the drag data store is in protected mode, so
  // `getData()` returns an empty string and only `types` is readable. We must
  // still treat the payload as droppable then (and call `preventDefault()`),
  // otherwise the browser rejects the element as a drop target and the `drop`
  // event never fires. The real URI content is validated at drop time in
  // `extractDroppedFilePaths` and again on the host when resolving workspace
  // files, so an empty read here is safe to accept.
  const data = dataTransfer.getData(type);
  if (!data) return true;
  return data
    .split(/\r?\n/)
    .some((line) => normalizeDroppedPath(line, false) != null);
}

/** Return true when the drag payload appears to contain files or file URIs. */
export function hasDroppedFilePayload(
  dataTransfer: DataTransfer | null,
): boolean {
  if (!dataTransfer) return false;
  const types = [...(dataTransfer.types ?? [])];
  return (
    types.includes('Files') ||
    types.includes('application/vnd.code.tree.resource') ||
    (types.includes('text/uri-list') &&
      hasFileUri(dataTransfer, 'text/uri-list'))
  );
}

/** Extract absolute paths or file URIs from a drop payload. */
export function extractDroppedFilePaths(
  dataTransfer: DataTransfer | null,
): string[] {
  if (!dataTransfer) return [];

  const paths = new Set<string>();
  for (const file of dataTransfer.files ?? []) {
    const path = normalizeDroppedPath((file as FileWithPath).path, true);
    if (path) paths.add(path);
  }

  for (const type of FILE_URI_TEXT_TYPES) {
    const data = dataTransfer.getData(type);
    if (!data) continue;
    for (const line of data.split(/\r?\n/)) {
      const path = normalizeDroppedPath(line, false);
      if (path) paths.add(path);
    }
  }

  return [...paths];
}

/**
 * Drag-and-drop lifecycle for a file drop target. Tracks nested
 * dragenter/dragleave pairs so child elements don't flicker the highlight,
 * and hands validated drop payloads to `onDrop`. Bind all four handlers on
 * the drop target and drive the visual state from `isDragActive`.
 */
export class FileDropController implements ReactiveController {
  private dragDepth = 0;
  private active = false;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly onDrop: (paths: string[]) => void,
  ) {
    host.addController(this);
  }

  get isDragActive(): boolean {
    return this.active;
  }

  hostDisconnected(): void {
    this.reset();
  }

  private setActive(active: boolean): void {
    if (this.active === active) return;
    this.active = active;
    this.host.requestUpdate();
  }

  private reset(): void {
    this.dragDepth = 0;
    this.setActive(false);
  }

  readonly handleDragEnter = (event: DragEvent): void => {
    if (!hasDroppedFilePayload(event.dataTransfer)) return;
    event.preventDefault();
    this.dragDepth += 1;
    this.setActive(true);
  };

  readonly handleDragOver = (event: DragEvent): void => {
    if (!hasDroppedFilePayload(event.dataTransfer)) return;
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  };

  readonly handleDragLeave = (event: DragEvent): void => {
    if (!hasDroppedFilePayload(event.dataTransfer)) return;
    event.preventDefault();
    this.dragDepth = Math.max(0, this.dragDepth - 1);
    if (this.dragDepth === 0) {
      this.setActive(false);
    }
  };

  readonly handleDrop = (event: DragEvent): void => {
    // Always clear the drag-active visuals on drop. `dragenter`/`dragover`
    // can only inspect `dataTransfer.types` (protected mode), so a non-file
    // URI such as an https link is optimistically treated as droppable and
    // activates the outline. At drop time the payload is readable and may be
    // rejected — but no `dragleave` follows a `drop`, so failing to reset here
    // would leave the drop target permanently stuck in the drop-active state.
    const wasDragActive = this.active;
    this.reset();
    if (!hasDroppedFilePayload(event.dataTransfer)) {
      if (wasDragActive) event.preventDefault();
      return;
    }
    event.preventDefault();
    this.onDrop(extractDroppedFilePaths(event.dataTransfer));
  };
}

export function postDroppedFiles(
  paths: string[],
  target?: MultipleDocumentFileType,
): boolean {
  const uniquePaths = unique(paths.filter(Boolean));
  if (uniquePaths.length === 0) return false;

  postMessage(MAIN_VIEW_COMMANDS.ATTACH_DROPPED_FILES, {
    paths: uniquePaths,
    ...(target ? { target } : {}),
  });
  return true;
}
