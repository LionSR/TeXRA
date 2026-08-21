/**
 * Agent review state for the VS Code extension.
 *
 * A review runs as a full `changeReviewer` tool-use agent session via
 * `runAgent`, so the run outcome is observable: the service collects the
 * diff against the main branch, hands it to the agent, and receives findings
 * live through the `report_review_issue` tool sink. Issues are published as
 * diagnostics
 * (Problems panel + editor squiggles) and drive the Agent Review tree view;
 * "Fix with Agent" hands them to the file-editing `coder` agent.
 */

// Standard library imports
import * as path from 'node:path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports
import { AgentConfigSchema, currentSession, runAgent } from '@agent/runtime';
import {
  buildFixInstruction,
  buildReviewInstruction,
  collectReviewDiff,
  createReviewIssue,
  isPathInChangeSet,
  normalizeReviewFilePath,
  type ReviewIssue,
  type ReviewIssueReport,
  type ReviewSeverity,
} from '@agent/review';
import { openFinalOutputIfAvailable } from '@frontend/agents/finalOutputOpener';
import {
  showLoggedErrorMessage,
  showLoggedMessage,
} from '@frontend/ui/errorHandlingUtils';
import { lineToRange } from '@frontend/vscode/vscodeEditor';
import { createLog } from '@logger/logUtils';
import { RUN_OUTCOME, type RunOutcome, AgentCategory } from '@shared/schemas';
import { WorkspaceFS } from '@utils/files/workspaceFS';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { formatResultCount } from '@utils/text/stringUtils';
import {
  AgentReviewRunController,
  type AgentReviewRunToken,
} from './AgentReviewRunController';

const CHANNEL = 'AgentReview';
const log = createLog(CHANNEL);
const COLLECTION_NAME = 'texra-agent-review';
const SOURCE_LABEL = 'TeXRA Agent Review';
/** Tool-use agent that performs the review and reports issues via the tool sink. */
const REVIEW_AGENT = 'changeReviewer';
/** Tool-use agent used for "Fix with Agent" — a general surgical editor. */
const FIX_AGENT = 'coder';
/**
 * Hard cap so a runaway reviewer session cannot flood the panel.
 * Deliberately slack above the changeReviewer prompt's 10-issue guidance —
 * the prompt sets the editorial limit, this is the safety backstop.
 */
const MAX_ISSUES_PER_REVIEW = 25;

/** The Agent Review tree lives in VS Code's Source Control (git) panel. */
export const AGENT_REVIEW_VIEW_ID = 'texra.scmAgentReviewView';

type AgentReviewTrigger = 'manual' | 'commit';

interface AgentReviewRunOptions {
  baseRef?: string;
  baseDescription?: string;
  /** Per-run base branch (merge-base) from the "Diff Against…" picker. */
  baseBranch?: string;
  /** Optional free-text focus from the "Find Issues" options. */
  userInstructions?: string;
}

interface AgentReviewStateSnapshot {
  running: boolean;
  issues: readonly ReviewIssue[];
  /** Status line shown above the tree (result summary or failure). */
  summary: string | undefined;
}

/** Pre-run results captured so a session that reports nothing can restore them. */
interface ReviewSnapshot {
  issues: ReviewIssue[];
  reviewRoot: string | undefined;
  baseDescription: string;
}

const SEVERITY_MAP: Record<ReviewSeverity, vscode.DiagnosticSeverity> = {
  critical: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

/** Editor range for an issue (issue lines are 1-based). */
export function issueRange(issue: ReviewIssue): vscode.Range {
  return lineToRange(issue.startLine, issue.endLine);
}

class AgentReviewServiceImpl {
  private collection: vscode.DiagnosticCollection | undefined;
  private readonly emitter = new vscode.EventEmitter<void>();
  /** Fires whenever issues, run status, or the summary change. */
  readonly onDidChange = this.emitter.event;

  private issues: ReviewIssue[] = [];
  /** Fingerprints of dismissed issues, kept for the session so re-reviews don't resurrect them. */
  private readonly dismissed = new Set<string>();
  private readonly reviewRuns = new AgentReviewRunController();
  private summary: string | undefined;
  /** Repository root the current issues' paths are relative to. */
  private reviewRoot: string | undefined;
  private baseDescription = 'main branch';
  /** A commit arrived while a review was running; run once more afterwards. */
  private pendingCommitReview: AgentReviewRunOptions | undefined;

  initialize(context: vscode.ExtensionContext): void {
    this.collection =
      vscode.languages.createDiagnosticCollection(COLLECTION_NAME);
    context.subscriptions.push(this.collection, this.emitter);
  }

  getState(): AgentReviewStateSnapshot {
    return {
      running: this.reviewRuns.isActive,
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
    // Compare through Uri.file so both sides get the same normalization —
    // on Windows, git reports an upper-case drive letter while uri.fsPath
    // lower-cases it, and a raw path comparison would never match.
    return this.issues.filter(
      (issue) => vscode.Uri.file(this.issuePath(issue)).fsPath === uri.fsPath,
    );
  }

  /**
   * Run a review of the working tree against the main branch as a
   * `changeReviewer` tool-use session. Issues stream in through
   * {@link addIssueReport} while the session runs.
   */
  async runReview(
    trigger: AgentReviewTrigger,
    options: AgentReviewRunOptions = {},
  ): Promise<void> {
    if (this.reviewRuns.isActive) {
      if (trigger === 'manual') {
        void vscode.window.showInformationMessage(
          'An agent review is already running.',
        );
      } else if (!this.reviewRuns.stopRequested) {
        this.pendingCommitReview ??= options;
      }
      return;
    }
    const cwd = WorkspaceFS.getPath();
    if (!cwd) {
      if (trigger === 'manual') {
        void showLoggedMessage(
          CHANNEL,
          'Agent review needs an open workspace folder.',
        );
      }
      return;
    }

    const run = this.reviewRuns.start(currentSession());
    this.summary = 'Reviewing changes…';
    await this.syncContextKeys();
    this.emitter.fire();

    try {
      await vscode.window.withProgress(
        {
          location: { viewId: AGENT_REVIEW_VIEW_ID },
          title: 'Agent review',
        },
        () => this.executeReview(cwd, trigger, options, run),
      );
    } catch (err) {
      // Backstop for anything executeReview's own handling missed — the
      // summary must never stay stuck on "Reviewing changes…".
      const errorMsg = toErrorMessage(err);
      this.summary = `Review failed: ${errorMsg}`;
      log.warn(`Agent review failed unexpectedly: ${errorMsg}`);
    } finally {
      if (this.reviewRuns.finish(run)) {
        const pending = this.pendingCommitReview;
        this.pendingCommitReview = undefined;
        this.emitter.fire();
        await this.syncContextKeys();
        if (pending) {
          void this.runReview('commit', pending);
        }
      }
    }
  }

  private async executeReview(
    cwd: string,
    trigger: AgentReviewTrigger,
    options: AgentReviewRunOptions,
    run: AgentReviewRunToken,
  ): Promise<void> {
    // `clear()` discards the run. Check before collecting so a clear that
    // landed during the initial context-key update cannot start stale work.
    if (!this.reviewRuns.isCurrent(run)) return;
    const collected = await collectReviewDiff({
      cwd,
      baseRef: options.baseRef,
      baseDescription: options.baseDescription,
      baseBranch: options.baseBranch,
    });
    if (!this.reviewRuns.isCurrent(run)) return;
    if (run.stopRequested) {
      this.summary = 'Review cancelled';
      return;
    }

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
        log.warn(`Agent review failed: ${collected.reason}`);
      }
      return;
    }

    const { repoRoot, baseDescription, diff, changedFiles, truncated } =
      collected.value;
    if (!diff) {
      this.baseDescription = baseDescription;
      this.issues = [];
      this.summary = `No changes to review (working tree matches ${baseDescription})`;
      this.updateDiagnostics();
      return;
    }

    // Start a fresh collection; the reviewer session reports into it live.
    // Snapshot the previous results (issues plus the root/base they belong
    // to) so a session that fails before reporting anything restores them
    // intact instead of leaving the panel empty.
    const previous: ReviewSnapshot = {
      issues: this.issues,
      reviewRoot: this.reviewRoot,
      baseDescription: this.baseDescription,
    };
    this.reviewRoot = repoRoot;
    this.baseDescription = baseDescription;
    this.issues = [];
    this.updateDiagnostics();
    // Normalize the change-set paths once here: the collection is validated
    // against per reported issue, and `isPathInChangeSet` carries the list
    // as-is. The raw list still feeds the instruction below, so the prompt
    // shows paths exactly as git printed them.
    this.reviewRuns.collect(run, {
      repoRoot,
      baseDescription,
      changedFiles: changedFiles.map(normalizeReviewFilePath),
    });
    this.emitter.fire();

    let outcome: RunOutcome;
    try {
      // Everything from here until the session ends sits inside one
      // try/catch: the panel was already cleared above, so any setup
      // failure (config parsing included) must restore the snapshot
      // rather than leave the panel empty.
      const instruction = buildReviewInstruction({
        baseDescription,
        changedFiles,
        diff,
        truncated,
        userInstructions: options.userInstructions,
      });
      const config = AgentConfigSchema.parse({
        agent: REVIEW_AGENT,
        // changeReviewer is a tool-use agent; set the category explicitly so
        // launch resolves it within tool-use (the config default is Workflow).
        agentCategory: AgentCategory.ToolUse,
        instruction,
        displayInstruction: `Agent review: diff with ${baseDescription} (${formatResultCount(changedFiles.length, 'file')})${options.userInstructions ? ' · custom focus' : ''}`,
        // The instruction's paths are repo-relative; anchor the session's
        // tool calls (read_file, grep, bash) to the repository root, which
        // may sit above the opened workspace folder.
        workingDirectory: repoRoot,
      });

      // Run the reviewer session directly (the `texra.execute` path minus
      // its fire-and-forget error swallowing) so the panel can distinguish
      // a completed review from a failed or cancelled one. The run itself
      // is visible as a regular tool-use session in the progress view.
      const result = await runAgent(
        { kind: 'fresh', config },
        {
          openWorkflowOutput: openFinalOutputIfAvailable,
          stopAfterCycle: true,
          session: run.session,
          onRun: (handle) => this.reviewRuns.bind(run, handle),
        },
      );
      outcome = result.outcome;
    } catch (err) {
      if (!this.reviewRuns.isCurrent(run)) return;
      // Run-lifecycle failures are already logged and surfaced; keep the
      // panel state honest without a second notification.
      const errorMsg = toErrorMessage(err);
      const restored = this.restorePreviousResults(previous);
      this.summary = `Review failed: ${errorMsg}${restored ? ' · showing previous results' : ''}`;
      log.warn(`Agent review session failed: ${errorMsg}`);
      return;
    }

    if (!this.reviewRuns.isCurrent(run)) {
      log.info(
        'Agent review results were cleared while the session ran; discarding its outcome',
      );
      return;
    }

    if (outcome !== RUN_OUTCOME.COMPLETED) {
      const verb = outcome === RUN_OUTCOME.CANCELLED ? 'cancelled' : 'failed';
      // Partial findings from the interrupted session win over the pre-run
      // snapshot — they were just verified against the current change set,
      // while the snapshot describes an older tree. The snapshot is only
      // restored when the session reported nothing at all.
      const restored = this.restorePreviousResults(previous);
      let suffix = '';
      if (restored) {
        suffix = ' · showing previous results';
      } else if (this.issues.length > 0) {
        suffix = ` · showing the ${formatResultCount(this.issues.length, 'issue')} reported before the session ended`;
      }
      this.summary = `Review ${verb}${suffix}`;
      log.warn(`Agent review session ${verb}`);
      return;
    }

    const count = this.issues.length;
    this.summary =
      count === 0
        ? `No issues found (diff with ${baseDescription})`
        : `Found ${formatResultCount(count, 'potential issue')} (diff with ${baseDescription})${truncated ? ' · diff truncated' : ''}`;
    log.info(
      `Agent review (${trigger}): ${count} issue(s) across ${changedFiles.length} changed file(s)`,
    );
  }

  /**
   * Roll back to the snapshot taken before a review session started, when
   * the session ended without reporting anything. Returns true when the
   * previous issues (and the root/base they belong to) were restored.
   */
  private restorePreviousResults(previous: ReviewSnapshot): boolean {
    if (this.issues.length > 0 || previous.issues.length === 0) return false;
    this.issues = previous.issues;
    this.reviewRoot = previous.reviewRoot;
    this.baseDescription = previous.baseDescription;
    this.updateDiagnostics();
    return true;
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
    const active = this.reviewRuns.collection;
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
          existing.startLine === issue.startLine &&
          existing.endLine === issue.endLine &&
          existing.title.toLowerCase() === issue.title.toLowerCase(),
      )
    ) {
      return { accepted: false, reason: 'This issue was already reported.' };
    }

    this.issues = [...this.issues, issue];
    this.publishIssues();
    return { accepted: true };
  }

  dismissIssue(id: string): void {
    const issue = this.getIssue(id);
    if (!issue) return;
    this.dismissed.add(fingerprint(issue));
    this.issues = this.issues.filter((entry) => entry.id !== id);
    this.publishIssues();
  }

  /**
   * Clear results and forget dismissals. A reviewer session still running is
   * stopped; its future reports are rejected and its outcome is discarded.
   * The run slot stays occupied until that execution actually settles.
   */
  clear(): void {
    this.reviewRuns.discard();
    this.issues = [];
    this.dismissed.clear();
    this.summary = undefined;
    this.pendingCommitReview = undefined;
    this.publishIssues();
  }

  /** Stop the active review while preserving any findings already reported. */
  stop(): void {
    if (!this.reviewRuns.requestStop()) return;
    this.pendingCommitReview = undefined;
    this.summary = 'Stopping review…';
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
        // coder is a tool-use agent; set the category explicitly so launch
        // resolves it within tool-use (the config default is Workflow).
        agentCategory: AgentCategory.ToolUse,
        instruction,
        // Issue paths are relative to the reviewed repository root.
        ...(this.reviewRoot ? { workingDirectory: this.reviewRoot } : {}),
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
      `Launched the ${FIX_AGENT} agent to fix ${formatResultCount(targets.length, 'review issue')}. Run the review again once it finishes.`,
    );
  }

  /** Republish the current issue set to diagnostics, context keys, and the tree. */
  private publishIssues(): void {
    this.updateDiagnostics();
    void this.syncContextKeys();
    this.emitter.fire();
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
      this.reviewRuns.isActive,
    );
    await vscode.commands.executeCommand(
      'setContext',
      'texra.agentReview.hasIssues',
      this.issues.length > 0,
    );
  }
}

/**
 * Dismissal/dedup key. NUL-delimited — unlike "::", a NUL byte cannot
 * appear in a POSIX path component or a trimmed title, so distinct
 * issues can never collide.
 */
function fingerprint(issue: ReviewIssue): string {
  return [
    issue.file,
    `${issue.startLine}-${issue.endLine}`,
    issue.title.toLowerCase(),
  ].join('\0');
}

/** Singleton service backing the Agent Review view, diagnostics, and commands. */
export const AgentReviewService = new AgentReviewServiceImpl();
