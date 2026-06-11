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
import { registerCommands } from '@commands/_shared/registerCommands';
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
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { setReportReviewIssueSink } from '@tools/ReportReviewIssueTool';

const CHANNEL = 'AgentReview';

const agentReviewCommands = {
  run: 'texra.agentReview.run',
  fixAll: 'texra.agentReview.fixAllIssues',
  fixIssue: 'texra.agentReview.fixIssue',
  dismissIssue: 'texra.agentReview.dismissIssue',
  openIssue: 'texra.agentReview.openIssue',
  clear: 'texra.agentReview.clear',
};

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

export function registerAgentReviewCommands(
  context: vscode.ExtensionContext,
): void {
  AgentReviewService.initialize(context);
  // Findings from the changeReviewer tool-use session flow in through the
  // report_review_issue tool and land in the panel + diagnostics live.
  setReportReviewIssueSink((report) =>
    AgentReviewService.addIssueReport(report),
  );

  const treeProvider = new AgentReviewTreeProvider();
  const treeView = vscode.window.createTreeView(AGENT_REVIEW_VIEW_ID, {
    treeDataProvider: treeProvider,
  });
  const syncView = () => {
    const state = AgentReviewService.getState();
    treeView.message = state.summary;
    treeView.badge =
      state.issues.length > 0
        ? {
            value: state.issues.length,
            tooltip: `${state.issues.length} agent review issue${state.issues.length === 1 ? '' : 's'}`,
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

  registerCommands(context, [
    {
      id: agentReviewCommands.run,
      handler: () => void AgentReviewService.runReview('manual'),
    },
    {
      id: agentReviewCommands.fixAll,
      handler: () => void AgentReviewService.fixIssues(),
    },
    { id: agentReviewCommands.fixIssue, handler: handleFixIssue },
    { id: agentReviewCommands.dismissIssue, handler: handleDismissIssue },
    { id: agentReviewCommands.openIssue, handler: handleOpenIssue },
    {
      id: agentReviewCommands.clear,
      handler: () => AgentReviewService.clear(),
    },
  ]);
}
