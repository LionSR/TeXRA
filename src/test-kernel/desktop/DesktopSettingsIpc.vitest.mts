import { afterEach, describe, expect, it } from 'vitest';

import { WorkspaceStateKey } from '@common/state/stateKeys';
import { SETTINGS_VIEW_COMMANDS } from '@common/webview/settingsViewCommands';
import { DEFAULT_GIT_MARK_COMMITS } from '@shared/constants/git';
import {
  isWorktreeSupportEnabled,
  setWorktreeSupportEnabled,
} from '@tools/worktreeConfig';
import { getGitAuthorEnv, setGitAuthorEnv } from '@utils/system/gitAuthorEnv';

import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

interface StateStore {
  get<T>(key: string, defaultValue?: T): T;
  update(key: string, value: unknown): PromiseLike<void>;
}

interface DesktopSettingsIpcModule {
  createDesktopSettingsIpc(options: {
    postToRenderer(message: unknown): void;
    workspaceState?: StateStore;
    onError?: (error: unknown) => void;
  }): {
    handleMessage(
      message: { command: string } & Record<string, unknown>,
    ): boolean;
  };
}

class MemoryStateStore implements StateStore {
  readonly values = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

async function loadDesktopSettingsIpc(): Promise<DesktopSettingsIpcModule> {
  return import(
    moduleFileUrl(desktopSourcePath('main', 'desktopSettingsIpc.ts'))
  ) as Promise<DesktopSettingsIpcModule>;
}

describe('desktop settings IPC', () => {
  afterEach(() => {
    setGitAuthorEnv({});
    setWorktreeSupportEnabled(false);
  });

  it('applies Git author settings on creation and posts only for settings readiness', async () => {
    const { createDesktopSettingsIpc } = await loadDesktopSettingsIpc();
    const workspaceState = new MemoryStateStore();
    workspaceState.values.set(WorkspaceStateKey.GIT_AUTHOR_NAME, 'TeXRA Bot');
    workspaceState.values.set(
      WorkspaceStateKey.GIT_AUTHOR_EMAIL,
      'bot@example.com',
    );
    const posted: unknown[] = [];

    const settings = createDesktopSettingsIpc({
      workspaceState,
      postToRenderer: (message) => posted.push(message),
    });

    expect(posted).toEqual([]);
    expect(getGitAuthorEnv()).toEqual({
      GIT_AUTHOR_NAME: 'TeXRA Bot',
      GIT_AUTHOR_EMAIL: 'bot@example.com',
      GIT_COMMITTER_NAME: 'TeXRA Bot',
      GIT_COMMITTER_EMAIL: 'bot@example.com',
    });
    expect(
      settings.handleMessage({ command: SETTINGS_VIEW_COMMANDS.WEBVIEW_READY }),
    ).toBe(false);
    expect(posted).toEqual([]);
    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.WEBVIEW_READY,
        view: 'settings',
      }),
    ).toBe(false);
    expect(posted).toEqual([
      {
        command: SETTINGS_VIEW_COMMANDS.UPDATE_GIT_AUTHOR_SETTINGS,
        markCommits: DEFAULT_GIT_MARK_COMMITS,
        authorName: 'TeXRA Bot',
        authorEmail: 'bot@example.com',
        worktreeSupport: false,
      },
    ]);
  });

  it('round-trips Git author writes through workspace state and refreshes the renderer', async () => {
    const { createDesktopSettingsIpc } = await loadDesktopSettingsIpc();
    const workspaceState = new MemoryStateStore();
    const posted: unknown[] = [];

    const settings = createDesktopSettingsIpc({
      workspaceState,
      postToRenderer: (message) => posted.push(message),
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_GIT_AUTHOR_NAME,
        name: 'Desktop TeXRA',
      }),
    ).toBe(true);
    await Promise.resolve();

    expect(workspaceState.values.get(WorkspaceStateKey.GIT_AUTHOR_NAME)).toBe(
      'Desktop TeXRA',
    );
    expect(posted.at(-1)).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_GIT_AUTHOR_SETTINGS,
      authorName: 'Desktop TeXRA',
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_GIT_MARK_COMMITS,
        enabled: false,
      }),
    ).toBe(true);
    await Promise.resolve();
    expect(workspaceState.values.get(WorkspaceStateKey.GIT_MARK_COMMITS)).toBe(
      false,
    );
    expect(getGitAuthorEnv()).toEqual({});

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_GIT_WORKTREE_SUPPORT,
        enabled: true,
      }),
    ).toBe(true);
    await Promise.resolve();
    expect(
      workspaceState.values.get(WorkspaceStateKey.GIT_WORKTREE_SUPPORT),
    ).toBe(true);
    expect(isWorktreeSupportEnabled()).toBe(true);
  });

  it('serves Git author read requests without reapplying process env', async () => {
    const { createDesktopSettingsIpc } = await loadDesktopSettingsIpc();
    const workspaceState = new MemoryStateStore();
    workspaceState.values.set(WorkspaceStateKey.GIT_AUTHOR_NAME, 'Applied');
    workspaceState.values.set(
      WorkspaceStateKey.GIT_AUTHOR_EMAIL,
      'applied@example.com',
    );
    const posted: unknown[] = [];

    const settings = createDesktopSettingsIpc({
      workspaceState,
      postToRenderer: (message) => posted.push(message),
    });

    workspaceState.values.set(WorkspaceStateKey.GIT_AUTHOR_NAME, 'Read Only');
    workspaceState.values.set(
      WorkspaceStateKey.GIT_AUTHOR_EMAIL,
      'read@example.com',
    );

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.GET_GIT_AUTHOR_SETTINGS,
      }),
    ).toBe(true);
    expect(posted.at(-1)).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_GIT_AUTHOR_SETTINGS,
      authorName: 'Read Only',
      authorEmail: 'read@example.com',
    });
    expect(getGitAuthorEnv()).toEqual({
      GIT_AUTHOR_NAME: 'Applied',
      GIT_AUTHOR_EMAIL: 'applied@example.com',
      GIT_COMMITTER_NAME: 'Applied',
      GIT_COMMITTER_EMAIL: 'applied@example.com',
    });
  });

  it('ignores unsupported or malformed settings messages', async () => {
    const { createDesktopSettingsIpc } = await loadDesktopSettingsIpc();
    const posted: unknown[] = [];
    const settings = createDesktopSettingsIpc({
      workspaceState: new MemoryStateStore(),
      postToRenderer: (message) => posted.push(message),
    });

    expect(settings.handleMessage({ command: 'unknown' })).toBe(false);
    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_GIT_AUTHOR_NAME,
      }),
    ).toBe(false);
    expect(posted).toEqual([]);
  });
});
