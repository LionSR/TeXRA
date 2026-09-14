import * as vscode from 'vscode';

import type { TeamAvailabilityPrompt } from '@common/teams/TeamPlan';

type TeamAvailabilityChoice =
  TeamAvailabilityPrompt['actions'][number]['choice'];

/**
 * Show a `TeamAvailabilityPrompt` as a native VS Code warning and map the
 * clicked label back to its `choice`. `modal: true` (the settings flow) shows
 * one dialog button per action; `modal: false` (the launch flow) shows a
 * lighter non-modal notification with the same button labels.
 */
export async function chooseTeamAvailabilityViaDialog(
  prompt: TeamAvailabilityPrompt,
  options: { readonly modal: boolean },
): Promise<TeamAvailabilityChoice | undefined> {
  if (options.modal) {
    const items = prompt.actions.map((action) => ({
      title: action.label,
      isCloseAffordance: action.choice === 'cancel',
    }));
    const choice = await vscode.window.showWarningMessage(
      prompt.message,
      { modal: true },
      ...items,
    );
    return prompt.actions.find((action) => action.label === choice?.title)
      ?.choice;
  }
  const choice = await vscode.window.showWarningMessage(
    prompt.message,
    ...prompt.actions.map((action) => action.label),
  );
  return prompt.actions.find((action) => action.label === choice)?.choice;
}
