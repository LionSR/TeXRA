/**
 * "Start Agent Review on Commit": watches the built-in git extension for
 * HEAD movements on the workspace repository and triggers a review after
 * each new commit when `texra.agentReview.runOnCommit` is enabled.
 *
 * Branch switches move HEAD too, so the watcher only fires when the commit
 * changes while the branch name stays the same — checking out another
 * branch resets the baseline without reviewing.
 */

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { getGitAPI, type GitRepository } from '@frontend/git/gitExtensionTypes';
import { createLog } from '@logger/logUtils';
import { createFlushableDebounce } from '@utils/core';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { isPathWithin } from '@utils/core/pathCore';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { getConfig } from '@utils/config/configUtils';

import { AgentReviewService } from './AgentReviewService';

const log = createLog('AgentReview');
const COMMIT_DEBOUNCE_MS = 1500;

function watchRepository(
  repository: GitRepository,
  context: vscode.ExtensionContext,
  watchedRoots: Set<string>,
): void {
  // Only watch the repository containing the workspace root.
  const workspacePath = WorkspaceFS.getPath();
  if (
    !workspacePath ||
    !isPathWithin(repository.rootUri.fsPath, workspacePath)
  ) {
    return;
  }
  const repoRoot = repository.rootUri.fsPath;
  if (watchedRoots.has(repoRoot)) return;
  watchedRoots.add(repoRoot);

  let lastName = repository.state.HEAD?.name;
  let lastCommit = repository.state.HEAD?.commit;
  /** Oldest un-reviewed base while commits coalesce in the debounce window. */
  let pendingBaseRef: string | undefined;
  /** Branch name at the moment the pending review was (re)scheduled. */
  let pendingBranchName: string | undefined;

  // Fixed callback: reads the mutable pending* state above at fire time
  // rather than threading per-call args through the timer, so `schedule()`
  // rescheduling from a later commit picks up the latest branch name.
  const reviewDebounce = createFlushableDebounce(() => {
    const baseRef = pendingBaseRef;
    const name = pendingBranchName;
    pendingBaseRef = undefined;
    pendingBranchName = undefined;
    if (!baseRef) return;
    // Re-check at fire time: the user may have disabled run-on-commit
    // during the debounce window, and a review costs a model session.
    if (!getConfig<boolean>('agentReview.runOnCommit', false)) return;
    log.info(`Commit detected on ${name ?? 'HEAD'}; starting agent review`);
    void AgentReviewService.runReview('commit', {
      baseRef,
      baseDescription: `previous commit on ${name ?? 'HEAD'}`,
    });
  }, COMMIT_DEBOUNCE_MS);

  const subscription = repository.state.onDidChange(() => {
    const head = repository.state.HEAD;
    const name = head?.name;
    const commit = head?.commit;

    if (name !== lastName) {
      // Branch switch (or detach): re-baseline without reviewing, and drop
      // any review still pending from a commit on the previous branch. A
      // checkout also invalidates the reviewed change set, so stale results
      // are cleared — except on the initial state population (lastName
      // undefined), which is not a user checkout.
      reviewDebounce.cancel();
      pendingBaseRef = undefined;
      pendingBranchName = undefined;
      if (lastName !== undefined) {
        AgentReviewService.clear();
      }
      lastName = name;
      lastCommit = commit;
      return;
    }
    if (!commit || commit === lastCommit) {
      lastCommit = commit;
      return;
    }
    // An undefined→commit transition is indistinguishable from the git
    // extension lazily populating its state on workspace open, so it never
    // triggers. This also skips a repo's very first commit — acceptable, as
    // that commit has no base to diff against anyway.
    const previousCommit = lastCommit;
    lastCommit = commit;
    if (previousCommit === undefined) return;
    if (!getConfig<boolean>('agentReview.runOnCommit', false)) return;

    // Rapid commits (amend, rebase replays) coalesce into one review; keep
    // the OLDEST pending base so the combined run still covers every commit
    // since the last completed review.
    pendingBaseRef ??= previousCommit;
    pendingBranchName = name;
    reviewDebounce.schedule();
  });

  context.subscriptions.push({
    dispose: () => {
      subscription.dispose();
      // Intentionally cancel (not flush): a review still pending at dispose
      // (extension deactivation, workspace close) must not kick off a fresh
      // model session during teardown.
      reviewDebounce.cancel();
      pendingBaseRef = undefined;
      pendingBranchName = undefined;
      watchedRoots.delete(repoRoot);
    },
  });
}

/** Register the run-on-commit watcher. No-op when the git extension is unavailable. */
export function registerAgentReviewCommitWatcher(
  context: vscode.ExtensionContext,
): void {
  void (async () => {
    const git = await getGitAPI();
    if (!git) return;

    const watchedRoots = new Set<string>();
    for (const repository of git.repositories) {
      watchRepository(repository, context, watchedRoots);
    }
    context.subscriptions.push(
      git.onDidOpenRepository((repository) =>
        watchRepository(repository, context, watchedRoots),
      ),
    );
  })().catch((err: unknown) => {
    log.warn(
      `Could not watch git commits for agent review: ${toErrorMessage(err)}`,
    );
  });
}
