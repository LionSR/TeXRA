/**
 * "Start Agent Review on Commit": watches the built-in git extension for
 * HEAD movements on the workspace repository and triggers a review after
 * each new commit when `texra.agentReview.runOnCommit` is enabled.
 *
 * Branch switches move HEAD too, so the watcher only fires when the commit
 * changes while the branch name stays the same — checking out another
 * branch resets the baseline without reviewing.
 */

// Standard library imports
import * as path from 'node:path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { toErrorMessage } from '@common/errors';
import { getGitAPI, type GitRepository } from '@frontend/git/gitExtensionTypes';
import * as logger from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files';
import { getConfig } from '@utils/config/configUtils';

import { AgentReviewService } from './AgentReviewService';

const CHANNEL = 'AgentReview';
const COMMIT_DEBOUNCE_MS = 1500;

/** True when the workspace root lives inside the repository. */
function isWorkspaceRepository(repository: GitRepository): boolean {
  const workspacePath = WorkspaceFS.getPath();
  if (!workspacePath) return false;
  const relative = path.relative(repository.rootUri.fsPath, workspacePath);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

function watchRepository(
  repository: GitRepository,
  context: vscode.ExtensionContext,
): void {
  if (!isWorkspaceRepository(repository)) return;

  let lastName = repository.state.HEAD?.name;
  let lastCommit = repository.state.HEAD?.commit;
  let debounce: NodeJS.Timeout | undefined;

  const subscription = repository.state.onDidChange(() => {
    const head = repository.state.HEAD;
    const name = head?.name;
    const commit = head?.commit;

    if (name !== lastName) {
      // Branch switch (or detach): re-baseline without reviewing.
      lastName = name;
      lastCommit = commit;
      return;
    }
    if (!commit || commit === lastCommit) {
      lastCommit = commit;
      return;
    }
    const hadCommit = lastCommit !== undefined;
    lastCommit = commit;
    if (!hadCommit) return;
    if (!getConfig<boolean>('agentReview.runOnCommit', false)) return;

    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      logger.info(
        CHANNEL,
        `Commit detected on ${name ?? 'HEAD'}; starting agent review`,
      );
      void AgentReviewService.runReview('commit');
    }, COMMIT_DEBOUNCE_MS);
  });

  context.subscriptions.push(subscription, {
    dispose: () => {
      if (debounce) clearTimeout(debounce);
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

    for (const repository of git.repositories) {
      watchRepository(repository, context);
    }
    context.subscriptions.push(
      git.onDidOpenRepository((repository) =>
        watchRepository(repository, context),
      ),
    );
  })().catch((err: unknown) => {
    logger.warn(
      CHANNEL,
      `Could not watch git commits for agent review: ${toErrorMessage(err)}`,
    );
  });
}
