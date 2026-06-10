/**
 * Quick fixes for agent review diagnostics: lightbulb actions in the
 * editor ("Fix with TeXRA Agent" / "Dismiss") on the squiggles published
 * by `AgentReviewService` — the LSP-style surface of the review feature.
 */

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { AgentReviewService, issueRange } from './AgentReviewService';

export const AGENT_REVIEW_CODE_ACTION_METADATA: vscode.CodeActionProviderMetadata =
  {
    providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
  };

export class AgentReviewCodeActionProvider
  implements vscode.CodeActionProvider
{
  provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const issues = AgentReviewService.getIssuesForUri(document.uri).filter(
      (issue) => issueRange(issue).intersection(range) !== undefined,
    );

    return issues.flatMap((issue) => {
      const diagnostics = context.diagnostics.filter(
        (diagnostic) => diagnostic.code === issue.id,
      );

      const fix = new vscode.CodeAction(
        `Fix with TeXRA agent: ${issue.title}`,
        vscode.CodeActionKind.QuickFix,
      );
      fix.command = {
        command: 'texra.agentReview.fixIssue',
        title: 'Fix with Agent',
        arguments: [issue.id],
      };
      fix.diagnostics = diagnostics;

      const dismiss = new vscode.CodeAction(
        `Dismiss TeXRA review issue: ${issue.title}`,
        vscode.CodeActionKind.QuickFix,
      );
      dismiss.command = {
        command: 'texra.agentReview.dismissIssue',
        title: 'Dismiss Issue',
        arguments: [issue.id],
      };
      dismiss.diagnostics = diagnostics;

      return [fix, dismiss];
    });
  }
}
