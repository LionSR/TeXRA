/**
 * Per-run options prompt for the "Find Issues" agent review.
 *
 * Mirrors the GitKraken/Cursor "Find Issues" popover with native VS Code
 * QuickPicks: an optional free-text focus, the review approach, and the
 * branch to diff against. Returns the gathered options, or `undefined` when
 * the user cancels at any step (Escape).
 */

// Third-party imports
import * as vscode from 'vscode';
import { z } from 'zod';

// Local imports
import { listBaseBranchCandidates } from '@agent/review/reviewDiff';
import type { ReviewApproach } from '@agent/review/reviewIssues';
import { settleQuickInput } from '@commands/_shared/quickInputUtils';
import { AGENT_REVIEW_APPROACHES } from '@shared/schemas/coreSettings';
import { getValidatedConfig } from '@utils/config/configUtils';

export interface ReviewOptions {
  /** Free-text focus for the reviewer; omitted when left blank. */
  userInstructions?: string;
  /** Per-run approach override. */
  approach: ReviewApproach;
  /** Branch to diff against; omitted to auto-detect the main branch. */
  baseBranch?: string;
}

interface ApproachItem extends vscode.QuickPickItem {
  value: ReviewApproach;
}

interface BranchItem extends vscode.QuickPickItem {
  /** Ref to diff against; `undefined` for the auto-detect default. */
  ref: string | undefined;
}

const APPROACH_PROMPT_HINT =
  'Quick checks key suspicions (fast); Thorough reads all changed files (deeper)';
const BRANCH_PROMPT_HINT =
  'The review will diff the current branch against the selected branch';

/**
 * Show a single-select QuickPick that honors Escape (resolves `undefined`).
 * The first item is pre-selected so Enter accepts the default.
 */
function pickFromQuickPick<T extends vscode.QuickPickItem>(config: {
  title: string;
  placeholder: string;
  items: T[];
  prompt: string;
  defaultButton?: vscode.QuickInputButton;
}): Promise<T | undefined> {
  const { title, placeholder, items, prompt, defaultButton } = config;
  const qp = vscode.window.createQuickPick<T>();
  qp.title = title;
  qp.placeholder = placeholder;
  qp.ignoreFocusOut = true;
  qp.items = items;
  qp.activeItems = [items[0]];
  qp.prompt = prompt;
  if (defaultButton) qp.buttons = [defaultButton];
  return settleQuickInput(qp, (accept) => {
    if (defaultButton) {
      qp.onDidTriggerButton((button) => {
        if (button === defaultButton) accept(items[0]);
      });
    }
    qp.onDidAccept(() => accept(qp.activeItems[0] ?? qp.selectedItems[0]));
  });
}

/**
 * Drive the three-step QuickPick flow. Each step honors Escape: returning
 * `undefined` from any prompt cancels the whole run, so a half-configured
 * review never starts.
 */
export async function promptReviewOptions(
  cwd: string,
): Promise<ReviewOptions | undefined> {
  const userInstructions = await vscode.window.showInputBox({
    title: 'Agent Review — Optional Instructions',
    prompt: 'Focus the review (optional). Leave blank for a general review.',
    placeHolder: 'e.g. Focus on error handling and concurrency',
    ignoreFocusOut: true,
  });
  // Escape returns undefined; an empty submission returns "".
  if (userInstructions === undefined) return undefined;

  const currentApproach = getValidatedConfig(
    'agentReview.approach',
    z.enum(AGENT_REVIEW_APPROACHES),
    'quick',
  );
  const quickItem: ApproachItem = {
    label: 'Quick',
    detail: 'Verify only the strongest suspicions with tools — fast and cheap.',
    value: 'quick',
  };
  const thoroughItem: ApproachItem = {
    label: 'Thorough',
    detail:
      'Read every changed file, check callers, and pull diagnostics — deeper, higher cost.',
    value: 'thorough',
  };
  // List the configured default first so Enter keeps the current behavior.
  const approachItems =
    currentApproach === 'thorough'
      ? [thoroughItem, quickItem]
      : [quickItem, thoroughItem];
  const trimmedInstructions = userInstructions.trim();
  // Echo the step-1 focus text when present; otherwise keep the original
  // approach explanation visible.
  const approachPick = await pickFromQuickPick({
    title: 'Agent Review — Approach',
    placeholder: 'Choose review depth',
    items: approachItems,
    prompt: trimmedInstructions
      ? `Focus: ${trimmedInstructions}`
      : APPROACH_PROMPT_HINT,
  });
  if (!approachPick) return undefined;

  const candidates = await listBaseBranchCandidates(cwd);
  const branchItems: BranchItem[] = [
    {
      label: '$(git-branch) Auto-detect main branch',
      detail: "Diff against the repository's main branch (recommended).",
      ref: undefined,
    },
    ...candidates.map((candidate): BranchItem => ({
      label: `$(git-branch) ${candidate.ref}`,
      description: candidate.current ? 'current branch' : undefined,
      ref: candidate.ref,
    })),
  ];
  // Offer a one-click "use auto-detect" since most runs take the default.
  const useDefaultButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('check'),
    tooltip: 'Use auto-detect (skip)',
  };
  const branchPick = await pickFromQuickPick({
    title: 'Agent Review — Diff Against',
    placeholder: 'Choose the branch to compare against',
    items: branchItems,
    prompt: BRANCH_PROMPT_HINT,
    defaultButton: useDefaultButton,
  });
  if (!branchPick) return undefined;

  return {
    userInstructions: userInstructions.trim() || undefined,
    approach: approachPick.value,
    baseBranch: branchPick.ref,
  };
}
