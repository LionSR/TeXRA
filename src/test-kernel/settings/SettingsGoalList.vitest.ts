// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { workspaceRoots } from '@platform/workspaceRoots';
import { SettingsViewMessageHandler } from '@settingsView/SettingsViewMessageHandler';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { RunId } from '@shared/schemas';
import { installedHost, setupPlatform } from '@test/support/setupPlatform';
import { GoalStore } from '@tools/goal';

// The shared vscode stub predates workspace-folder listeners; the handler's
// constructor subscribes to folder changes to re-register its history watcher.
vi.mock('vscode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vscode')>();
  return {
    ...actual,
    workspace: {
      ...actual.workspace,
      onDidChangeWorkspaceFolders: () => ({ dispose: () => {} }),
    },
  };
});

const RUN_ID = 'a5e77105' as RunId;
const GOAL_KEY = `goals:byRun:${RUN_ID}`;

/**
 * The real constructor wires channel/viewName and the history watcher from
 * the extension context; the fake context needs the subscriptions sink and
 * the global state the handler reads, and the secret store arrives beside it
 * exactly as the extension root passes it.
 */
function createHandler(): SettingsViewMessageHandler {
  const { globalState, secrets } = installedHost().platform;
  return new SettingsViewMessageHandler(
    {
      subscriptions: [],
      extensionPath: '/ext',
      globalState,
    } as unknown as vscode.ExtensionContext,
    secrets,
  );
}

function createWebview(): vscode.Webview {
  return {
    postMessage: vi.fn(async () => true),
  } as unknown as vscode.Webview;
}

/**
 * sendGoalList must report a failure through showErrorMessage and resolve
 * without throwing, never surfacing a raw rejection to the message handler.
 */
async function expectSendGoalListFailure(
  webview: vscode.Webview,
  expectedError: unknown,
): Promise<void> {
  const showErrorMessage = vi.spyOn(vscode.window, 'showErrorMessage');

  await expect(createHandler().sendGoalList(webview)).resolves.toBeUndefined();

  expect(showErrorMessage).toHaveBeenCalledWith(expectedError);
}

describe('settings goal list', () => {
  setupPlatform();

  afterEach(() => vi.restoreAllMocks());

  it('posts valid goals unchanged', async () => {
    const goal = await GoalStore.start(RUN_ID, 'Finish the settings fix.');
    const webview = createWebview();

    await createHandler().sendGoalList(webview);

    expect(webview.postMessage).toHaveBeenCalledWith({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_GOAL_LIST,
      items: [goal],
    });
  });

  it('reports a malformed goal without posting a fallback list', async () => {
    const malformed = { goalId: 'not-valid' };
    await workspaceRoots().workspaceState.update('goals:index', [RUN_ID]);
    await workspaceRoots().workspaceState.update(GOAL_KEY, malformed);
    const webview = createWebview();

    await expectSendGoalListFailure(
      webview,
      expect.stringContaining(
        `Failed to load goals: Failed to parse persisted goal for run "${RUN_ID}"`,
      ),
    );

    expect(webview.postMessage).not.toHaveBeenCalled();
    expect(workspaceRoots().workspaceState.get(GOAL_KEY)).toEqual(malformed);
  });

  it.each([
    {
      scenario: 'dropped',
      mockDelivery: (webview: vscode.Webview) =>
        vi.mocked(webview.postMessage).mockResolvedValue(false),
      error: 'Failed to load goals: settings webview is no longer available',
    },
    {
      scenario: 'rejected',
      mockDelivery: (webview: vscode.Webview) =>
        vi
          .mocked(webview.postMessage)
          .mockRejectedValue(new Error('webview disposed')),
      error: 'Failed to load goals: webview disposed',
    },
  ])(
    'reports a $scenario goal-list delivery through the same boundary',
    async ({ mockDelivery, error }) => {
      const webview = createWebview();
      mockDelivery(webview);

      await expectSendGoalListFailure(webview, error);
    },
  );
});
