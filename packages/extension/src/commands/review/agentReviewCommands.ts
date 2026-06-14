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
import { promptReviewOptions } from '@frontend/review/promptReviewOptions';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import { setReportReviewIssueSink } from '@tools/ReportReviewIssueTool';
import { WorkspaceFS } from '@utils/files';

const CHANNEL = 'AgentReview';

/** Mirror of the sidebar review tree contributed into the Source Control panel. */
const SCM_AGENT_REVIEW_VIEW_ID = 'texra.scmAgentReviewView';

const agentReviewCommands = {
  run: 'texra.agentReview.run',
  runWithOptions: 'texra.agentReview.runWithOptions',
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

/** "Find Issues" split-button options: gather per-run choices, then run. */
async function handleRunWithOptions(): Promise<void> {
  const cwd = WorkspaceFS.getPath();
  if (!cwd) {
    void vscode.window.showErrorMessage(
      'Agent review needs an open workspace folder.',
    );
    return;
  }
  const options = await promptReviewOptions(cwd);
  if (!options) return; // Cancelled at one of the QuickPick steps.
  await AgentReviewService.runReview('manual', options);
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

  // One provider backs both surfaces: the TeXRA sidebar tree and a mirror in
  // VS Code's Source Control panel (GitKraken/Cursor-style). Tree item ids are
  // per-view, so sharing the provider is safe.
  const treeProvider = new AgentReviewTreeProvider();
  const treeViews = [
    vscode.window.createTreeView(AGENT_REVIEW_VIEW_ID, {
      treeDataProvider: treeProvider,
    }),
    vscode.window.createTreeView(SCM_AGENT_REVIEW_VIEW_ID, {
      treeDataProvider: treeProvider,
    }),
  ];
  const syncView = () => {
    const state = AgentReviewService.getState();
    const count = state.issues.length;
    const badge =
      count > 0
        ? {
            value: count,
            tooltip: `${count} agent review issue${count === 1 ? '' : 's'}`,
          }
        : undefined;
    for (const view of treeViews) {
      view.message = state.summary;
      view.badge = badge;
    }
  };
  syncView();
  context.subscriptions.push(
    treeProvider,
    ...treeViews,
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
      id: agentReviewCommands.runWithOptions,
      handler: () => void handleRunWithOptions(),
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
