// Node imports
import {
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
} from '@desktop/desktopWorkspaceMessages';
import { createDesktopWorkspaceIpc } from '@desktop/main/desktopWorkspaceIpc';
import type { DesktopBrowserViews } from '@desktop/main/desktopBrowserViews';
import type { DesktopPtyHost } from '@desktop/main/desktopPtyHost';
import { createFakePlatform } from '@test/support/FakePlatform';

let fixtureRoot = '';
let workspacePath = '';
let externalPath = '';

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

describe('desktop workspace IPC', () => {
  beforeEach(async () => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'texra-workspace-ipc-'));
    workspacePath = join(fixtureRoot, 'workspace');
    externalPath = join(fixtureRoot, 'external.txt');
    mkdirSync(workspacePath);
    writeFileSync(join(workspacePath, 'paper.tex'), 'inside', 'utf8');
    writeFileSync(externalPath, 'outside', 'utf8');
    symlinkSync(externalPath, join(workspacePath, 'linked.tex'));
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

  it('reads regular workspace files but rejects symlink targets outside the workspace', async () => {
    const postToRenderer = vi.fn();
    const onAsyncError = vi.fn();
    const ipc = createDesktopWorkspaceIpc(
      { postToRenderer },
      {
        ptyHost: createPtyHost(),
        browserViews: createBrowserViews(),
        toWindowBounds: (bounds) => bounds,
        onAsyncError,
      },
    );

    ipc.handleMessage({
      command: DESKTOP_WORKSPACE_COMMANDS.READ_FILE,
      path: 'paper.tex',
    });
    await vi.waitFor(() =>
      expect(postToRenderer).toHaveBeenCalledWith({
        command: DESKTOP_WORKSPACE_COMMANDS.FILE_READ,
        path: 'paper.tex',
        contents: 'inside',
      }),
    );

    ipc.handleMessage({
      command: DESKTOP_WORKSPACE_COMMANDS.READ_FILE,
      path: 'linked.tex',
    });
    ipc.handleMessage({
      command: DESKTOP_WORKSPACE_COMMANDS.WRITE_FILE,
      path: 'linked.tex',
      contents: 'overwritten',
    });

    await vi.waitFor(() => expect(onAsyncError).toHaveBeenCalledTimes(2));
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
    const success = createDesktopWorkspaceIpc(
      { postToRenderer },
      {
        ptyHost: createPtyHost(),
        browserViews: createBrowserViews(),
        toWindowBounds: (bounds) => bounds,
        getEnvironmentSummary: async () => environment,
        onAsyncError,
      },
    );

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
    const failed = createDesktopWorkspaceIpc(
      { postToRenderer },
      {
        ptyHost: createPtyHost(),
        browserViews: createBrowserViews(),
        toWindowBounds: (bounds) => bounds,
        getEnvironmentSummary: async () => {
          throw failure;
        },
        onAsyncError,
      },
    );
    failed.handleMessage({
      command: DESKTOP_WORKSPACE_COMMANDS.ENVIRONMENT_REQUEST,
    });

    await vi.waitFor(() => expect(onAsyncError).toHaveBeenCalledWith(failure));
    expect(postToRenderer).toHaveBeenLastCalledWith({
      command: DESKTOP_WORKSPACE_COMMANDS.ENVIRONMENT_STATE,
      environment: EMPTY_DESKTOP_ENVIRONMENT_SUMMARY,
    });
  });
});
