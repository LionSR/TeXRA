// Third-party imports
import { Effect, Stream, type Scope } from 'effect';
import * as vscode from 'vscode';

// Local imports - session view
import {
  appSignalStream,
  Settings,
  type AppSignals,
} from '@texra-ai/harness/host';
import {
  APPROVAL_POLICY_CONFIG_KEY,
  descendantRuns,
  isWorking,
  sessionActivity,
  sumUsageStats,
  type ApprovalPolicy,
  type SessionTitleState,
  type SessionView,
  type TokenUsageStats,
} from '@texra-ai/harness/schemas';
import {
  approvalPolicyLabel,
  formatApprovalPolicy,
} from '@ui/copy/approvalPolicy';
import { usageCostLabel } from '@ui/copy/modelAccess';
import type { Session, WorkspaceRoots } from '@texra-ai/harness';

/** What the task pill paints from one session view. */
interface TaskStatus {
  /** The session's activity (`sessionActivity`, the reading every host's
   *  title shares), so a request waiting on the user keeps the pill shown. */
  readonly activity: SessionTitleState;
  /** The live runs working right now: the spinner's count. */
  readonly working: number;
  /** The spend of every run tree still in flight: a root counts, with all
   *  its runs, finished children included, while any run in its tree is
   *  live. A child's spend is on its root's `treeUsage`. */
  readonly usage: TokenUsageStats;
}

function taskStatus(view: SessionView): TaskStatus {
  const runs = [...view.runs.values()];
  const liveTreeRoots = runs.filter(
    (run) =>
      (run.parentId === null || !view.runs.has(run.parentId)) &&
      descendantRuns(view, run.id, { includeRoot: true }).some((id) => {
        const member = view.runs.get(id);
        return member !== undefined && member.holder === 'here';
      }),
  );
  return {
    activity: sessionActivity(view),
    working: runs.filter(isWorking).length,
    usage: sumUsageStats(liveTreeRoots.map((root) => root.treeUsage)),
  };
}

const sameTaskStatus = (a: TaskStatus, b: TaskStatus): boolean =>
  a.activity === b.activity &&
  a.working === b.working &&
  a.usage.cost === b.usage.cost &&
  a.usage.inputTokens === b.usage.inputTokens &&
  a.usage.outputTokens === b.usage.outputTokens;

function paint(
  item: vscode.StatusBarItem,
  config: WorkspaceRoots['config'],
  { activity, working, usage }: TaskStatus,
): void {
  // The project's persisted policy: what a run here, or the service's for
  // this project, decides under.
  const policy = Settings.getConfig<ApprovalPolicy>(
    config,
    APPROVAL_POLICY_CONFIG_KEY,
  );
  const policyLine = `Approval policy: ${approvalPolicyLabel(policy)} — ${formatApprovalPolicy(policy)}`;
  const { cost, inputTokens, outputTokens } = usage;
  if (cost === 0 && inputTokens === 0 && outputTokens === 0) {
    item.tooltip = `${policyLine}\n\nClick to show TeXRA sessions`;
  } else {
    const tip = new vscode.MarkdownString(
      [
        policyLine,
        '',
        '| TeXRA usage | |',
        '| --- | ---: |',
        `| Cost | ${usageCostLabel(usage)} |`,
        `| Input tokens | ${inputTokens.toLocaleString()} |`,
        `| Output tokens | ${outputTokens.toLocaleString()} |`,
        '',
        '*Click to show TeXRA sessions*',
      ].join('\n'),
    );
    tip.isTrusted = false;
    item.tooltip = tip;
  }
  if (activity === 'approval') {
    item.text = '$(bell-dot) TeXRA: Waiting for you';
    item.accessibilityInformation = { label: 'TeXRA tasks, waiting for you' };
  } else if (working > 1) {
    item.text = `$(loading~spin) TeXRA: ${working} active`;
    item.accessibilityInformation = {
      label: `TeXRA tasks, ${working} active`,
    };
  } else if (working === 1) {
    item.text = '$(loading~spin) TeXRA: Running';
    item.accessibilityInformation = { label: 'TeXRA tasks, one active' };
  } else {
    // Nothing running: no pill. The setup pill covers the first run.
    item.hide();
    return;
  }
  item.show();
}

/**
 * The task pill: the session's activity, its working-run count, and the
 * spend of the run trees in flight, painted for as long as the caller's
 * scope lasts (activation's, in the extension). The item itself is owned by
 * `context.subscriptions`, like the setup pill.
 *
 * It reads the session's view as a level stream (`Session.view.changes`),
 * which carries the local facts no row records too (an owner proved dead
 * reclassifies its runs as interrupted with nothing committed). The stream
 * replays the current view on subscribe, and that first status always
 * paints; after it, a view that leaves the status where it was paints
 * nothing. The item stays hidden until that first paint, so no tooltip is
 * set before it. An approval-policy change repaints the policy line.
 */
export const taskStatusBar = Effect.fn('taskStatusBar')(function* (
  context: vscode.ExtensionContext,
  session: Pick<Session, 'view'>,
  config: WorkspaceRoots['config'],
): Effect.fn.Return<void, never, Scope.Scope | AppSignals> {
  const item = vscode.window.createStatusBarItem(
    'texra.taskStatus',
    vscode.StatusBarAlignment.Left,
  );
  item.name = 'TeXRA Tasks';
  item.command = 'texra.showProgressView';
  context.subscriptions.push(item);
  yield* Effect.forkScoped(
    Stream.merge(
      session.view.changes.pipe(
        Stream.map(taskStatus),
        Stream.changesWith(sameTaskStatus),
      ),
      appSignalStream('approvalPolicyChanged').pipe(
        Stream.map(() => taskStatus(session.view.current())),
      ),
    ).pipe(
      Stream.runForEach((status) =>
        Effect.sync(() => paint(item, config, status)),
      ),
    ),
    { startImmediately: true },
  );
});
