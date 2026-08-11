// Node imports
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Third-party imports
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports - desktop workspace
import {
  DESKTOP_WORKSPACE_COMMANDS,
  EMPTY_DESKTOP_ENVIRONMENT_SUMMARY,
  type DesktopEnvironmentSummary,
} from '@desktop/shared/desktopWorkspaceMessages';
import { createDesktopWorkspaceIpc } from '@desktop/main/desktopWorkspaceIpc';
import type { DesktopBrowserViews } from '@desktop/main/desktopBrowserViews';
import type { DesktopPtyHost } from '@desktop/main/desktopPtyHost';
import { createFakePlatform } from '@test/support/FakePlatform';

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
    navigate: vi.fn(),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    close: vi.fn(),
    disposeAll: vi.fn(),
  };
}

type WorkspaceIpcOptions = Parameters<typeof createDesktopWorkspaceIpc>[1];

function createIpc(
  postToRenderer: (message: unknown) => void,
  overrides: Partial<WorkspaceIpcOptions> = {},
) {
  const options: WorkspaceIpcOptions = {
    ptyHost: createPtyHost(),
    browserViews: createBrowserViews(),
    toWindowBounds: (bounds) => bounds,
    ...overrides,
  };
  return createDesktopWorkspaceIpc({ postToRenderer }, options);
}

describe('desktop workspace IPC', () => {
  beforeEach(async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'texra-workspace-ipc-'));
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
    const [{ initPlatform }, { nodeFilesystem }] = await Promise.all([
      import('@platform/platform'),
      import('@platform/defaults/nodeFilesystem'),
    ]);
    initPlatform(
      createFakePlatform(
        { workspacePath },
        {
          fs: nodeFilesystem,
        },
      ),
    );
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('lists only direct children and loads nested directories on demand', async () => {
    const postToRenderer = vi.fn();
    const ipc = createIpc(postToRenderer);

    ipc.handleMessage({
      command: DESKTOP_WORKSPACE_COMMANDS.LIST_FILES,
      requestId: REQUEST_ID,
    });
    await vi.waitFor(() =>
      expect(postToRenderer).toHaveBeenCalledWith({
        command: DESKTOP_WORKSPACE_COMMANDS.FILES_LISTED,
        requestId: REQUEST_ID,
        directory: '',
        files: [
          { path: 'paper.tex', isDirectory: false },
          { path: 'src', isDirectory: true },
        ],
      }),
    );

    ipc.handleMessage({
      command: DESKTOP_WORKSPACE_COMMANDS.LIST_FILES,
      requestId: REQUEST_ID,
      directory: 'src',
    });
    await vi.waitFor(() =>
      expect(postToRenderer).toHaveBeenCalledWith({
        command: DESKTOP_WORKSPACE_COMMANDS.FILES_LISTED,
        requestId: REQUEST_ID,
        directory: 'src',
        files: [
          { path: 'src/deep', isDirectory: true },
          { path: 'src/index.ts', isDirectory: false },
        ],
      }),
    );
    expect(postToRenderer).not.toHaveBeenCalledWith(
      expect.objectContaining({
        files: expect.arrayContaining([
          expect.objectContaining({ path: 'src/deep/nested.ts' }),
        ]),
      }),
    );
  });

  it('reads regular workspace files but rejects symlink targets outside the workspace', async () => {
    const postToRenderer = vi.fn();
    const onAsyncError = vi.fn();
    const ipc = createIpc(postToRenderer, { onAsyncError });

    ipc.handleMessage({
      command: DESKTOP_WORKSPACE_COMMANDS.READ_FILE,
      requestId: REQUEST_ID,
      path: 'paper.tex',
    });
    await vi.waitFor(() =>
      expect(postToRenderer).toHaveBeenCalledWith({
        command: DESKTOP_WORKSPACE_COMMANDS.FILE_READ,
        requestId: REQUEST_ID,
        path: 'paper.tex',
        contents: 'inside',
      }),
    );

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

    await vi.waitFor(() => expect(onAsyncError).toHaveBeenCalledTimes(3));
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

  it('recreates a workspace file deleted after the editor loaded it', async () => {
    const postToRenderer = vi.fn();
    const ipc = createIpc(postToRenderer);
    rmSync(join(workspacePath, 'paper.tex'));

    ipc.handleMessage({
      command: DESKTOP_WORKSPACE_COMMANDS.WRITE_FILE,
      requestId: REQUEST_ID,
      path: 'paper.tex',
      contents: 'recovered buffer',
    });

    await vi.waitFor(() =>
      expect(postToRenderer).toHaveBeenCalledWith({
        command: DESKTOP_WORKSPACE_COMMANDS.FILE_WRITTEN,
        requestId: REQUEST_ID,
        path: 'paper.tex',
      }),
    );
    expect(readFileSync(join(workspacePath, 'paper.tex'), 'utf8')).toBe(
      'recovered buffer',
    );
  });

  it('reports a clear error when the deleted file parent is also gone', async () => {
    const postToRenderer = vi.fn();
    const ipc = createIpc(postToRenderer);
    rmSync(join(workspacePath, 'src'), { recursive: true });

    ipc.handleMessage({
      command: DESKTOP_WORKSPACE_COMMANDS.WRITE_FILE,
      requestId: REQUEST_ID,
      path: 'src/index.ts',
      contents: 'unrecoverable buffer',
    });

    await vi.waitFor(() =>
      expect(postToRenderer).toHaveBeenCalledWith({
        command: DESKTOP_WORKSPACE_COMMANDS.FILE_ERROR,
        requestId: REQUEST_ID,
        path: 'src/index.ts',
        message:
          'The file cannot be recreated because its parent folder no longer exists.',
      }),
    );
  });

  it('accepts no editor dirty-state mirror from the renderer', () => {
    // Editor dirtiness lives in the renderer's Monaco buffers. The main
    // process used to keep a mirrored copy here and decide the discard prompt
    // from it, which went stale while the message was in flight; the prompt is
    // now driven only by the renderer's beforeunload veto.
    const ipc = createIpc(vi.fn());

    expect(
      ipc.handleMessage({
        command: 'desktop:workspace:editorDirtyState',
        dirty: true,
      }),
    ).toBe(false);
  });

  it('disposes terminal and browser resources at a renderer boundary', () => {
    const ptyHost = createPtyHost();
    const browserViews = createBrowserViews();
    const ipc = createIpc(vi.fn(), { ptyHost, browserViews });

    ipc.disposeRendererResources();

    expect(ptyHost.disposeAll).toHaveBeenCalledOnce();
    expect(browserViews.disposeAll).toHaveBeenCalledOnce();
  });

  it('posts environment state and clears loading state after host failures', async () => {
    const environment: DesktopEnvironmentSummary = {
      isGitRepository: true,
      branch: 'feature/ui',
      upstream: 'origin/feature/ui',
      changedFiles: 3,
      additions: 12,
      deletions: 4,
      ahead: 1,
      behind: 0,
    };
    const postToRenderer = vi.fn();
    const onAsyncError = vi.fn();
    const success = createIpc(postToRenderer, {
      getEnvironmentSummary: async () => environment,
      onAsyncError,
    });

    success.handleMessage({
      command: DESKTOP_WORKSPACE_COMMANDS.ENVIRONMENT_REQUEST,
    });
    await vi.waitFor(() =>
      expect(postToRenderer).toHaveBeenCalledWith({
        command: DESKTOP_WORKSPACE_COMMANDS.ENVIRONMENT_STATE,
        environment,
      }),
    );

    const failure = new Error('git unavailable');
    const failed = createIpc(postToRenderer, {
      getEnvironmentSummary: async () => {
        throw failure;
      },
      onAsyncError,
    });
    failed.handleMessage({
      command: DESKTOP_WORKSPACE_COMMANDS.ENVIRONMENT_REQUEST,
    });

    await vi.waitFor(() => expect(onAsyncError).toHaveBeenCalledWith(failure));
    expect(postToRenderer).toHaveBeenLastCalledWith({
      command: DESKTOP_WORKSPACE_COMMANDS.ENVIRONMENT_STATE,
      environment: EMPTY_DESKTOP_ENVIRONMENT_SUMMARY,
    });
  });

  it('runs setup commands only after the integrated pty is ready', async () => {
    const write = vi.fn();
    const create = vi.fn(async () => ({
      id: 'workbench:terminal:1',
      write,
      resize: vi.fn(),
      dispose: vi.fn(),
    }));
    const ipc = createIpc(vi.fn(), {
      ptyHost: { create, get: vi.fn(() => undefined), disposeAll: vi.fn() },
    });

    expect(
      ipc.handleMessage({
        command: DESKTOP_WORKSPACE_COMMANDS.TERMINAL_START,
        sessionId: 'workbench:terminal:1',
        cols: 80,
        rows: 24,
        initialCommand: 'brew install ghostscript',
      }),
    ).toBe(true);

    await vi.waitFor(() =>
      expect(write).toHaveBeenCalledWith('brew install ghostscript\r'),
    );
    expect(create).toHaveBeenCalledWith({
      id: 'workbench:terminal:1',
      cols: 80,
      rows: 24,
    });
  });
});
