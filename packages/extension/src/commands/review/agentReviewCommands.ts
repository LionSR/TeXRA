/**
 * Local agent review (#4063): commands and view wiring.
 *
 * Registers the Agent Review tree view, its commands (run / fix all /
 * fix / dismiss / open / clear), the editor quick-fix provider, and the
 * run-on-commit watcher. The review engine lives in `@agent/review`; UI
 * state lives in `AgentReviewService`.
 */

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { registerCommandEntries } from '@commands/_shared/registerCommands';
import {
  AGENT_REVIEW_VIEW_ID,
  AgentReviewService,
} from '@frontend/review/AgentReviewService';
import {
  AGENT_REVIEW_CODE_ACTION_METADATA,
  AgentReviewCodeActionProvider,
} from '@frontend/review/AgentReviewCodeActionProvider';
import { registerAgentReviewCommitWatcher } from '@frontend/review/agentReviewCommitWatcher';
import {
  AgentReviewTreeProvider,
  openReviewIssue,
  type AgentReviewNode,
} from '@frontend/review/AgentReviewTreeProvider';
import { promptReviewOptions } from '@frontend/review/promptReviewOptions';
import {
  showLoggedErrorMessage,
  showLoggedMessage,
} from '@frontend/ui/errorHandlingUtils';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { formatResultCount } from '@utils/text/stringUtils';

const CHANNEL = 'AgentReview';

/** Inline tree actions receive the tree node; code actions pass the issue id. */
function resolveIssueId(arg: unknown): string | undefined {
  if (typeof arg === 'string') return arg;
  const node = arg as AgentReviewNode | undefined;
  return node?.kind === 'issue' ? node.issue.id : undefined;
}

async function handleFixIssue(arg: unknown): Promise<void> {
  const id = resolveIssueId(arg);
  if (!id) return;
  await AgentReviewService.fixIssues([id]);
}

function handleDismissIssue(arg: unknown): void {
  const id = resolveIssueId(arg);
  if (!id) return;
  AgentReviewService.dismissIssue(id);
}

async function handleOpenIssue(node: AgentReviewNode): Promise<void> {
  if (node.kind !== 'issue') return;
  try {
    await openReviewIssue(node.issue);
  } catch (err) {
    await showLoggedErrorMessage(CHANNEL, 'Could not open review issue', err);
  }
}

/** "Find Issues" split-button options: gather per-run choices, then run. */
async function handleRunWithOptions(): Promise<void> {
  const cwd = WorkspaceFS.getPath();
  if (!cwd) {
    void showLoggedMessage(
      CHANNEL,
      'Agent review needs an open workspace folder.',
    );
    return;
  }
  const options = await promptReviewOptions(cwd);
  if (!options) return; // Cancelled at one of the prompt steps.
  await AgentReviewService.runReview('manual', options);
}

export function registerAgentReviewCommands(
  context: vscode.ExtensionContext,
): void {
  AgentReviewService.initialize(context);

  // The Agent Review tree lives in VS Code's Source Control (git) panel,
  // GitKraken/Cursor-style.
  const treeProvider = new AgentReviewTreeProvider();
  const treeView = vscode.window.createTreeView(AGENT_REVIEW_VIEW_ID, {
    treeDataProvider: treeProvider,
  });
  const syncView = () => {
    const state = AgentReviewService.getState();
    const count = state.issues.length;
    treeView.message = state.summary;
    treeView.badge =
      count > 0
        ? {
            value: count,
            tooltip: formatResultCount(count, 'agent review issue'),
          }
        : undefined;
  };
  syncView();
  context.subscriptions.push(
    treeProvider,
    treeView,
    AgentReviewService.onDidChange(syncView),
    vscode.languages.registerCodeActionsProvider(
      { scheme: 'file' },
      new AgentReviewCodeActionProvider(),
      AGENT_REVIEW_CODE_ACTION_METADATA,
    ),
  );

  registerAgentReviewCommitWatcher(context);

  registerCommandEntries(context, [
    {
      id: 'texra.agentReview.run',
      handler: () => void AgentReviewService.runReview('manual'),
    },
    {
      id: 'texra.agentReview.runWithOptions',
      handler: () => void handleRunWithOptions(),
    },
    {
      id: 'texra.agentReview.stop',
      handler: () => AgentReviewService.stop(),
    },
    {
      id: 'texra.agentReview.fixAllIssues',
      handler: () => void AgentReviewService.fixIssues(),
    },
    { id: 'texra.agentReview.fixIssue', handler: handleFixIssue },
    { id: 'texra.agentReview.dismissIssue', handler: handleDismissIssue },
    { id: 'texra.agentReview.openIssue', handler: handleOpenIssue },
    {
      id: 'texra.agentReview.clear',
      handler: () => AgentReviewService.clear(),
    },
  ]);
}
