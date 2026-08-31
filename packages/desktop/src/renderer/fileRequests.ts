// The renderer is sandboxed, so file I/O runs in the main process. These
// helpers turn the fire-and-forget message pairs into promises the editor pane
// can await, correlated by request id so concurrent requests — even for the
// same path — can't cross-resolve.

import { postMessage } from '@shared/hostBridge';
import { ensureError } from '@utils/errors/errorMessage';
import { DESKTOP_WORKSPACE_COMMANDS } from '../shared/desktopWorkspaceMessages';
import type { EditorFileEntry } from './editorTree';

const FILE_REQUEST_TIMEOUT_MS = 60_000;

type PendingFileRequest =
  | {
      readonly kind: 'read';
      resolve(contents: string): void;
      reject(error: Error): void;
    }
  | {
      readonly kind: 'write';
      resolve(): void;
      reject(error: Error): void;
    }
  | {
      readonly kind: 'list';
      readonly directory: string;
      readonly promise: Promise<readonly EditorFileEntry[]>;
      resolve(files: readonly EditorFileEntry[]): void;
      reject(error: Error): void;
    };

interface PendingFileRequestEntry {
  readonly request: PendingFileRequest;
  readonly timeout?: ReturnType<typeof setTimeout>;
}

const pendingFileRequests = new Map<string, PendingFileRequestEntry>();

function registerFileRequest(
  requestId: string,
  request: PendingFileRequest,
  send: () => void,
): void {
  // The main process cannot cancel an in-flight write. Keep waiting for its
  // response so a retry cannot race and later be overwritten by that write.
  const timeout =
    request.kind === 'write'
      ? undefined
      : setTimeout(() => {
          takePendingFileRequest(requestId)?.reject(
            new Error('The desktop file request timed out.'),
          );
        }, FILE_REQUEST_TIMEOUT_MS);
  pendingFileRequests.set(requestId, { request, timeout });
  try {
    send();
  } catch (error) {
    takePendingFileRequest(requestId)?.reject(ensureError(error));
  }
}

export function takePendingFileRequest(
  requestId: string,
): PendingFileRequest | undefined {
  const pending = pendingFileRequests.get(requestId);
  if (!pending) return undefined;
  pendingFileRequests.delete(requestId);
  clearTimeout(pending.timeout);
  return pending.request;
}

/** Reject every request owned by the current renderer document. */
export function disposePendingFileRequests(): void {
  const error = new Error('The desktop renderer was disposed.');
  for (const requestId of [...pendingFileRequests.keys()]) {
    takePendingFileRequest(requestId)?.reject(error);
  }
}

export function requestFiles(
  directory: string,
): Promise<readonly EditorFileEntry[]> {
  // A second list for a directory already in flight shares the promise rather
  // than posting a redundant LIST_FILES.
  for (const { request } of pendingFileRequests.values()) {
    if (request.kind === 'list' && request.directory === directory) {
      return request.promise;
    }
  }

  const requestId = crypto.randomUUID();
  let resolveList!: (files: readonly EditorFileEntry[]) => void;
  let rejectList!: (error: Error) => void;
  const promise = new Promise<readonly EditorFileEntry[]>((resolve, reject) => {
    resolveList = resolve;
    rejectList = reject;
  });
  registerFileRequest(
    requestId,
    {
      kind: 'list',
      directory,
      promise,
      resolve: resolveList,
      reject: rejectList,
    },
    () =>
      postMessage(DESKTOP_WORKSPACE_COMMANDS.LIST_FILES, {
        requestId,
        directory,
      }),
  );
  return promise;
}

export function requestFileRead(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    registerFileRequest(requestId, { kind: 'read', resolve, reject }, () =>
      postMessage(DESKTOP_WORKSPACE_COMMANDS.READ_FILE, { requestId, path }),
    );
  });
}

export function requestFileWrite(
  path: string,
  contents: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    registerFileRequest(
      requestId,
      {
        kind: 'write',
        resolve: () => resolve(),
        reject,
      },
      () =>
        postMessage(DESKTOP_WORKSPACE_COMMANDS.WRITE_FILE, {
          requestId,
          path,
          contents,
        }),
    );
  });
}
