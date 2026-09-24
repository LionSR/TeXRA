/**
 * Local agent review (#4063): commands and view wiring.
 *
 * Registers the Agent Review tree view, its commands (run / fix all /
 * fix / dismiss / open / clear), the editor quick-fix provider, and the
 * run-on-commit watcher. The review engine lives in `@agent/review`; UI
 * state lives in `AgentReviewService`.
 */

// Third-party imports
import { Effect } from 'effect';
import * as vscode from 'vscode';

// Local imports
import type { SessionHandle } from '@agent/runtime';
import { registerCommandEntries } from '@commands/_shared/registerCommands';
import {
  AGENT_REVIEW_VIEW_ID,
  AgentReviewService,
  issueRange,
} from '@frontend/review/AgentReviewService';
import { AgentReviewCodeActionProvider } from '@frontend/review/AgentReviewCodeActionProvider';
import { registerAgentReviewCommitWatcher } from '@frontend/review/agentReviewCommitWatcher';
import {
  AgentReviewTreeProvider,
  type AgentReviewNode,
} from '@frontend/review/AgentReviewTreeProvider';
import { promptReviewOptions } from '@frontend/review/promptReviewOptions';
import {
  showLoggedErrorMessage,
  showLoggedMessage,
} from '@frontend/ui/errorHandlingUtils';
import type { ProcessRuntime } from '@platform/processRuntime';
import { formatResultCount } from '@utils/text/stringUtils';
import { ensureError } from '@utils/errors/errorMessage';

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

async function handleOpenIssue(
  node: AgentReviewNode,
  runtime: ProcessRuntime,
): Promise<void> {
  if (node.kind !== 'issue') return;
  await runtime.runPromise(
    Effect.tryPromise({
      try: async () => {
        const uri = vscode.Uri.file(AgentReviewService.issuePath(node.issue));
        const document = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(document, {
          preview: true,
        });
        const range = issueRange(node.issue);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
        editor.selection = new vscode.Selection(range.start, range.start);
      },
      catch: ensureError,
    }).pipe(
      Effect.catch((err) =>
        showLoggedErrorMessage(
          CHANNEL,
          'Could not open review issue',
          err,
        ).pipe(Effect.asVoid),
      ),
    ),
  );
}

/** "Find Issues" split-button options: gather per-run choices, then run. */
async function handleRunWithOptions(
  session: SessionHandle,
  runtime: ProcessRuntime,
): Promise<void> {
  const cwd = session.roots.workspace;
  if (!cwd) {
    runtime.runFork(
      showLoggedMessage(
        CHANNEL,
        'Agent review needs an open workspace folder.',
      ),
    );
    return;
  }
  const options = await promptReviewOptions(cwd, runtime);
  if (!options) return; // Cancelled at one of the prompt steps.
  await AgentReviewService.runReview('manual', options);
}

export function registerAgentReviewCommands(
  context: vscode.ExtensionContext,
  runtime: ProcessRuntime,
  session: SessionHandle,
): void {
  AgentReviewService.initialize(context, runtime, session);

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
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
  );

  registerAgentReviewCommitWatcher(context, runtime, session);

  registerCommandEntries(context, [
    {
      id: 'texra.agentReview.run',
      handler: () => void AgentReviewService.runReview('manual'),
    },
    {
      id: 'texra.agentReview.runWithOptions',
      handler: () => void handleRunWithOptions(session, runtime),
    },
    {
      id: 'texra.agentReview.stop',
      handler: () => runtime.runPromise(AgentReviewService.stop()),
    },
    {
      id: 'texra.agentReview.fixAllIssues',
      handler: () => void AgentReviewService.fixIssues(),
    },
    { id: 'texra.agentReview.fixIssue', handler: handleFixIssue },
    { id: 'texra.agentReview.dismissIssue', handler: handleDismissIssue },
    {
      id: 'texra.agentReview.openIssue',
      handler: (node: AgentReviewNode) => handleOpenIssue(node, runtime),
    },
    {
      id: 'texra.agentReview.clear',
      handler: () => runtime.runPromise(AgentReviewService.clear()),
    },
  ]);
}
