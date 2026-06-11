/**
 * Agent review state for the VS Code extension.
 *
 * A review runs as a full `changeReviewer` tool-use agent session (launched
 * through `texra.execute`): the service collects the diff against the main
 * branch, hands it to the agent, and receives findings live through the
 * `report_review_issue` tool sink. Issues are published as diagnostics
 * (Problems panel + editor squiggles) and drive the Agent Review tree view;
 * "Fix with Agent" hands them to the file-editing `coder` agent.
 */

// Standard library imports
import * as path from 'node:path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { collectReviewDiff, isPathInChangeSet } from '@agent/review/reviewDiff';
import {
  buildFixInstruction,
  buildReviewInstruction,
  createReviewIssue,
  type ReviewApproach,
  type ReviewIssue,
  type ReviewIssueReport,
  type ReviewSeverity,
} from '@agent/review/reviewIssues';
import { toErrorMessage } from '@common/errors';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import * as logger from '@logger/logUtils';
import { WorkspaceFS } from '@utils/files';
import { getConfig } from '@utils/config/configUtils';

const CHANNEL = 'AgentReview';
const COLLECTION_NAME = 'texra-agent-review';
const SOURCE_LABEL = 'TeXRA Agent Review';
/** Tool-use agent that performs the review and reports issues via the tool sink. */
const REVIEW_AGENT = 'changeReviewer';
/** Tool-use agent used for "Fix with Agent" — a general surgical editor. */
const FIX_AGENT = 'coder';
/** Hard cap so a runaway reviewer session cannot flood the panel. */
const MAX_ISSUES_PER_REVIEW = 25;

export const AGENT_REVIEW_VIEW_ID = 'texra.agentReviewView';

type AgentReviewTrigger = 'manual' | 'commit';

interface AgentReviewStateSnapshot {
  running: boolean;
  issues: readonly ReviewIssue[];
  /** Status line shown above the tree (result summary or failure). */
  summary: string | undefined;
}

/** Context of the in-flight review session that issue reports are checked against. */
interface ActiveReview {
  repoRoot: string;
  baseDescription: string;
  changedFiles: string[];
}

const SEVERITY_MAP: Record<ReviewSeverity, vscode.DiagnosticSeverity> = {
  critical: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

/** Editor range for an issue (issue lines are 1-based). */
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
  /** Repository root the current issues' paths are relative to. */
  private reviewRoot: string | undefined;
  private baseDescription = 'main branch';
  private activeReview: ActiveReview | undefined;
  /** A commit arrived while a review was running; run once more afterwards. */
  private pendingCommitReview = false;

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

  /**
   * Run a review of the working tree against the main branch as a
   * `changeReviewer` tool-use session. Issues stream in through
   * {@link addIssueReport} while the session runs.
   */
  async runReview(trigger: AgentReviewTrigger): Promise<void> {
    if (this.running) {
      if (trigger === 'manual') {
        void vscode.window.showInformationMessage(
          'An agent review is already running.',
        );
      } else {
        this.pendingCommitReview = true;
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
      await vscode.window.withProgress(
        {
          location: { viewId: AGENT_REVIEW_VIEW_ID },
          title: 'Agent review',
        },
        () => this.executeReview(cwd, trigger),
      );
    } finally {
      this.activeReview = undefined;
      this.running = false;
      await this.syncContextKeys();
      this.emitter.fire();
      if (this.pendingCommitReview) {
        this.pendingCommitReview = false;
        void this.runReview('commit');
      }
    }
  }

  private async executeReview(
    cwd: string,
    trigger: AgentReviewTrigger,
  ): Promise<void> {
    const collected = await collectReviewDiff({
      cwd,
      includeUntracked: getConfig<boolean>(
        'agentReview.includeUntrackedFiles',
        true,
      ),
      includeSubmodules: getConfig<boolean>(
        'agentReview.includeSubmodules',
        true,
      ),
    });
    if (!collected.ok) {
      // Issues from the previous run stay available rather than vanishing on
      // a transient failure; the summary marks them as previous results.
      this.summary = `Review failed: ${collected.reason}${this.issues.length > 0 ? ' · showing previous results' : ''}`;
      if (trigger === 'manual') {
        void showLoggedErrorMessage(
          CHANNEL,
          'Agent review failed',
          collected.reason,
        );
      } else {
        logger.warn(CHANNEL, `Agent review failed: ${collected.reason}`);
      }
      return;
    }

    const { repoRoot, baseDescription, diff, changedFiles, truncated } =
      collected.value;
    this.baseDescription = baseDescription;
    if (!diff) {
      this.issues = [];
      this.summary = `No changes to review (working tree matches ${baseDescription})`;
      this.updateDiagnostics();
      return;
    }

    // Start a fresh collection; the reviewer session reports into it live.
    // Snapshot the previous results so a session that fails before reporting
    // anything restores them instead of leaving the panel empty.
    const previousIssues = this.issues;
    this.reviewRoot = repoRoot;
    this.issues = [];
    this.updateDiagnostics();
    this.activeReview = { repoRoot, baseDescription, changedFiles };
    this.emitter.fire();

    const instruction = buildReviewInstruction({
      baseDescription,
      changedFiles,
      diff,
      truncated,
      approach: getConfig<ReviewApproach>('agentReview.approach', 'quick'),
    });
    const config: Record<string, unknown> = {
      agent: REVIEW_AGENT,
      instruction,
      displayInstruction: `Agent review: diff with ${baseDescription} (${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'})`,
    };
    const model = getConfig<string>('agentReview.model', '').trim();
    if (model) config.model = model;

    try {
      // Resolves when the reviewer agent finishes its turn; the run itself
      // is visible as a regular tool-use session in the progress view.
      await vscode.commands.executeCommand('texra.execute', config);
    } catch (err) {
      // Run-lifecycle failures are already logged and surfaced; keep the
      // panel state honest without a second notification.
      const restored = this.issues.length === 0 && previousIssues.length > 0;
      if (restored) {
        this.issues = previousIssues;
        this.updateDiagnostics();
      }
      this.summary = `Review failed: ${toErrorMessage(err)}${restored ? ' · showing previous results' : ''}`;
      logger.warn(
        CHANNEL,
        `Agent review session failed: ${toErrorMessage(err)}`,
      );
      return;
    }

    const count = this.issues.length;
    this.summary =
      count === 0
        ? `No issues found (diff with ${baseDescription})`
        : `Found ${count} potential issue${count === 1 ? '' : 's'} (diff with ${baseDescription})${truncated ? ' · diff truncated' : ''}`;
    logger.info(
      CHANNEL,
      `Agent review (${trigger}): ${count} issue(s) across ${changedFiles.length} changed file(s)`,
    );
  }

  /**
   * Sink for the `report_review_issue` tool: validate a finding from the
   * reviewer session and publish it. Rejections return a reason so the
   * agent can correct itself (wrong file, duplicate, dismissed, no session).
   */
  addIssueReport(report: ReviewIssueReport): {
    accepted: boolean;
    reason?: string;
  } {
    const active = this.activeReview;
    if (!active) {
      return {
        accepted: false,
        reason:
          'No agent review session is collecting issues. Findings can only be reported from a review started via "Run Agent Review".',
      };
    }
    if (this.issues.length >= MAX_ISSUES_PER_REVIEW) {
      return {
        accepted: false,
        reason: `The issue limit (${MAX_ISSUES_PER_REVIEW}) for this review was reached; stop reporting and summarize.`,
      };
    }

    const issue = createReviewIssue({
      ...report,
      file: path.isAbsolute(report.file)
        ? path.relative(active.repoRoot, report.file)
        : report.file,
    });
    if (!isPathInChangeSet(active.changedFiles, issue.file)) {
      return {
        accepted: false,
        reason: `${issue.file} is not part of the reviewed change set; attribute the issue to one of the changed files.`,
      };
    }
    if (this.dismissed.has(fingerprint(issue))) {
      return {
        accepted: false,
        reason:
          'The user previously dismissed this issue; do not re-report it.',
      };
    }
    if (
      this.issues.some(
        (existing) =>
          existing.file === issue.file &&
          existing.title.toLowerCase() === issue.title.toLowerCase(),
      )
    ) {
      return { accepted: false, reason: 'This issue was already reported.' };
    }

    this.issues = [...this.issues, issue];
    this.updateDiagnostics();
    void this.syncContextKeys();
    this.emitter.fire();
    return { accepted: true };
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
    try {
      await vscode.commands.executeCommand('texra.execute', {
        agent: FIX_AGENT,
        instruction,
      });
    } catch (err) {
      await showLoggedErrorMessage(
        CHANNEL,
        'Could not launch the fix agent',
        err,
      );
      return;
    }
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
