import { afterEach, describe, expect, it } from 'vitest';

import { GlobalStateKey, WorkspaceStateKey } from '@common/state/stateKeys';
import { MAIN_VIEW_COMMANDS } from '@common/webview/mainViewCommands';
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
    globalState?: StateStore;
    workspaceState?: StateStore;
    loadAgents?: () => Promise<void>;
    loadAgentOptionsData?: () => Promise<{
      workflow: unknown[];
      toolUse: unknown[];
    }>;
    selectCustomAgentDirectory?: () => Promise<string | undefined>;
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
    if (value === undefined) {
      this.values.delete(key);
    } else {
      this.values.set(key, value);
    }
  }
}

async function loadDesktopSettingsIpc(): Promise<DesktopSettingsIpcModule> {
  return import(
    moduleFileUrl(desktopSourcePath('main', 'desktopSettingsIpc.ts'))
  ) as Promise<DesktopSettingsIpcModule>;
}

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
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
      globalState: new MemoryStateStore(),
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
      {
        command: SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_CONFIG_VALUES,
        values: {},
      },
    ]);
  });

  it('round-trips Git author writes through workspace state and refreshes the renderer', async () => {
    const { createDesktopSettingsIpc } = await loadDesktopSettingsIpc();
    const workspaceState = new MemoryStateStore();
    const posted: unknown[] = [];

    const settings = createDesktopSettingsIpc({
      workspaceState,
      globalState: new MemoryStateStore(),
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
      globalState: new MemoryStateStore(),
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

  it('serves storage-backed LaTeX config reads through workspace state', async () => {
    const { createDesktopSettingsIpc } = await loadDesktopSettingsIpc();
    const workspaceState = new MemoryStateStore();
    workspaceState.values.set(WorkspaceStateKey.WORKFLOW_AUTO_COMPILE, false);
    workspaceState.values.set(
      WorkspaceStateKey.WORKFLOW_AUTO_COMPILE_TIMEOUT_MS,
      30_000,
    );
    workspaceState.values.set(WorkspaceStateKey.LATEXDIFF_TIMEOUT_MS, 5_000);
    workspaceState.values.set(WorkspaceStateKey.LATEXDIFF_MATH_MARKUP, 'fine');
    workspaceState.values.set(WorkspaceStateKey.LATEX_FORMATTER, 'tex-fmt');
    workspaceState.values.set('texra.invalidLatexValue', 'ignored');
    const posted: unknown[] = [];

    const settings = createDesktopSettingsIpc({
      workspaceState,
      globalState: new MemoryStateStore(),
      postToRenderer: (message) => posted.push(message),
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.GET_LATEX_CONFIG_VALUES,
      }),
    ).toBe(true);

    expect(posted.at(-1)).toEqual({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_CONFIG_VALUES,
      values: {
        workflowAutoCompile: false,
        workflowAutoCompileTimeoutMs: 30_000,
        latexdiffTimeoutMs: 5_000,
        latexdiffMathMarkup: 'fine',
        latexFormatter: 'tex-fmt',
      },
    });
  });

  it('round-trips LaTeX config writes through workspace state and refreshes the renderer', async () => {
    const { createDesktopSettingsIpc } = await loadDesktopSettingsIpc();
    const workspaceState = new MemoryStateStore();
    const posted: unknown[] = [];

    const settings = createDesktopSettingsIpc({
      workspaceState,
      globalState: new MemoryStateStore(),
      postToRenderer: (message) => posted.push(message),
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_LATEX_CONFIG_VALUE,
        field: 'latexFormatter',
        value: 'none',
      }),
    ).toBe(true);
    await Promise.resolve();

    expect(workspaceState.values.get(WorkspaceStateKey.LATEX_FORMATTER)).toBe(
      'none',
    );
    expect(posted.at(-1)).toEqual({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_CONFIG_VALUES,
      values: {
        latexFormatter: 'none',
      },
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_LATEX_CONFIG_VALUE,
        field: 'latexFormatter',
        value: null,
      }),
    ).toBe(true);
    await Promise.resolve();

    expect(workspaceState.values.get(WorkspaceStateKey.LATEX_FORMATTER)).toBe(
      undefined,
    );
    expect(workspaceState.values.has(WorkspaceStateKey.LATEX_FORMATTER)).toBe(
      false,
    );
    expect(posted.at(-1)).toEqual({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_CONFIG_VALUES,
      values: {},
    });
  });

  it('reports invalid LaTeX config writes without mutating workspace state', async () => {
    const { createDesktopSettingsIpc } = await loadDesktopSettingsIpc();
    const workspaceState = new MemoryStateStore();
    const posted: unknown[] = [];
    const errors: unknown[] = [];

    const settings = createDesktopSettingsIpc({
      workspaceState,
      globalState: new MemoryStateStore(),
      postToRenderer: (message) => posted.push(message),
      onError: (error) => errors.push(error),
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_LATEX_CONFIG_VALUE,
        field: 'latexdiffTimeoutMs',
        value: 100,
      }),
    ).toBe(true);
    await Promise.resolve();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      message: 'Invalid LaTeX config value for latexdiffTimeoutMs',
    });
    expect(
      workspaceState.values.has(WorkspaceStateKey.LATEXDIFF_TIMEOUT_MS),
    ).toBe(false);
    expect(posted).toEqual([]);
  });

  it('persists model settings through global state', async () => {
    const { createDesktopSettingsIpc } = await loadDesktopSettingsIpc();
    const workspaceState = new MemoryStateStore();
    const globalState = new MemoryStateStore();
    globalState.values.set(GlobalStateKey.ENABLED_MODELS, [
      'gpt55',
      'sonnet46T',
    ]);
    globalState.values.set(GlobalStateKey.HELPER_MODEL, 'gpt55');
    const posted: unknown[] = [];
    const errors: unknown[] = [];

    const settings = createDesktopSettingsIpc({
      workspaceState,
      globalState,
      postToRenderer: (message) => posted.push(message),
      onError: (error) => errors.push(error),
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_MODEL_ENABLED,
        modelName: 'gpt55',
        enabled: false,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(globalState.values.get(GlobalStateKey.ENABLED_MODELS)).toEqual([
      'sonnet46T',
    ]);
    expect(globalState.values.get(GlobalStateKey.HELPER_MODEL)).toBe(
      'sonnet46T',
    );
    expect(errors).toEqual([]);
    expect(
      posted.findLast(
        (message) =>
          (message as { command?: string }).command ===
          SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
      ),
    ).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
      helperModel: 'sonnet46T',
    });
    const modelOptionsMessage = posted.at(-1) as {
      command?: string;
      optionsData?: Array<{ value?: string }>;
    };
    expect(modelOptionsMessage.command).toBe('setModelOptions');
    expect(modelOptionsMessage.optionsData).toContainEqual(
      expect.objectContaining({
        value: 'sonnet46T',
      }),
    );

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_PREFER_SHORT_MODEL_NAMES,
        enabled: true,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(
      globalState.values.get(GlobalStateKey.PREFER_SHORT_MODEL_NAMES),
    ).toBe(true);
    expect(posted.at(-1)).toMatchObject({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_MODEL_SELECTION,
      preferShortModelNames: true,
    });
  });

  it('refreshes launcher agent options after agent visibility changes', async () => {
    const { createDesktopSettingsIpc } = await loadDesktopSettingsIpc();
    const workspaceState = new MemoryStateStore();
    const posted: unknown[] = [];

    const settings = createDesktopSettingsIpc({
      workspaceState,
      globalState: new MemoryStateStore(),
      loadAgents: async () => undefined,
      loadAgentOptionsData: async () => ({
        workflow: [{ value: 'builtInWorkflow:correct', label: 'correct' }],
        toolUse: [],
      }),
      postToRenderer: (message) => posted.push(message),
    });

    expect(
      settings.handleMessage({
        command: SETTINGS_VIEW_COMMANDS.SET_AGENT_ENABLED,
        category: 'workflow',
        agentSource: 'builtInWorkflow',
        agentName: 'polish',
        enabled: false,
      }),
    ).toBe(true);
    await flushAsyncWork();

    expect(workspaceState.values.get(WorkspaceStateKey.ENABLED_AGENTS)).toEqual(
      expect.not.arrayContaining(['builtInWorkflow:polish', 'polish']),
    );
    expect(
      posted.some(
        (message) =>
          (message as { command?: string }).command ===
          SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SELECTION,
      ),
    ).toBe(true);
    expect(
      posted.some(
        (message) =>
          (message as { command?: string }).command ===
          MAIN_VIEW_COMMANDS.SET_AGENT_OPTIONS,
      ),
    ).toBe(true);
  });

  it('ignores unsupported or malformed settings messages', async () => {
    const { createDesktopSettingsIpc } = await loadDesktopSettingsIpc();
    const posted: unknown[] = [];
    const settings = createDesktopSettingsIpc({
      workspaceState: new MemoryStateStore(),
      globalState: new MemoryStateStore(),
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
