// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { SettingsViewMessageHandler } from '@settingsView/SettingsViewMessageHandler';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { StreamTabId } from '@shared/schemas';
import { setupPlatform } from '@test/support/setupPlatform';
import { GoalStore } from '@tools/goal';

const STREAM_ID = 'stream:settings-goal-list' as StreamTabId;
const GOAL_KEY = `goals:byStream:${STREAM_ID}`;

type GoalListHarness = Pick<SettingsViewMessageHandler, 'sendGoalList'>;

function createHandlerHarness(): GoalListHarness {
  const handler = Object.create(SettingsViewMessageHandler.prototype);
  Reflect.set(handler, 'channel', 'SettingsViewMessageHandler');
  return handler as GoalListHarness;
}

function createWebview(): vscode.Webview {
  return {
    postMessage: vi.fn(async () => true),
  } as unknown as vscode.Webview;
}

describe('settings goal list', () => {
  setupPlatform();

  afterEach(() => vi.restoreAllMocks());

  it('posts valid goals unchanged', async () => {
    const goal = await GoalStore.start(STREAM_ID, 'Finish the settings fix.');
    const webview = createWebview();

    await createHandlerHarness().sendGoalList(webview);

    expect(webview.postMessage).toHaveBeenCalledWith({
      command: SETTINGS_VIEW_COMMANDS.UPDATE_GOAL_LIST,
      items: [goal],
    });
  });

  it('reports a malformed goal without posting a fallback list', async () => {
    const { platform } = await import('@platform/platform');
    const malformed = { goalId: 'not-valid' };
    await platform().workspaceState.update('goals:index', [STREAM_ID]);
    await platform().workspaceState.update(GOAL_KEY, malformed);
    const webview = createWebview();
    const showErrorMessage = vi.spyOn(vscode.window, 'showErrorMessage');

    await expect(
      createHandlerHarness().sendGoalList(webview),
    ).resolves.toBeUndefined();

    expect(showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining(
        `Failed to load goals: Failed to parse persisted goal for stream "${STREAM_ID}"`,
      ),
    );
    expect(webview.postMessage).not.toHaveBeenCalled();
    expect(platform().workspaceState.get(GOAL_KEY)).toEqual(malformed);
  });

  it('reports goal-list delivery failures through the same boundary', async () => {
    const webview = createWebview();
    vi.mocked(webview.postMessage).mockRejectedValue(
      new Error('webview disposed'),
    );
    const showErrorMessage = vi.spyOn(vscode.window, 'showErrorMessage');

    await expect(
      createHandlerHarness().sendGoalList(webview),
    ).resolves.toBeUndefined();

    expect(showErrorMessage).toHaveBeenCalledWith(
      'Failed to load goals: webview disposed',
    );
  });
});
