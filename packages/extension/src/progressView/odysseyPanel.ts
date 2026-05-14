/**
 * Native VS Code UI for the Odyssey toggle button on the stream header.
 *
 * Uses `showInputBox` and `showQuickPick` — no webview-side popover yet
 * (a richer Lit popover lives behind the Settings → Odyssey tab in a
 * follow-up). This keeps the MVP focused on the actual user flow:
 * start an objective, then manage it.
 */
import * as vscode from 'vscode';

import { platform } from '@platform/platform';
import type { StreamTabId } from '@shared/schemas';
import {
  ODYSSEY_FEATURE_FLAG_KEY,
  OdysseyStore,
  type Odyssey,
} from '@tools/odyssey';

const OBJECTIVE_PLACEHOLDER =
  'Complete X until Y holds. Be specific about the stopping condition.';

async function promptForObjective(
  initial?: string,
): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt: 'Objective for the Odyssey',
    placeHolder: OBJECTIVE_PLACEHOLDER,
    value: initial,
    ignoreFocusOut: true,
    validateInput: (value) =>
      value.trim().length === 0
        ? 'Objective cannot be empty.'
        : value.trim().length < 10
          ? 'Phrase the objective with a verifiable stopping condition.'
          : undefined,
  });
}

async function startNewOdyssey(streamId: StreamTabId): Promise<void> {
  const objective = await promptForObjective();
  if (!objective) return;
  try {
    await OdysseyStore.start(streamId, objective);
    await vscode.window.showInformationMessage(
      'Odyssey started. The agent will keep working toward this objective ' +
        'until it calls odyssey(complete) or you abandon it.',
    );
  } catch (err) {
    await vscode.window.showErrorMessage(
      `Failed to start Odyssey: ${(err as Error).message}`,
    );
  }
}

async function manageActiveOdyssey(
  streamId: StreamTabId,
  odyssey: Odyssey,
): Promise<void> {
  const actions: Array<vscode.QuickPickItem & { id: string }> =
    odyssey.status === 'active'
      ? [
          {
            id: 'edit',
            label: 'Edit objective',
            description: 'Update the goal mid-flight',
          },
          {
            id: 'pause',
            label: 'Pause',
            description: 'Stop continuation until resumed',
          },
          { id: 'abandon', label: 'Abandon', description: 'End the Odyssey' },
        ]
      : odyssey.status === 'paused'
        ? [
            {
              id: 'resume',
              label: 'Resume',
              description: 'Re-enable continuation',
            },
            {
              id: 'edit',
              label: 'Edit objective',
              description: 'Update the goal',
            },
            { id: 'abandon', label: 'Abandon', description: 'End the Odyssey' },
          ]
        : [
            {
              id: 'restart',
              label: 'Start a new Odyssey',
              description: 'Replaces this record',
            },
          ];

  const picked = await vscode.window.showQuickPick(actions, {
    title: `Odyssey · ${odyssey.status}`,
    placeHolder: odyssey.objective,
  });
  if (!picked) return;

  switch (picked.id) {
    case 'edit': {
      const next = await promptForObjective(odyssey.objective);
      if (!next) return;
      await OdysseyStore.editObjective(streamId, next);
      await vscode.window.showInformationMessage('Odyssey objective updated.');
      return;
    }
    case 'pause': {
      await OdysseyStore.setStatus(streamId, 'paused', 'paused by user');
      await vscode.window.showInformationMessage('Odyssey paused.');
      return;
    }
    case 'resume': {
      await OdysseyStore.setStatus(streamId, 'active', 'resumed by user');
      await vscode.window.showInformationMessage('Odyssey resumed.');
      return;
    }
    case 'abandon': {
      const confirm = await vscode.window.showWarningMessage(
        'Abandon this Odyssey? The objective will be cleared.',
        { modal: true },
        'Abandon',
      );
      if (confirm !== 'Abandon') return;
      await OdysseyStore.setStatus(streamId, 'abandoned', 'abandoned by user');
      await vscode.window.showInformationMessage('Odyssey abandoned.');
      return;
    }
    case 'restart': {
      const objective = await promptForObjective();
      if (!objective) return;
      await OdysseyStore.forget(streamId);
      await OdysseyStore.start(streamId, objective);
      await vscode.window.showInformationMessage('New Odyssey started.');
      return;
    }
  }
}

export async function handleOpenOdysseyPanel(
  streamId: StreamTabId,
): Promise<void> {
  if (!platform().config.get<boolean>(ODYSSEY_FEATURE_FLAG_KEY, false)) {
    await vscode.window.showInformationMessage(
      `Odyssey is experimental. Enable "${ODYSSEY_FEATURE_FLAG_KEY}" in ` +
        'settings to use it.',
    );
    return;
  }
  const existing = OdysseyStore.getForStream(streamId);
  if (!existing) {
    await startNewOdyssey(streamId);
    return;
  }
  await manageActiveOdyssey(streamId, existing);
}
