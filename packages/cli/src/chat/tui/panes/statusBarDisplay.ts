import {
  formatCompactDuration,
  formatCompactTokenCount,
  formatCostUsd,
  formatResultCount,
} from '@texra-ai/harness/transcript';
import { absurd, Predicate } from 'effect';
import {
  runBypasses,
  type ContextStateData,
  type RunId,
  type TokenUsageStats,
  type UsageRoute,
} from '@texra-ai/harness/schemas';
import { isWorking } from '@texra-ai/harness/schemas';
import { KEY_HINT_SEPARATOR, keyHintText } from '@cli/tui/ui/KeyHints';
import { STATUS_DIAMOND } from '@cli/tui/ui/glyphs';
import { COLOR_ERROR, COLOR_HINT, COLOR_WARNING } from '@cli/tui/ui/colors';
import {
  firstFittingCandidate,
  textDisplayWidth,
  truncateSummaryToWidth,
} from '@cli/runtime/terminalText';
import type {
  SubscriptionUsageProvider,
  SubscriptionUsageSnapshot,
} from '@texra/shared/model/subscriptionUsage';
import {
  contextGaugeBand,
  roundedContextPercent,
} from '@texra/shared/contextGauge';
import { codingPlanForUsageRoute } from '@texra/shared/model/codingPlans';
import { usageRouteBadge } from '@ui/copy/modelAccess';
import { runStatus } from '@ui/copy/runStatus';
import { approvalPolicyLabel } from '@ui/copy/approvalPolicy';
import { AGENT_LIST, NESTED_AGENT, TASK_ACTIONS } from '@ui/copy/nestedRuns';
import { APPROVAL_BYPASS_BADGE } from '@ui/copy/approvalBypass';

import { formatResumeCommand } from '../state/resumeHint';
import { type TransientNotice } from '../state/cliState';
import { runViewOf } from '../state/sessionView';
import type {
  ApprovalPolicy,
  RunView,
  SessionView,
} from '@texra-ai/harness/schemas';
import type { PendingRequestKind } from '../state/approvalQueue';

/** Which approval bypasses are on for a run, its own or inherited. */
export type BypassState = ReturnType<typeof runBypasses>;

/** What the pending-interaction count names: approvals, questions, or both. */
type ApprovalQueueStatusKind = 'approval' | 'question' | 'request';

function statusKindForApproval(
  kind: PendingRequestKind,
): Exclude<ApprovalQueueStatusKind, 'request'> {
  switch (kind) {
    case 'userQuestion':
      return 'question';
    case 'bash':
    case 'toolEdit':
    case 'planApproval':
    case 'proposal':
    case 'retry':
      return 'approval';
    default:
      return absurd(kind);
  }
}

export function approvalQueueStatusKind(
  kinds: Iterable<PendingRequestKind>,
): ApprovalQueueStatusKind {
  let sawApproval = false;
  let sawQuestion = false;
  for (const kind of kinds) {
    const status = statusKindForApproval(kind);
    sawApproval ||= status === 'approval';
    sawQuestion ||= status === 'question';
    if (sawApproval && sawQuestion) return 'request';
  }
  return sawQuestion ? 'question' : 'approval';
}

const STATUS_BAR_HORIZONTAL_PADDING = 2;

type StatusBarColor =
  | typeof COLOR_HINT
  | typeof COLOR_WARNING
  | typeof COLOR_ERROR;
type CtrlCAction = 'exit' | 'stop' | 'stop root';

/** Choose the quota owner, preferring the route of completed usage. */
export function subscriptionUsageProviderForStatus({
  usageRoute,
  prospectiveRoute,
}: {
  readonly usageRoute: UsageRoute | undefined;
  readonly prospectiveRoute: UsageRoute | undefined;
}): SubscriptionUsageProvider | undefined {
  return codingPlanForUsageRoute(usageRoute ?? prospectiveRoute)?.usageProvider;
}

/**
 * How a segment yields when the row is narrower than the bar: a `drop`
 * segment is removed, a `truncate` one is shortened into the width the
 * segments above it leave, and a `keep` one stays whole or goes. Lower
 * priorities yield first.
 */
type StatusBarFitPolicy = 'drop' | 'truncate' | 'keep';

interface StatusBarSegment {
  readonly text: string;
  /** An explicit colour; without one, `dim` paints the terminal's dim. */
  readonly color?: StatusBarColor;
  readonly dim?: boolean;
  readonly badge?: boolean;
  readonly badgeColor?: typeof COLOR_ERROR | typeof COLOR_WARNING;
  readonly priority: number;
  readonly policy: StatusBarFitPolicy;
  /** Shorter replacement text tried (in priority order) before any segment
   *  yields when the bar overflows the terminal width. */
  readonly compactText?: string;
  /** Purely visual glyphs hidden from screen readers (`aria-hidden`). */
  readonly decorative?: boolean;
}

/**
 * What the status bar shows beyond the displayed run's own facts, which it
 * reads straight off the `RunView` (`buildStatusBarDisplay`'s `run`): the
 * turn clock, the session chrome, and which surface owns input.
 */
interface StatusBarChrome {
  /** Liveness of the running turn: omitted entirely in tests/headless runs,
   *  same as each of its fields individually. */
  readonly turn?: StatusBarTurnInput;
  readonly transientNotice: TransientNotice | undefined;
  readonly commandName?: string;
  /** Visible agents still in flight. */
  readonly runningSessions: number;
  readonly approvalDepth: number;
  readonly approvalKind?: ApprovalQueueStatusKind;
  readonly modelAccess: UsageRoute | undefined;
  /** The prospective subscription route could not be resolved. */
  readonly subscriptionProbeFailed?: boolean;
  /** Latest quota snapshot for the subscription serving this model. */
  readonly subscriptionQuota?: SubscriptionUsageSnapshot;
  /** Session approval policy; a non-default policy earns a segment. */
  readonly approvalPolicy?: ApprovalPolicy;
  /** Terminal width in columns. */
  readonly width?: number;
  readonly ctrlCAction?: CtrlCAction;
  /** Nested-session location (the focused child's label). Omitted on the
   *  root session, where the header already names the conversation. */
  readonly location?: { readonly label: string };
  /** Which surface currently owns input and global chat shortcuts: a
   *  foreground surface (approval, detail, form, slash palette, reverse
   *  search) or the persistent child list. Neither active means the normal
   *  chat shortcuts row (`shortcuts`) applies. */
  readonly foreground: StatusBarForegroundInput;
  readonly childList: StatusBarChildListInput;
  /** Availability/labels for the normal chat shortcuts row, shown when
   *  neither `foreground` nor `childList` owns input. */
  readonly shortcuts: StatusBarShortcutsInput;
}

/** Liveness of the currently running turn, shown in the status bar's left
 *  segments so a long token-less "thinking" turn still reads as alive. */
interface StatusBarTurnInput {
  /** Milliseconds since the running turn began. When set and `status` is
   *  `running`, the bar shows a live `Ns` segment. */
  readonly elapsedMs?: number;
  /** Current 1 Hz spin-cycle character (see `ui/LoadingIndicator`'s
   *  `loadingFrameAt`) shown ahead of the status label while a turn is
   *  active, so "running" reads as alive rather than a static word. */
  readonly runningFrame?: string;
}

interface StatusBarForegroundInput {
  /** True while a modal, form, palette, or search surface owns input. */
  readonly inputActive?: boolean;
}

interface StatusBarChildListInput {
  /** True while the persistent child list, rather than the input, owns keys. */
  readonly focused?: boolean;
  readonly selectionKillable?: boolean;
  readonly selectionResumable?: boolean;
}

interface StatusBarShortcutsInput {
  /** True when slash commands and text entry are actionable in this view. */
  readonly chatInputAvailable: boolean;
  /** True when the displayed run is working a turn, so Shift-Tab can send
   *  a message it reads only once the turn ends. */
  readonly holdAvailable?: boolean;
  /** True when bare Escape can focus the active run's immediate parent. */
  readonly parentNavigationAvailable?: boolean;
  /** True when the persistent child list has a session row. */
  readonly childNavigationAvailable?: boolean;
  /** True when the focused run has output that can be printed in full. */
  readonly transcriptAvailable?: boolean;
  readonly scriptAvailable?: boolean;
}

interface StatusBarDisplay {
  readonly left: readonly StatusBarSegment[];
  readonly bindings: string;
}

// Own API keys are the default route, so only a subscription earns a segment.
// The bar names how the call is paid for, not which provider; the /login form
// and /status name the subscription itself.
function accessModeSegment(
  access: UsageRoute | undefined,
): StatusBarSegment | undefined {
  return usageRouteBadge(access)?.subscription === true
    ? {
        text: 'subscription',
        color: COLOR_HINT,
        compactText: 'sub',
        priority: STATUS_BAR_PRIORITY.accessMode,
        policy: 'drop',
      }
    : undefined;
}

function subscriptionQuotaSegment(
  snapshot: SubscriptionUsageSnapshot | undefined,
): StatusBarSegment | undefined {
  if (snapshot?.state !== 'available') return undefined;
  const limitingWindow = snapshot.windows.toSorted(
    (left, right) => right.percentUsed - left.percentUsed,
  )[0];
  if (!limitingWindow) return undefined;
  const remaining = Math.max(0, Math.round(limitingWindow.percentRemaining));
  let color: StatusBarColor | undefined;
  if (remaining === 0) color = COLOR_ERROR;
  else if (remaining <= 20) color = COLOR_WARNING;
  return {
    text: `${snapshot.planName} ${remaining}% left`,
    compactText: `${remaining}% left`,
    ...(color === undefined ? { dim: true } : { color }),
    priority: STATUS_BAR_PRIORITY.subscriptionQuota,
    policy: 'drop',
  };
}

// The gauge renders `RunView.context` — the run's own reading of the window it
// served the last response under, which is the only value that stays right
// across subscription caps and compaction. The `usage` fallback covers the
// pre-first-response window, where the run has reported no occupancy yet: show
// the input-token count bare rather than substituting a registry window the run
// may never have used.
function formatUsage(
  contextState: ContextStateData | undefined,
  usage: TokenUsageStats | undefined,
): StatusBarSegment | undefined {
  const base = {
    priority: STATUS_BAR_PRIORITY.usage,
    policy: 'drop',
  } as const;
  if (!contextState) {
    const reported = usage?.inputTokens ?? 0;
    if (reported <= 0) return undefined;
    return { ...base, text: formatCompactTokenCount(reported), dim: true };
  }

  // Occupancy is the run's `contextTokens` (the last response's input plus
  // output, then an estimate of what was added since), carried in the wire
  // field named `inputTokens`.
  const { inputTokens: used, contextWindow, utilizationPercent } = contextState;
  const percent = roundedContextPercent(utilizationPercent);
  // Reads the run's own `utilizationPercent`, not a used/contextWindow
  // re-derivation (drifts); shared bands/rounding with UsagePanel's gauge.
  const band = contextGaugeBand(utilizationPercent);
  let color: StatusBarColor | undefined;
  if (band === 'error') color = COLOR_ERROR;
  else if (band === 'warning') color = COLOR_WARNING;
  return {
    ...base,
    text: `${formatCompactTokenCount(used)}/${formatCompactTokenCount(
      contextWindow,
    )} (${percent}%)`,
    // Keep context visibility on narrow terminals: degrade to the bare
    // percentage instead of dropping the segment entirely.
    compactText: `${percent}%`,
    ...(color === undefined ? { dim: true } : { color }),
  };
}

// The task's spend so far, its agents included: the root's `treeUsage`,
// whichever run the bar describes. A subscription that billed nothing
// already reads as `subscription`, so a zero total earns no segment.
function taskCostSegment(
  run: RunView | undefined,
  view: Pick<SessionView, 'runs'>,
): StatusBarSegment | undefined {
  if (run === undefined) return undefined;
  const root = view.runs.get(run.ancestors[0]?.id ?? run.id);
  const cost = root?.treeUsage.cost ?? 0;
  if (cost <= 0) return undefined;
  return {
    text: formatCostUsd(cost),
    dim: true,
    priority: STATUS_BAR_PRIORITY.taskCost,
    policy: 'drop',
  };
}

// Lower values yield first when the left status group exceeds the row.
const STATUS_BAR_PRIORITY = {
  // The task's total is also in `/status` and the exit summary: on a narrow
  // bar it gives way first.
  taskCost: 15,
  activeSubagent: 20,
  usage: 40,
  queuedFollowUp: 50,
  approvalPolicy: 55,
  approvalDepth: 60,
  rootActive: 65,
  subscriptionQuota: 67,
  elapsed: 70,
  accessMode: 72,
  location: 74,
  thinking: 75,
  compacting: 80,
  // A notice is the focal text: it takes whatever width the segments above
  // it leave.
  notice: 82,
  // Bypass badges announce active auto-approval: the one thing the bar must
  // not silently drop, so they go only when nothing below them is left.
  bypassBadge: 85,
  // A notice must not hide the only indication that an active run is alive.
  liveness: 88,
  // Exiting drops queued follow-ups silently: the warning outlasts the rest.
  discardWarning: 95,
  // The diamond and the run's status word.
  chrome: 100,
} as const;

function statusBarSegmentWidth(segment: StatusBarSegment): number {
  return textDisplayWidth(segment.text) + (segment.badge ? 2 : 0);
}

function statusBarSegmentsWidth(segments: readonly StatusBarSegment[]): number {
  return segments.reduce(
    (total, segment, index) =>
      total + statusBarSegmentWidth(segment) + (index === 0 ? 0 : 1),
    0,
  );
}

// Shared by every width-aware layout below: the row width minus the status
// bar's fixed horizontal padding, or undefined when the width itself is
// unknown (tests/headless runs).
function statusBarInnerWidth(width: number | undefined): number | undefined {
  return width === undefined
    ? undefined
    : Math.max(0, width - STATUS_BAR_HORIZONTAL_PADDING);
}

/**
 * The left group fitted into the row. Every segment with a shorter form
 * takes it first, lowest priority first; then `drop` segments go, lowest
 * first; then the rest are given the row in priority order, highest first:
 * a `keep` segment whole or not at all, a `truncate` one shortened into what
 * is left. The segments keep their order on the row.
 */
function fitStatusBarLeftSegments(
  segments: readonly StatusBarSegment[],
  width: number | undefined,
): readonly StatusBarSegment[] {
  const innerWidth = statusBarInnerWidth(width);
  if (
    innerWidth === undefined ||
    statusBarSegmentsWidth(segments) <= innerWidth
  ) {
    return segments;
  }

  // Lowest priority first, the later of two equals first.
  const yieldOrder = [...segments.keys()].sort(
    (a, b) => segments[a].priority - segments[b].priority || b - a,
  );
  const fitted: Array<StatusBarSegment | undefined> = [...segments];
  const row = (): StatusBarSegment[] => fitted.filter(Predicate.isNotNullish);
  for (const index of yieldOrder) {
    const segment = segments[index];
    if (segment.compactText === undefined) continue;
    fitted[index] = { ...segment, text: segment.compactText };
    if (statusBarSegmentsWidth(row()) <= innerWidth) return row();
  }
  for (const index of yieldOrder) {
    if (segments[index].policy !== 'drop') continue;
    fitted[index] = undefined;
    if (statusBarSegmentsWidth(row()) <= innerWidth) return row();
  }

  const given: Array<StatusBarSegment | undefined> = segments.map(
    () => undefined,
  );
  for (const index of yieldOrder.toReversed()) {
    const segment = fitted[index];
    if (segment === undefined) continue;
    given[index] = segment;
    const over =
      statusBarSegmentsWidth(given.filter(Predicate.isNotNullish)) - innerWidth;
    if (over <= 0) continue;
    const room = textDisplayWidth(segment.text) - over;
    given[index] =
      segment.policy === 'truncate' && room > 0
        ? { ...segment, text: truncateSummaryToWidth(segment.text, room) }
        : undefined;
  }
  return given.filter(Predicate.isNotNullish);
}

// Bindings use the shared KeyHints vocabulary (`key action` joined with
// KEY_HINT_SEPARATOR) so the status bar and modal footers read as one system
// (2026-05-14-10-architecture.md § Intuitiveness conventions).
function statusBarBindingRow(
  bindings: readonly (string | false | undefined)[],
): string {
  return bindings
    .filter((binding): binding is string => !!binding)
    .join(KEY_HINT_SEPARATOR);
}

// Every bindings row below is a widest-first `firstFittingCandidate` cascade.
// The chat row names keys only; commands are one `/` away in the palette and
// `/help`, so the bar never advertises individual slash commands.
function statusBarBindingsText(
  {
    chatInputAvailable,
    holdAvailable = false,
    childNavigationAvailable = false,
    parentNavigationAvailable = false,
    transcriptAvailable = false,
    scriptAvailable = false,
  }: StatusBarShortcutsInput,
  ctrlCAction: CtrlCAction,
  maxColumns: number | undefined,
): string {
  const parentBack = parentNavigationAvailable
    ? keyHintText({ key: 'Esc', action: AGENT_LIST.parentAction })
    : undefined;
  const childList = childNavigationAvailable
    ? keyHintText({ key: 'Tab', action: AGENT_LIST.openAction })
    : undefined;
  const fullOutput = transcriptAvailable
    ? keyHintText({ key: 'Ctrl-T', action: 'transcript' })
    : undefined;
  const script = scriptAvailable
    ? keyHintText({ key: 'Ctrl-O', action: 'script' })
    : undefined;
  const commands = chatInputAvailable
    ? keyHintText({ key: '/', action: 'commands' })
    : undefined;
  const ctrlC = keyHintText({ key: 'Ctrl-C', action: ctrlCAction });
  const hold = holdAvailable
    ? keyHintText({ key: 'Shift-Tab', action: 'send after turn' })
    : undefined;
  return firstFittingCandidate({
    candidates: [
      hold &&
        statusBarBindingRow([
          parentBack,
          childList,
          fullOutput,
          script,
          hold,
          commands,
          ctrlC,
        ]),
      statusBarBindingRow([
        parentBack,
        childList,
        fullOutput,
        script,
        commands,
        ctrlC,
      ]),
      statusBarBindingRow([parentBack, childList, fullOutput, script, ctrlC]),
      statusBarBindingRow([parentBack, childList, fullOutput, ctrlC]),
      statusBarBindingRow([parentBack, childList, ctrlC]),
      parentBack && statusBarBindingRow([parentBack, ctrlC]),
      // Past Ctrl-C's width, the one navigation key still beats it: Ctrl-C
      // works without being named, the way out of a child view does not.
      parentBack,
      childList,
    ],
    fallback: ctrlC,
    maxColumns,
    measure: textDisplayWidth,
  });
}

function childListBindingsText(
  {
    selectionKillable = false,
    selectionResumable = false,
  }: StatusBarChildListInput,
  ctrlCAction: CtrlCAction,
  maxColumns: number | undefined,
): string {
  const ctrlCBinding = keyHintText({ key: 'Ctrl-C', action: ctrlCAction });
  const enterBinding = keyHintText({
    key: 'Enter',
    action: selectionResumable ? 'resume' : 'focus',
  });
  const expandBinding = keyHintText({ key: '←/→', action: 'collapse/expand' });
  const killBinding = selectionKillable
    ? keyHintText({ key: 'x', action: 'kill' })
    : undefined;
  const selectBinding = keyHintText({ key: '↑/↓', action: 'select' });
  const inputBinding = keyHintText({ key: 'Tab/Esc', action: 'input' });
  const escBinding = keyHintText({ key: 'Esc', action: 'input' });
  return firstFittingCandidate({
    candidates: [
      statusBarBindingRow([
        selectBinding,
        enterBinding,
        expandBinding,
        killBinding,
        inputBinding,
        ctrlCBinding,
      ]),
      selectionKillable &&
        statusBarBindingRow([
          selectBinding,
          killBinding,
          inputBinding,
          ctrlCBinding,
        ]),
      statusBarBindingRow([enterBinding, inputBinding, ctrlCBinding]),
      // The narrow row keeps the way back to input; Esc alone still fits.
      statusBarBindingRow([enterBinding, escBinding, ctrlCBinding]),
      ctrlCBinding,
    ],
    fallback: ctrlCBinding,
    maxColumns,
    measure: textDisplayWidth,
  });
}

function approvalPolicySegment(
  policy: ApprovalPolicy | undefined,
): StatusBarSegment | undefined {
  let color: StatusBarColor;
  switch (policy) {
    case undefined:
    case 'ask':
      return undefined;
    case 'never':
      color = COLOR_WARNING;
      break;
    case 'yolo':
      color = COLOR_ERROR;
      break;
    default:
      return policy satisfies never;
  }
  // The label the /approval picker and every other surface uses for this
  // policy — the bar is how users confirm their selection took effect.
  return {
    text: approvalPolicyLabel(policy),
    color,
    priority: STATUS_BAR_PRIORITY.approvalPolicy,
    policy: 'drop',
  };
}

interface StatusBarRunTarget {
  readonly ctrlCAction: CtrlCAction;
  readonly displayRunId: RunId | undefined;
  readonly isChildRun: boolean;
}

/**
 * Which run the status bar describes (the active run when the view
 * holds it), and what Ctrl-C does there. `canStop` is the SIGINT handler's
 * own predicate (`chatTuiCanStopVisibleRun`), so the hint cannot disagree
 * with what the key does.
 */
export function statusBarRunTarget({
  activeRunId,
  canStop,
  view,
}: {
  readonly activeRunId: RunId | undefined;
  readonly canStop: boolean;
  readonly view: SessionView;
}): StatusBarRunTarget {
  const active = runViewOf(view, activeRunId);
  let ctrlCAction: CtrlCAction = 'exit';
  if (canStop) ctrlCAction = active?.parentId ? 'stop root' : 'stop';
  return {
    ctrlCAction,
    displayRunId: active?.id,
    isChildRun: active?.parentId != null,
  };
}

// Bypass badges, in emission order. One row per BypassState flag.
const BYPASS_BADGES: ReadonlyArray<{
  readonly field: keyof BypassState;
  readonly text: string;
  readonly badgeColor: typeof COLOR_ERROR | typeof COLOR_WARNING;
}> = [
  {
    field: 'superYolo',
    text: APPROVAL_BYPASS_BADGE.superYolo,
    badgeColor: COLOR_ERROR,
  },
  {
    field: 'bash',
    text: APPROVAL_BYPASS_BADGE.bash,
    badgeColor: COLOR_WARNING,
  },
  {
    field: 'toolEdit',
    text: APPROVAL_BYPASS_BADGE.toolEdit,
    badgeColor: COLOR_WARNING,
  },
];

// Which text occupies the bindings row is a priority order, not a single
// condition: a resumable exit confirmation always wins, then an actual
// foreground surface, then the child list, and only then normal chat shortcuts.
function resolveStatusBarBindings(input: StatusBarChrome): string {
  if (
    input.transientNotice?.kind === 'exit' &&
    input.transientNotice.resumeId
  ) {
    return `${TASK_ACTIONS.resumeHint} ${formatResumeCommand(
      input.commandName,
      input.transientNotice.resumeId,
      { approvalPolicy: input.approvalPolicy },
    )}`;
  }

  const maxColumns = statusBarInnerWidth(input.width);
  const ctrlCAction = input.ctrlCAction ?? 'exit';
  if (input.foreground.inputActive) {
    // The surface above prints its own keys, Esc included; only Ctrl-C,
    // which works over every surface, is the bar's to name.
    return keyHintText({ key: 'Ctrl-C', action: ctrlCAction });
  }
  if (input.childList.focused) {
    return childListBindingsText(input.childList, ctrlCAction, maxColumns);
  }
  return statusBarBindingsText(input.shortcuts, ctrlCAction, maxColumns);
}

/**
 * The bar for the displayed run (`statusBarRunTarget`), read straight off
 * its `RunView` and the view's per-run policy and follow-up queue, around
 * the chrome the TUI supplies.
 */
export function buildStatusBarDisplay(
  run: RunView | undefined,
  view: Pick<SessionView, 'policy' | 'queuedFollowUps' | 'runs'>,
  input: StatusBarChrome,
): StatusBarDisplay {
  const left: StatusBarSegment[] = [
    {
      text: STATUS_DIAMOND,
      color: COLOR_HINT,
      decorative: true,
      priority: STATUS_BAR_PRIORITY.chrome,
      policy: 'keep',
    },
  ];
  const turn = input.turn;
  const active = run != null && isWorking(run);
  const queuedCount =
    run === undefined ? 0 : (view.queuedFollowUps.get(run.id)?.length ?? 0);

  // No run yet: the root keeps its status slot.
  const statusLabel = run ? runStatus(run).word : '-';
  const spinPrefix =
    active && turn?.runningFrame ? `${turn.runningFrame} ` : '';

  // A notice must not hide the only indication that an active run is still
  // alive. Keep that liveness compact so the notice remains the focal text.
  if (input.transientNotice) {
    if (active) {
      const elapsed =
        turn?.elapsedMs === undefined
          ? ''
          : ` ${formatCompactDuration(turn.elapsedMs)}`;
      left.push({
        text: `${spinPrefix}${statusLabel}${elapsed}`,
        compactText:
          turn?.elapsedMs === undefined
            ? 'run'
            : `run ${formatCompactDuration(turn.elapsedMs)}`,
        dim: true,
        priority: STATUS_BAR_PRIORITY.liveness,
        policy: 'keep',
      });
    }
  } else {
    left.push({
      text: `${spinPrefix}${statusLabel}`,
      dim: true,
      priority: STATUS_BAR_PRIORITY.chrome,
      policy: 'keep',
    });
    if (active && turn?.elapsedMs !== undefined) {
      left.push({
        text: formatCompactDuration(turn.elapsedMs),
        dim: true,
        priority: STATUS_BAR_PRIORITY.elapsed,
        policy: 'drop',
      });
    }
  }
  // Routine activity, not caution: these sit onscreen for whole turns, and
  // painting them yellow trains the eye to ignore the color that also
  // announces auto-approval bypasses and quota exhaustion.
  if (run?.compactingActive === true) {
    left.push({
      text: 'compacting...',
      dim: true,
      priority: STATUS_BAR_PRIORITY.compacting,
      policy: 'drop',
    });
  } else if (run?.thinkingActive === true) {
    left.push({
      text: 'thinking...',
      dim: true,
      priority: STATUS_BAR_PRIORITY.thinking,
      policy: 'drop',
    });
  }

  if (input.transientNotice) {
    left.push({
      text: input.transientNotice.text,
      color: COLOR_WARNING,
      priority: STATUS_BAR_PRIORITY.notice,
      policy: 'truncate',
    });
    if (input.transientNotice.kind === 'exit' && queuedCount > 0) {
      // Exiting drops queued follow-ups silently — warn before the user
      // confirms with the second Ctrl-C.
      left.push({
        text: `${formatResultCount(queuedCount, 'queued follow-up')} will be discarded`,
        color: COLOR_ERROR,
        priority: STATUS_BAR_PRIORITY.discardWarning,
        policy: 'truncate',
      });
    }
  }

  // Every direct and nested subagent the displayed run owns.
  const subagents = run?.rollup.total ?? 0;
  left.push(
    ...(
      [
        input.ctrlCAction === 'stop root' && !active
          ? {
              text: 'root active',
              color: COLOR_WARNING,
              priority: STATUS_BAR_PRIORITY.rootActive,
              policy: 'drop',
            }
          : undefined,
        input.subscriptionProbeFailed
          ? {
              text: 'subscription status unavailable',
              compactText: 'sub unknown',
              color: COLOR_WARNING,
              priority: STATUS_BAR_PRIORITY.accessMode,
              policy: 'drop',
            }
          : accessModeSegment(input.modelAccess),
        subscriptionQuotaSegment(input.subscriptionQuota),
        approvalPolicySegment(input.approvalPolicy),
        input.location
          ? {
              text: input.location.label,
              dim: true,
              priority: STATUS_BAR_PRIORITY.location,
              policy: 'drop',
            }
          : undefined,
        formatUsage(run?.context ?? undefined, run?.usage),
        taskCostSegment(run, view),
        queuedCount > 0
          ? {
              text: `queued ${queuedCount}`,
              color: COLOR_WARNING,
              priority: STATUS_BAR_PRIORITY.queuedFollowUp,
              policy: 'drop',
            }
          : undefined,
        subagents > 0
          ? {
              text: formatResultCount(subagents, 'agent'),
              compactText: `${subagents} ${NESTED_AGENT.compactCountSuffix}`,
              dim: true,
              priority: STATUS_BAR_PRIORITY.activeSubagent,
              policy: 'drop',
            }
          : undefined,
        input.runningSessions > 0
          ? {
              text: `${input.runningSessions} active`,
              compactText: `${input.runningSessions} ${NESTED_AGENT.compactLiveSuffix}`,
              dim: true,
              priority: STATUS_BAR_PRIORITY.activeSubagent,
              policy: 'drop',
            }
          : undefined,
        input.approvalDepth > 0
          ? {
              text: formatResultCount(
                input.approvalDepth,
                input.approvalKind ?? 'approval',
              ),
              color: COLOR_WARNING,
              priority: STATUS_BAR_PRIORITY.approvalDepth,
              policy: 'drop',
            }
          : undefined,
      ] satisfies (StatusBarSegment | undefined)[]
    ).filter(Predicate.isNotNullish),
  );
  const bypasses = run === undefined ? undefined : runBypasses(view, run.id);
  for (const badge of BYPASS_BADGES) {
    if (bypasses?.[badge.field] === true) {
      left.push({
        text: badge.text,
        badge: true,
        badgeColor: badge.badgeColor,
        priority: STATUS_BAR_PRIORITY.bypassBadge,
        policy: 'keep',
      });
    }
  }
  const fittedLeft = fitStatusBarLeftSegments(left, input.width);

  return {
    left: fittedLeft,
    bindings: resolveStatusBarBindings(input),
  };
}
