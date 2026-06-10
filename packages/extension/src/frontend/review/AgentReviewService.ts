/**
 * Agent review state for the VS Code extension: holds the issues found by
 * the latest run, publishes them as diagnostics (Problems panel + editor
 * squiggles), and launches the fixing tool-use agent.
 *
 * The host-neutral engine lives in `@agent/review`; this service owns the
 * VS Code-facing side — configuration, progress UI, diagnostics, and the
 * change event the tree view and code actions subscribe to.
 */

// Standard library imports
import * as path from 'node:path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import {
  runAgentReview,
  type AgentReviewOutcome,
} from '@agent/review/runAgentReview';
import {
  buildFixInstruction,
  type ReviewApproach,
  type ReviewIssue,
  type ReviewSeverity,
} from '@agent/review/reviewIssues';
import { safeExecuteCommand } from '@frontend/system/commandUtils';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import * as logger from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files';
import { getConfig } from '@utils/config/configUtils';

const CHANNEL = 'AgentReview';
const COLLECTION_NAME = 'texra-agent-review';
const SOURCE_LABEL = 'TeXRA Agent Review';
/** Tool-use agent used for "Fix with Agent" — a general surgical editor. */
const FIX_AGENT = 'coder';

export const AGENT_REVIEW_VIEW_ID = 'texra.agentReviewView';

type AgentReviewTrigger = 'manual' | 'commit';

interface AgentReviewStateSnapshot {
  running: boolean;
  issues: readonly ReviewIssue[];
  /** Status line shown above the tree (result summary or failure). */
  summary: string | undefined;
}

const SEVERITY_MAP: Record<ReviewSeverity, vscode.DiagnosticSeverity> = {
  critical: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

/** Editor range for an issue (model lines are 1-based). */
export function issueRange(issue: ReviewIssue): vscode.Range {
  const startLine = Math.max(0, issue.startLine - 1);
  const endLine = Math.max(startLine, issue.endLine - 1);
  return new vscode.Range(startLine, 0, endLine, Number.MAX_SAFE_INTEGER);
}

class AgentReviewServiceImpl {
  private collection: vscode.DiagnosticCollection | undefined;
  private readonly emitter = new vscode.EventEmitter<void>();
  /** Fires whenever issues, run status, or the summary change. */
  readonly onDidChange = this.emitter.event;

  private issues: ReviewIssue[] = [];
  /** `file::title` fingerprints of dismissed issues, kept for the session so re-reviews don't resurrect them. */
  private readonly dismissed = new Set<string>();
  private running = false;
  private summary: string | undefined;
  /** Workspace root the current issues were reviewed in. */
  private reviewRoot: string | undefined;
  private baseDescription = 'main branch';

  initialize(context: vscode.ExtensionContext): void {
    this.collection =
      vscode.languages.createDiagnosticCollection(COLLECTION_NAME);
    context.subscriptions.push(this.collection, this.emitter);
  }

  getState(): AgentReviewStateSnapshot {
    return {
      running: this.running,
      issues: this.issues,
      summary: this.summary,
    };
  }

  getIssue(id: string): ReviewIssue | undefined {
    return this.issues.find((issue) => issue.id === id);
  }

  /** Absolute path of the file an issue refers to. */
  issuePath(issue: ReviewIssue): string {
    return path.join(this.reviewRoot ?? '', issue.file);
  }

  getIssuesForUri(uri: vscode.Uri): ReviewIssue[] {
    if (!this.reviewRoot) return [];
    return this.issues.filter(
      (issue) => path.resolve(this.issuePath(issue)) === uri.fsPath,
    );
  }

  /** Run a review of the working tree against the main branch. */
  async runReview(trigger: AgentReviewTrigger): Promise<void> {
    if (this.running) {
      if (trigger === 'manual') {
        void vscode.window.showInformationMessage(
          'An agent review is already running.',
        );
      }
      return;
    }
    const cwd = WorkspaceFS.getPath();
    if (!cwd) {
      if (trigger === 'manual') {
        void vscode.window.showErrorMessage(
          'Agent review needs an open workspace folder.',
        );
      }
      return;
    }

    this.running = true;
    this.summary = 'Reviewing changes…';
    await this.syncContextKeys();
    this.emitter.fire();

    try {
      const outcome = await vscode.window.withProgress(
        {
          location: { viewId: AGENT_REVIEW_VIEW_ID },
          title: 'Agent review',
        },
        () =>
          runAgentReview({
            cwd,
            includeUntracked: getConfig<boolean>(
              'agentReview.includeUntrackedFiles',
              true,
            ),
            includeSubmodules: getConfig<boolean>(
              'agentReview.includeSubmodules',
              true,
            ),
            approach: getConfig<ReviewApproach>(
              'agentReview.approach',
              'quick',
            ),
            modelOverride:
              getConfig<string>('agentReview.model', '').trim() || undefined,
          }),
      );
      this.reviewRoot = cwd;
      this.applyOutcome(outcome, trigger);
    } finally {
      this.running = false;
      await this.syncContextKeys();
      this.emitter.fire();
    }
  }

  private applyOutcome(
    outcome: AgentReviewOutcome,
    trigger: AgentReviewTrigger,
  ): void {
    switch (outcome.status) {
      case 'ok': {
        this.baseDescription = outcome.baseDescription;
        this.issues = outcome.issues.filter(
          (issue) => !this.dismissed.has(fingerprint(issue)),
        );
        const count = this.issues.length;
        this.summary =
          count === 0
            ? `No issues found (diff with ${outcome.baseDescription})`
            : `Found ${count} potential issue${count === 1 ? '' : 's'} (diff with ${outcome.baseDescription})${outcome.truncated ? ' · diff truncated' : ''}`;
        logger.info(
          CHANNEL,
          `Agent review (${trigger}) with ${outcome.modelName}: ${count} issue(s) across ${outcome.changedFileCount} changed file(s)`,
        );
        break;
      }
      case 'no-changes': {
        this.issues = [];
        this.summary = `No changes to review (working tree matches ${outcome.baseDescription})`;
        break;
      }
      case 'error': {
        // Keep any previous issues; a failed re-run shouldn't erase results.
        this.summary = `Review failed: ${outcome.reason}`;
        if (trigger === 'manual') {
          void showLoggedErrorMessage(
            CHANNEL,
            'Agent review failed',
            outcome.reason,
          );
        } else {
          logger.warn(CHANNEL, `Agent review failed: ${outcome.reason}`);
        }
        break;
      }
    }
    this.updateDiagnostics();
  }

  dismissIssue(id: string): void {
    const issue = this.getIssue(id);
    if (!issue) return;
    this.dismissed.add(fingerprint(issue));
    this.issues = this.issues.filter((entry) => entry.id !== id);
    this.updateDiagnostics();
    void this.syncContextKeys();
    this.emitter.fire();
  }

  /** Clear results and forget dismissals. */
  clear(): void {
    this.issues = [];
    this.dismissed.clear();
    this.summary = undefined;
    this.updateDiagnostics();
    void this.syncContextKeys();
    this.emitter.fire();
  }

  /**
   * Launch the fixing tool-use agent for the given issues (all current
   * issues when no ids are passed — "Fix All Issues").
   */
  async fixIssues(ids?: readonly string[]): Promise<void> {
    const targets = ids
      ? this.issues.filter((issue) => ids.includes(issue.id))
      : [...this.issues];
    if (targets.length === 0) {
      void vscode.window.showInformationMessage(
        'No agent review issues to fix.',
      );
      return;
    }

    const instruction = buildFixInstruction(targets, this.baseDescription);
    await safeExecuteCommand(
      'texra.execute',
      [{ agent: FIX_AGENT, instruction }],
      CHANNEL,
    );
    void vscode.window.showInformationMessage(
      `Launched the ${FIX_AGENT} agent to fix ${targets.length} review issue${targets.length === 1 ? '' : 's'}. Run the review again once it finishes.`,
    );
  }

  private updateDiagnostics(): void {
    if (!this.collection) return;
    this.collection.clear();
    if (!this.reviewRoot) return;

    const byFile = new Map<string, vscode.Diagnostic[]>();
    for (const issue of this.issues) {
      const message = issue.description
        ? `${issue.title}: ${issue.description}`
        : issue.title;
      const diagnostic = new vscode.Diagnostic(
        issueRange(issue),
        message,
        SEVERITY_MAP[issue.severity],
      );
      diagnostic.source = SOURCE_LABEL;
      diagnostic.code = issue.id;
      const filePath = this.issuePath(issue);
      const existing = byFile.get(filePath) ?? [];
      existing.push(diagnostic);
      byFile.set(filePath, existing);
    }
    for (const [filePath, diagnostics] of byFile) {
      this.collection.set(vscode.Uri.file(filePath), diagnostics);
    }
  }

  private async syncContextKeys(): Promise<void> {
    await vscode.commands.executeCommand(
      'setContext',
      'texra.agentReview.running',
      this.running,
    );
    await vscode.commands.executeCommand(
      'setContext',
      'texra.agentReview.hasIssues',
      this.issues.length > 0,
    );
  }
}

function fingerprint(issue: ReviewIssue): string {
  return `${issue.file}::${issue.title.toLowerCase()}`;
}

/** Singleton service backing the Agent Review view, diagnostics, and commands. */
export const AgentReviewService = new AgentReviewServiceImpl();
