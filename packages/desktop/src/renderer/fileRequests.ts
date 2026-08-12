// The renderer is sandboxed, so file I/O runs in the main process. These
// helpers turn the fire-and-forget message pairs into promises the editor pane
// can await, correlated by request id so concurrent requests — even for the
// same path — can't cross-resolve.

import { postMessage } from '@shared/hostBridge';
import { DESKTOP_WORKSPACE_COMMANDS } from '../shared/desktopWorkspaceMessages';
import type { EditorFileEntry } from './editorTree';

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

const pendingFileRequests = new Map<string, PendingFileRequest>();

export function takePendingFileRequest(
  requestId: string,
): PendingFileRequest | undefined {
  const pending = pendingFileRequests.get(requestId);
  pendingFileRequests.delete(requestId);
  return pending;
}

export function requestFiles(
  directory: string,
): Promise<readonly EditorFileEntry[]> {
  // A second list for a directory already in flight shares the promise rather
  // than posting a redundant LIST_FILES.
  for (const request of pendingFileRequests.values()) {
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
  pendingFileRequests.set(requestId, {
    kind: 'list',
    directory,
    promise,
    resolve: resolveList,
    reject: rejectList,
  });
  postMessage(DESKTOP_WORKSPACE_COMMANDS.LIST_FILES, { requestId, directory });
  return promise;
}

export function requestFileRead(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    pendingFileRequests.set(requestId, { kind: 'read', resolve, reject });
    postMessage(DESKTOP_WORKSPACE_COMMANDS.READ_FILE, { requestId, path });
  });
}

export function requestFileWrite(
  path: string,
  contents: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    pendingFileRequests.set(requestId, {
      kind: 'write',
      resolve: () => resolve(),
      reject,
    });
    postMessage(DESKTOP_WORKSPACE_COMMANDS.WRITE_FILE, {
      requestId,
      path,
      contents,
    });
  });
}
