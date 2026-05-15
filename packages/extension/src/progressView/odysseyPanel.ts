/**
 * Native VS Code UI for the Odyssey toggle button on the stream header.
 *
 * No record yet  → `showInputBox` to collect an objective.
 * Record exists → `showQuickPick` listing the legal actions for the
 *                  current status (edit / pause / resume / abandon /
 *                  restart). The quick-pick is the cheapest way to get
 *                  pause/resume/abandon working without a Lit popover;
 *                  a richer in-webview UI ships when the Settings tab
 *                  lands.
 */
import * as vscode from 'vscode';

import { platform } from '@platform/platform';
import { buildObjectiveUpdatedFollowUp } from '@agent/odyssey';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import type { StreamTabId } from '@shared/schemas';
import {
  ODYSSEY_FEATURE_FLAG_KEY,
  OdysseyStore,
  type Odyssey,
  type OdysseyStatus,
} from '@tools/odyssey';

import type { WebviewUpdater } from './managers/WebviewUpdater';

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
      value.trim().length < 10
        ? 'Phrase the objective with a verifiable stopping condition.'
        : undefined,
  });
}

function broadcastActive(
  webviewUpdater: WebviewUpdater | null,
  streamId: StreamTabId,
): void {
  if (!webviewUpdater) return;
  const odyssey = OdysseyStore.getForStream(streamId);
  webviewUpdater.updateOdysseyActive(
    streamId,
    odyssey?.status === 'active' || odyssey?.status === 'paused',
  );
}

interface Action {
  id: string;
  label: string;
  /** Statuses the action is available for. */
  in: readonly OdysseyStatus[];
  run: (streamId: StreamTabId, odyssey: Odyssey) => Promise<string | undefined>;
}

const ACTIONS: readonly Action[] = [
  {
    id: 'edit',
    label: 'Edit objective',
    in: ['active', 'paused'],
    run: async (streamId, odyssey) => {
      const next = await promptForObjective(odyssey.objective);
      if (!next) return;
      const updated = await OdysseyStore.editObjective(streamId, next);
      try {
        ToolUseFollowUpQueue.enqueue(
          streamId,
          await buildObjectiveUpdatedFollowUp(updated),
        );
      } catch {
        /* queue may be unavailable; user can resend objective manually */
      }
      return 'Odyssey objective updated.';
    },
  },
  {
    id: 'pause',
    label: 'Pause',
    in: ['active'],
    run: async (streamId) => {
      await OdysseyStore.setStatus(streamId, 'paused', 'paused by user');
      return 'Odyssey paused.';
    },
  },
  {
    id: 'resume',
    label: 'Resume',
    in: ['paused'],
    run: async (streamId) => {
      await OdysseyStore.setStatus(streamId, 'active', 'resumed by user');
      return 'Odyssey resumed.';
    },
  },
  {
    id: 'abandon',
    label: 'Abandon',
    in: ['active', 'paused'],
    run: async (streamId) => {
      const confirm = await vscode.window.showWarningMessage(
        'Abandon this Odyssey? The objective will be cleared.',
        { modal: true },
        'Abandon',
      );
      if (confirm !== 'Abandon') return;
      await OdysseyStore.setStatus(streamId, 'abandoned', 'abandoned by user');
      return 'Odyssey abandoned.';
    },
  },
  {
    id: 'restart',
    label: 'Start a new Odyssey',
    in: ['complete', 'abandoned'],
    run: async (streamId) => {
      const objective = await promptForObjective();
      if (!objective) return;
      await OdysseyStore.forget(streamId);
      await OdysseyStore.start(streamId, objective);
      return 'New Odyssey started.';
    },
  },
];

async function manageOdyssey(
  streamId: StreamTabId,
  odyssey: Odyssey,
  webviewUpdater: WebviewUpdater | null,
): Promise<void> {
  const choices = ACTIONS.filter((a) => a.in.includes(odyssey.status));
  const picked = await vscode.window.showQuickPick(choices, {
    title: `Odyssey · ${odyssey.status}`,
    placeHolder: odyssey.objective,
  });
  if (!picked) return;
  const message = await picked.run(streamId, odyssey);
  broadcastActive(webviewUpdater, streamId);
  if (message) await vscode.window.showInformationMessage(message);
}

export async function handleOpenOdysseyPanel(
  streamId: StreamTabId,
  webviewUpdater: WebviewUpdater | null = null,
): Promise<void> {
  if (!platform().config.get<boolean>(ODYSSEY_FEATURE_FLAG_KEY, false)) {
    await vscode.window.showInformationMessage(
      `Odyssey is experimental. Enable "${ODYSSEY_FEATURE_FLAG_KEY}" in settings to use it.`,
    );
    return;
  }
  const existing = OdysseyStore.getForStream(streamId);
  if (!existing) {
    const objective = await promptForObjective();
    if (!objective) return;
    try {
      await OdysseyStore.start(streamId, objective);
      broadcastActive(webviewUpdater, streamId);
      await vscode.window.showInformationMessage(
        'Odyssey started. The agent will keep working toward this objective ' +
          'until it calls odyssey(complete) or you abandon it.',
      );
    } catch (err) {
      await vscode.window.showErrorMessage(
        `Failed to start Odyssey: ${(err as Error).message}`,
      );
    }
    return;
  }
  await manageOdyssey(streamId, existing, webviewUpdater);
}
