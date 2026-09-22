// Test composition imports

import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { afterEach, describe, expect, vi } from 'vitest';
import * as vscode from 'vscode';

import { SettingsViewMessageHandler } from '@settingsView/SettingsViewMessageHandler';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { RunId } from '@shared/schemas';
import { testRuntime } from '@test/support/testProcessRuntime';
import { testDefaultSession } from '@test/support/defaultSessionTestSetup';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { installedHost, setupPlatform } from '@test/support/setupPlatform';
import { startGoal } from '@tools/goal';

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

/**
 * The real constructor wires channel/viewName and the history watcher from
 * the extension context; the fake context needs the subscriptions sink and
 * the global state the handler reads, and the secret store arrives beside it
 * exactly as the extension root passes it.
 */
function createHandler(): SettingsViewMessageHandler {
  const { secrets, roots } = installedHost();
  const { globalState } = roots;
  return new SettingsViewMessageHandler(
    {
      subscriptions: [],
      extensionPath: '/ext',
      globalState,
    } as unknown as vscode.ExtensionContext,
    globalState,
    secrets,
    testRuntime(),
    testDefaultSession(),
    {
      refreshCatalogs: () => Effect.void,
      refreshApiKeyStatus: Effect.void,
      refreshOnboardingFunnel: () => Effect.void,
    },
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

  await expect(
    testRuntime().runPromise(createHandler().sendGoalList(webview)),
  ).resolves.toBeUndefined();

  // The message, not the overload: the host passes VS Code's explicit
  // `MessageOptions` slot on every path now, and which overload it picks is
  // not what this test is about.
  expect(showErrorMessage.mock.calls[0]?.[0]).toBe(expectedError);
}

describe('settings goal list', () => {
  setupPlatform();

  afterEach(() => vi.restoreAllMocks());

  it.effect("posts the goal the run's row states", () =>
    Effect.gen(function* () {
      const session = testDefaultSession();
      publishTestRunStart(session, RUN_ID);
      const goal = yield* startGoal(
        session,
        RUN_ID,
        'Finish the settings fix.',
      );
      const webview = createWebview();

      yield* createHandler().sendGoalList(webview);

      // `runLabel` is the fold's `RunView.label` for this run: the fixture's
      // `run.start` names the `chat` agent, whose display name is `chat`.
      expect(webview.postMessage).toHaveBeenCalledWith({
        command: SETTINGS_VIEW_COMMANDS.UPDATE_GOAL_LIST,
        items: [{ ...goal, runLabel: 'chat' }],
      });
    }),
  );

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
