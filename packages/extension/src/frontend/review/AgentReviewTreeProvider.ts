/**
 * Tree data provider for the Agent Review sidebar view: issues from the
 * latest review grouped by file, with severity icons and per-issue inline
 * actions (Fix with Agent / Dismiss) contributed via `view/item/context`.
 *
 * Stateless renderer over `AgentReviewService` — all data, including issue
 * ids, comes from the service; nothing is synthesized at render time.
 */

// Standard library imports
import * as path from 'node:path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import type { ReviewIssue, ReviewSeverity } from '@agent/review/reviewIssues';

import { AgentReviewService, issueRange } from './AgentReviewService';

export type AgentReviewNode =
  | { kind: 'file'; file: string; uri: vscode.Uri; issues: ReviewIssue[] }
  | { kind: 'issue'; issue: ReviewIssue };

const SEVERITY_ICONS: Record<ReviewSeverity, vscode.ThemeIcon> = {
  critical: new vscode.ThemeIcon(
    'error',
    new vscode.ThemeColor('problemsErrorIcon.foreground'),
  ),
  warning: new vscode.ThemeIcon(
    'warning',
    new vscode.ThemeColor('problemsWarningIcon.foreground'),
  ),
  info: new vscode.ThemeIcon(
    'info',
    new vscode.ThemeColor('problemsInfoIcon.foreground'),
  ),
};

export class AgentReviewTreeProvider
  implements vscode.TreeDataProvider<AgentReviewNode>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly subscription: vscode.Disposable;

  constructor() {
    this.subscription = AgentReviewService.onDidChange(() =>
      this.emitter.fire(),
    );
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }

  getChildren(element?: AgentReviewNode): AgentReviewNode[] {
    if (!element) {
      const byFile = new Map<string, ReviewIssue[]>();
      for (const issue of AgentReviewService.getState().issues) {
        const existing = byFile.get(issue.file) ?? [];
        existing.push(issue);
        byFile.set(issue.file, existing);
      }
      return [...byFile.entries()]
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([file, issues]) => ({
          kind: 'file',
          file,
          uri: vscode.Uri.file(AgentReviewService.issuePath(issues[0])),
          issues,
        }));
    }
    if (element.kind === 'file') {
      return element.issues.map((issue) => ({ kind: 'issue', issue }));
    }
    return [];
  }

  getTreeItem(element: AgentReviewNode): vscode.TreeItem {
    if (element.kind === 'file') {
      const item = new vscode.TreeItem(
        element.uri,
        vscode.TreeItemCollapsibleState.Expanded,
      );
      const dir = path.dirname(element.file);
      if (dir !== '.') item.description = dir;
      item.contextValue = 'texraReviewFile';
      return item;
    }

    const { issue } = element;
    const item = new vscode.TreeItem(
      issue.title,
      vscode.TreeItemCollapsibleState.None,
    );
    item.id = issue.id;
    item.description =
      issue.endLine > issue.startLine
        ? `Ln ${issue.startLine}-${issue.endLine}`
        : `Ln ${issue.startLine}`;
    item.iconPath = SEVERITY_ICONS[issue.severity];
    item.contextValue = 'texraReviewIssue';
    item.tooltip = buildTooltip(issue);
    item.command = {
      command: 'texra.agentReview.openIssue',
      title: 'Open Issue',
      arguments: [element],
    };
    return item;
  }
}

function buildTooltip(issue: ReviewIssue): vscode.MarkdownString {
  const lines = [
    `**${issue.title}** _(${issue.severity})_`,
    '',
    `\`${issue.file}:${issue.startLine}\``,
  ];
  if (issue.description) lines.push('', issue.description);
  if (issue.suggestion)
    lines.push('', `**Suggested fix:** ${issue.suggestion}`);
  return new vscode.MarkdownString(lines.join('\n'));
}

/** Reveal an issue's location in the editor. */
export async function openReviewIssue(issue: ReviewIssue): Promise<void> {
  const uri = vscode.Uri.file(AgentReviewService.issuePath(issue));
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document, {
    preview: true,
  });
  const range = issueRange(issue);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  editor.selection = new vscode.Selection(range.start, range.start);
}
