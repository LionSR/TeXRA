import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { it } from '@effect/vitest';
import { Deferred, Effect, Exit, Scope } from 'effect';
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

import { DESKTOP_WORKSPACE_COMMANDS } from '@desktop/shared/desktopWorkspaceMessages';
import { createDesktopWorkspaceIpc } from '@desktop/main/desktopWorkspaceIpc';
import type { DesktopBrowserViews } from '@desktop/main/desktopBrowserViews';
import type { DesktopPtyHost } from '@desktop/main/desktopPtyHost';
import { emitAppSignal } from '@eventBus/AppSignals';
import { testRuntime } from '@test/support/testProcessRuntime';
import { createDeferred } from '@test/support/asyncTestUtils';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';

let fixtureRoot = '';
let workspacePath = '';
let externalPath = '';
let missingExternalPath = '';

// Editor file I/O is request/response RPC correlated by request id; the main
// process echoes the renderer-supplied id in its reply.
const REQUEST_ID = '123e4567-e89b-42d3-a456-426614174000';

function createPtyHost(): DesktopPtyHost {
  return {
    create: vi.fn(async () => {
      throw new Error('Terminal is not used in this test.');
    }),
    get: vi.fn(() => undefined),
    disposeAll: vi.fn(),
  };
}

function createBrowserViews(): DesktopBrowserViews {
  return {
    open: vi.fn(),
    show: vi.fn(),
    hideAll: vi.fn(),
    close: vi.fn(),
    disposeAll: vi.fn(),
  };
}

type WorkspaceIpcOptions = Parameters<typeof createDesktopWorkspaceIpc>[1];

function createIpc(
  postToRenderer: (message: unknown) => void,
  overrides: Partial<WorkspaceIpcOptions> = {},
  onAsyncError: (error: unknown) => void = vi.fn(),
) {
  const runtime = testRuntime();
  const options: WorkspaceIpcOptions = {
    ptyHost: createPtyHost(),
    browserViews: createBrowserViews(),
    toWindowBounds: (bounds) => bounds,
    getWorkspacePath: () => workspacePath,
    ...overrides,
  };
  const ipc = createDesktopWorkspaceIpc({ postToRenderer }, options);
  // The IPC follows a process-global bus, so a fixture whose scope stayed
  // open would keep reacting to later tests' emits.
  const scope = Scope.makeUnsafe();
  liveScopes.push(scope);
  runtime.runSync(
    Effect.forkIn(ipc.followFilesWritten, scope, { startImmediately: true }),
  );
  return {
    ...ipc,
    // Runs the answered program the way the window's router does: forked,
    // with its failure handed to the async-error reporter.
    handleMessage(message: Parameters<typeof ipc.handleMessage>[0]) {
      const program = ipc.handleMessage({ ...message, session: workspacePath });
      if (!program) return false;
      runtime.runFork(
        program.pipe(
          Effect.catch((error) => Effect.sync(() => onAsyncError(error))),
        ),
      );
      return true;
    },
  };
}

const liveScopes: Scope.Closeable[] = [];

/** Resolve the returned promise the next time `mock` is called with an
 *  argument matching `predicate`. The mock's own return stays undefined. */
function nextCall(
  mock: ReturnType<typeof vi.fn>,
  predicate: (arg: unknown) => boolean,
): Promise<void> {
  const called = createDeferred();
  mock.mockImplementationOnce((arg: unknown) => {
    if (predicate(arg)) called.resolve();
  });
  return called.promise;
}

describe('desktop workspace IPC', () => {
  const tempDirs = useTempDirs();

  beforeEach(async () => {
    fixtureRoot = await makeTempDir('texra-workspace-ipc-', tempDirs);
    workspacePath = join(fixtureRoot, 'workspace');
    externalPath = join(fixtureRoot, 'external.txt');
    missingExternalPath = join(fixtureRoot, 'missing-external.txt');
    mkdirSync(workspacePath);
    mkdirSync(join(workspacePath, 'src', 'deep'), { recursive: true });
    mkdirSync(join(workspacePath, 'node_modules'));
    writeFileSync(join(workspacePath, 'paper.tex'), 'inside', 'utf8');
    writeFileSync(join(workspacePath, 'src', 'index.ts'), 'export {};', 'utf8');
    writeFileSync(
      join(workspacePath, 'src', 'deep', 'nested.ts'),
      'export {};',
      'utf8',
    );
    writeFileSync(externalPath, 'outside', 'utf8');
    symlinkSync(externalPath, join(workspacePath, 'linked.tex'));
    symlinkSync(
      missingExternalPath,
      join(workspacePath, 'dangling-linked.tex'),
    );
    const { installPlatform } = await import('@test/support/setupPlatform');
    await installPlatform({ workspacePath });
  });

  afterEach(() => {
    for (const scope of liveScopes.splice(0))
      testRuntime().runFork(Scope.close(scope, Exit.void));
  });

  // The file tree caches its listing and there is no filesystem watcher, so a
  // run that accepts output files would leave it stale without this notice.
  it.live(
    'tells the renderer to re-list only when a write lands inside the workspace',
    () =>
      Effect.gen(function* () {
        const filesChanged = Deferred.makeUnsafe<void>();
        const postToRenderer = vi.fn((message) => {
          if (
            (message as { command?: string }).command ===
            DESKTOP_WORKSPACE_COMMANDS.FILES_CHANGED
          ) {
            Deferred.doneUnsafe(filesChanged, Effect.void);
          }
        });
        createIpc(postToRenderer);
        // The IPC's subscription registers on its own fiber of this runtime;
        // let it reach the hub before publishing, or the writes below reach
        // nobody.
        yield* Effect.yieldNow;

        // Both writes are published before either is delivered, and one
        // subscriber sees them in publication order — so the single call
        // below is what proves the outside-the-workspace write was ignored.
        emitAppSignal('workspaceFilesWritten', {
          absolutePaths: [externalPath],
        });
        emitAppSignal('workspaceFilesWritten', {
          absolutePaths: [externalPath, join(workspacePath, 'paper.tex')],
        });

        yield* Deferred.await(filesChanged);
        expect(postToRenderer).toHaveBeenCalledExactlyOnceWith({
          command: DESKTOP_WORKSPACE_COMMANDS.FILES_CHANGED,
        });
      }),
  );

  it('reads regular workspace files but rejects symlink targets outside the workspace', async () => {
    const postToRenderer = vi.fn();
    const onAsyncError = vi.fn();
    const ipc = createIpc(postToRenderer, {}, onAsyncError);

    const fileRead = nextCall(
      postToRenderer,
      (message) =>
        (message as { command?: string }).command ===
          DESKTOP_WORKSPACE_COMMANDS.FILE_READ &&
        (message as { path?: string }).path === 'paper.tex',
    );
    ipc.handleMessage({
      command: DESKTOP_WORKSPACE_COMMANDS.READ_FILE,
      requestId: REQUEST_ID,
      path: 'paper.tex',
    });
    await fileRead;
    expect(postToRenderer).toHaveBeenCalledWith({
      command: DESKTOP_WORKSPACE_COMMANDS.FILE_READ,
      requestId: REQUEST_ID,
      path: 'paper.tex',
      contents: 'inside',
    });

    ipc.handleMessage({
      command: DESKTOP_WORKSPACE_COMMANDS.READ_FILE,
      requestId: REQUEST_ID,
      path: 'linked.tex',
    });
    ipc.handleMessage({
      command: DESKTOP_WORKSPACE_COMMANDS.WRITE_FILE,
      requestId: REQUEST_ID,
      path: 'linked.tex',
      contents: 'overwritten',
    });
    ipc.handleMessage({
      command: DESKTOP_WORKSPACE_COMMANDS.WRITE_FILE,
      requestId: REQUEST_ID,
      path: 'dangling-linked.tex',
      contents: 'created outside',
    });

    const asyncErrorsReported = createDeferred();
    onAsyncError.mockImplementation(() => {
      if (onAsyncError.mock.calls.length === 3) asyncErrorsReported.resolve();
    });
    await asyncErrorsReported.promise;
    expect(onAsyncError).toHaveBeenCalledTimes(3);
    expect(postToRenderer).not.toHaveBeenCalledWith(
      expect.objectContaining({
        command: DESKTOP_WORKSPACE_COMMANDS.FILE_READ,
        path: 'linked.tex',
      }),
    );
    expect(postToRenderer).not.toHaveBeenCalledWith(
      expect.objectContaining({
        command: DESKTOP_WORKSPACE_COMMANDS.FILE_WRITTEN,
        path: 'linked.tex',
      }),
    );
    expect(readFileSync(externalPath, 'utf8')).toBe('outside');
    expect(existsSync(missingExternalPath)).toBe(false);
  });

  it('keeps a UTF-8 byte-order mark when reading, so a save cannot delete it', async () => {
    const postToRenderer = vi.fn();
    const ipc = createIpc(postToRenderer);

    writeFileSync(
      join(workspacePath, 'bom.tex'),
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from('hi', 'utf8'),
      ]),
    );
    const bomRead = nextCall(
      postToRenderer,
      (message) =>
        (message as { command?: string }).command ===
          DESKTOP_WORKSPACE_COMMANDS.FILE_READ &&
        (message as { path?: string }).path === 'bom.tex',
    );
    ipc.handleMessage({
      command: DESKTOP_WORKSPACE_COMMANDS.READ_FILE,
      requestId: REQUEST_ID,
      path: 'bom.tex',
    });
    await bomRead;
    expect(postToRenderer).toHaveBeenCalledWith(
      expect.objectContaining({
        command: DESKTOP_WORKSPACE_COMMANDS.FILE_READ,
        path: 'bom.tex',
        contents: '\uFEFFhi',
      }),
    );
  });

  it('recreates a workspace file deleted after the editor loaded it', async () => {
    const postToRenderer = vi.fn();
    const ipc = createIpc(postToRenderer);
    rmSync(join(workspacePath, 'paper.tex'));

    const fileWritten = nextCall(
      postToRenderer,
      (message) =>
        (message as { command?: string }).command ===
          DESKTOP_WORKSPACE_COMMANDS.FILE_WRITTEN &&
        (message as { path?: string }).path === 'paper.tex',
    );
    ipc.handleMessage({
      command: DESKTOP_WORKSPACE_COMMANDS.WRITE_FILE,
      requestId: REQUEST_ID,
      path: 'paper.tex',
      contents: 'recovered buffer',
    });

    await fileWritten;
    expect(postToRenderer).toHaveBeenCalledWith({
      command: DESKTOP_WORKSPACE_COMMANDS.FILE_WRITTEN,
      requestId: REQUEST_ID,
      path: 'paper.tex',
    });
    expect(readFileSync(join(workspacePath, 'paper.tex'), 'utf8')).toBe(
      'recovered buffer',
    );
  });
});
