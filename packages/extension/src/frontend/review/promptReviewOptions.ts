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
  const approachPick = await vscode.window.showQuickPick(approachItems, {
    title: 'Agent Review — Approach',
    placeHolder: 'Choose review depth',
    prompt: 'Quick checks key suspicions (fast); Thorough reads all changed files (deeper)',
    ignoreFocusOut: true,
  });
  if (!approachPick) return undefined;

  const candidates = await listBaseBranchCandidates(cwd);
  const branchItems: BranchItem[] = [
    {
      label: '$(git-branch) Auto-detect main branch',
      detail: "Diff against the repository's main branch (recommended).",
      ref: undefined,
    },
    ...candidates.map(
      (candidate): BranchItem => ({
        label: `$(git-branch) ${candidate.ref}`,
        description: candidate.current ? 'current branch' : undefined,
        ref: candidate.ref,
      }),
    ),
  ];
  const branchPick = await vscode.window.showQuickPick(branchItems, {
    title: 'Agent Review — Diff Against',
    placeHolder: 'Choose the branch to compare against',
    prompt: 'The review will diff the current branch against the selected branch',
    ignoreFocusOut: true,
  });
  if (!branchPick) return undefined;

  return {
    userInstructions: userInstructions.trim() || undefined,
    approach: approachPick.value,
    baseBranch: branchPick.ref,
  };
}
