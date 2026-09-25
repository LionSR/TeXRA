import { isSubscriptionRoute } from '@cli/runtime/modelAccessRoute';
import {
  firstFittingCandidate,
  textDisplayWidth,
  truncateSummaryToWidth,
} from '@cli/runtime/terminalText';
import { COLOR_ERROR, COLOR_HINT, COLOR_WARNING } from '@cli/tui/ui/colors';
import { STATUS_DIAMOND } from '@cli/tui/ui/glyphs';
import { KEY_HINT_SEPARATOR, keyHintText } from '@cli/tui/ui/KeyHints';
import type { TexraApprovalPolicy } from '@shared/approvalPolicy';
import { codingPlanForUsageRoute } from '@shared/codingPlanSubscriptions';
import { contextGaugeBand, roundedContextPercent } from '@shared/contextGauge';
import {
  type ContextStateData,
  type SubscriptionUsageSnapshot,
  type SubscriptionUsageProvider,
  type ApprovalPolicySnapshot,
  type RunId,
  type TokenUsageStats,
  type UsageRoute,
} from '@shared/schemas';
import { isActivePhase } from '@shared/runs/runStatus';
import {
  flowPosition,
  formatFlowPositionLabel,
} from '@shared/runs/runStatusDisplay';
import type { RunView, SessionView } from '@shared/session/sessionView';
import { RUNNING_SESSION, SESSION_LIST, SUBAGENT } from '@ui/copy/nestedRuns';
import { APPROVAL_BYPASS_BADGE } from '@ui/copy/approvalBypass';
import { assertNever, filterNotNullish, unique } from '@utils/core';
import {
  formatCompactDuration,
  formatCompactTokenCount,
  formatResultCount,
} from '@utils/text/stringUtils';

import { formatResumeCommand } from '../state/resumeHint';
import { type TransientNotice } from '../state/cliState';
import { runPhaseOf, runViewOf } from '../state/sessionView';
import type { PendingApprovalKind } from '../state/approvalQueue';

/** The approval bypass flags a run's policy snapshot carries. */
export type BypassState = ApprovalPolicySnapshot['bypasses'];

/** What the pending-interaction count names: approvals, questions, or both. */
export type ApprovalQueueStatusKind = 'approval' | 'question' | 'request';

function statusKindForApproval(
  kind: PendingApprovalKind,
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
      return assertNever(kind, 'Unknown approval payload kind');
  }
}

export function approvalQueueStatusKind(
  kinds: Iterable<PendingApprovalKind>,
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

// 'dim' is not an Ink color name — it is a sentinel this file's own renderer
// (`StatusBar.tsx`) reads to apply `dimColor` instead of an explicit `color`.
type StatusBarColor =
  typeof COLOR_HINT | typeof COLOR_WARNING | typeof COLOR_ERROR | 'dim';
type CtrlCAction = 'exit' | 'stop' | 'stop root';

/** Choose the quota owner, preferring the route of completed usage. */
export function subscriptionUsageProviderForStatus({
  usageRoute,
  prospectiveRoute,
}: {
  readonly usageRoute: UsageRoute | undefined;
  readonly prospectiveRoute: UsageRoute | undefined;
}): SubscriptionUsageProvider | undefined {
  const route = usageRoute ?? prospectiveRoute;
  if (route === 'chatgpt-subscription') return 'chatgpt';
  return codingPlanForUsageRoute(route)?.usageProvider;
}

interface StatusBarSegment {
  readonly text: string;
  readonly color?: StatusBarColor;
  readonly badge?: boolean;
  readonly badgeColor?: typeof COLOR_ERROR | typeof COLOR_WARNING;
  readonly compactPriority?: number;
  /** Shorter replacement text tried (in priority order) before the segment
   *  is removed outright when the bar overflows the terminal width. */
  readonly compactText?: string;
  /** Purely visual glyphs hidden from screen readers (`aria-hidden`). */
  readonly decorative?: boolean;
}

/**
 * What the status bar shows beyond the displayed run's own facts, which it
 * reads straight off the `RunView` (`buildStatusBarDisplay`'s `run`): the
 * turn clock, the session chrome, and which surface owns input.
 */
export interface StatusBarChrome {
  /** Liveness of the running turn: omitted entirely in tests/headless runs,
   *  same as each of its fields individually. */
  readonly turn?: StatusBarTurnInput;
  readonly transientNotice: TransientNotice | undefined;
  readonly commandName?: string;
  /** Visible child sessions still in flight (see RUNNING_SESSION copy). */
  readonly runningSessions: number;
  readonly approvalDepth: number;
  readonly approvalKind?: ApprovalQueueStatusKind;
  readonly modelAccess: UsageRoute | undefined;
  /** The prospective subscription route could not be resolved. */
  readonly subscriptionProbeFailed?: boolean;
  /** Latest quota snapshot for the subscription serving this model. */
  readonly subscriptionQuota?: SubscriptionUsageSnapshot;
  /** Session approval policy; a non-default policy earns a segment. */
  readonly approvalPolicy?: TexraApprovalPolicy;
  /** Terminal width in columns. */
  readonly width?: number;
  readonly ctrlCAction?: CtrlCAction;
  /** Nested-session location (`Survey (1/1) › Agent runtime`). Omitted on
   *  the root session, where the header already names the conversation. */
  readonly location?: { readonly context?: string; readonly label: string };
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
  /** True when bare Escape can focus the active run's immediate parent. */
  readonly parentNavigationAvailable?: boolean;
  /** True when the persistent child list has a session row. */
  readonly childNavigationAvailable?: boolean;
  /** True when the focused run has output that can be printed in full. */
  readonly transcriptAvailable?: boolean;
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
  return isSubscriptionRoute(access)
    ? {
        text: 'subscription',
        color: COLOR_HINT,
        compactText: 'sub',
        compactPriority: STATUS_BAR_COMPACT_PRIORITY.accessMode,
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
  let color: StatusBarColor = 'dim';
  if (remaining === 0) color = COLOR_ERROR;
  else if (remaining <= 20) color = COLOR_WARNING;
  return {
    text: `${snapshot.planName} ${remaining}% left`,
    compactText: `${remaining}% left`,
    color,
    compactPriority: STATUS_BAR_COMPACT_PRIORITY.subscriptionQuota,
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
  const base = { compactPriority: STATUS_BAR_COMPACT_PRIORITY.usage };
  if (!contextState) {
    const reported = usage?.inputTokens ?? 0;
    if (reported <= 0) return undefined;
    return { ...base, text: formatCompactTokenCount(reported), color: 'dim' };
  }

  // Occupancy is input tokens only — the prompt that fills the window. Output
  // tokens are the generated response, not part of the context, which is why
  // the run reports `inputTokens` here.
  const { inputTokens: used, contextWindow, utilizationPercent } = contextState;
  const percent = roundedContextPercent(utilizationPercent);
  // Reads the run's own `utilizationPercent`, not a used/contextWindow
  // re-derivation (drifts); shared bands/rounding with UsagePanel's gauge.
  const band = contextGaugeBand(utilizationPercent);
  let color: StatusBarColor = 'dim';
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
    color,
  };
}

// Lower values are removed first when the left status group exceeds the row.
const STATUS_BAR_COMPACT_PRIORITY = {
  activeSubagent: 20,
  flow: 30,
  usage: 40,
  queuedFollowUp: 50,
  approvalPolicy: 55,
  approvalDepth: 60,
  rootActive: 65,
  subscriptionQuota: 67,
  elapsed: 70,
  // Durable session status: outlives the transient counts above but must
  // still be compactable — a priority-less segment breaks narrow bars (see
  // bypassBadge below).
  accessMode: 72,
  location: 74,
  thinking: 75,
  compacting: 80,
  // Bypass badges announce active auto-approval — the one thing the bar must
  // not silently drop, so they compact dead last. Every segment carries SOME
  // priority: the fitting sweeps only visit prioritized segments, and a
  // priority-less segment is unfittable — the row then soft-wraps and breaks
  // the 2-row chrome budget on narrow terminals.
  bypassBadge: 85,
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

// Shrink `segment` (always the untruncated original, so repeated fits never
// compound) into whatever room the rest of the row leaves at `index`.
function truncateSegmentIntoRemainingWidth(
  fitted: readonly StatusBarSegment[],
  index: number,
  segment: StatusBarSegment,
  innerWidth: number,
): StatusBarSegment {
  const fixedWidth = fitted.reduce(
    (total, other, otherIndex) =>
      otherIndex === index ? total : total + statusBarSegmentWidth(other),
    fitted.length - 1,
  );
  return {
    ...segment,
    text: truncateSummaryToWidth(
      segment.text,
      Math.max(0, innerWidth - fixedWidth),
    ),
  };
}

function fitTransientNoticeStatusBarLeftSegments(
  segments: readonly StatusBarSegment[],
  noticeIndex: number,
  livenessIndex: number | undefined,
  discardWarningIndex: number | undefined,
  width: number | undefined,
): readonly StatusBarSegment[] {
  const innerWidth = statusBarInnerWidth(width);
  if (innerWidth === undefined) return segments;

  const fitted = [...segments];
  const notice = fitted[noticeIndex];
  let fittedNotice = notice;
  let liveness =
    livenessIndex === undefined ? undefined : fitted[livenessIndex];
  const discardWarning =
    discardWarningIndex === undefined ? undefined : fitted[discardWarningIndex];
  // Bypass badges announce active auto-approval and must not be silently
  // dropped by the trailing-removal sweep below (see
  // STATUS_BAR_COMPACT_PRIORITY.bypassBadge) — they are exempt here the same
  // way discardWarning is, and only give way to the final fallback sweep.
  const isBypassBadge = (segment: StatusBarSegment): boolean =>
    segment.compactPriority === STATUS_BAR_COMPACT_PRIORITY.bypassBadge;

  // Compact liveness before removing content. In particular, the queued-input
  // discard warning is safety-critical and must not be displaced by the wider
  // animated form of the running marker.
  if (liveness?.compactText && statusBarSegmentsWidth(fitted) > innerWidth) {
    const index = fitted.indexOf(liveness);
    liveness = { ...liveness, text: liveness.compactText };
    fitted[index] = liveness;
  }

  // Remove trailing segments after the notice (excluding the discard warning
  // and bypass badges).
  while (statusBarSegmentsWidth(fitted) > innerWidth) {
    const removableIndex = fitted.findLastIndex(
      (segment, index) =>
        index > noticeIndex &&
        segment !== discardWarning &&
        !isBypassBadge(segment),
    );
    if (removableIndex < 0) break;
    fitted.splice(removableIndex, 1);
  }

  // Remove segments before the notice (except liveness).
  if (statusBarSegmentsWidth(fitted) > innerWidth) {
    for (let index = noticeIndex - 1; index > 0; index -= 1) {
      if (fitted[index] !== liveness) fitted.splice(index, 1);
    }
  }

  const fitNotice = (): void => {
    const fittedNoticeIndex = fittedNotice ? fitted.indexOf(fittedNotice) : -1;
    if (fittedNoticeIndex < 0 || statusBarSegmentsWidth(fitted) <= innerWidth) {
      return;
    }
    fittedNotice = truncateSegmentIntoRemainingWidth(
      fitted,
      fittedNoticeIndex,
      notice,
      innerWidth,
    );
    fitted[fittedNoticeIndex] = fittedNotice;
  };

  fitNotice();

  // At widths where the safety warning and liveness cannot coexist, the
  // destructive-action warning wins. Refit the notice into the released room.
  if (
    discardWarning &&
    liveness &&
    statusBarSegmentsWidth(fitted) > innerWidth
  ) {
    fitted.splice(fitted.indexOf(liveness), 1);
    liveness = undefined;
    fitNotice();
  }

  const sacrificeBypassBadgesUntilFit = (): void => {
    while (statusBarSegmentsWidth(fitted) > innerWidth) {
      const badgeIndex = fitted.findLastIndex(isBypassBadge);
      if (badgeIndex < 0) break;
      fitted.splice(badgeIndex, 1);
      fitNotice();
    }
  };

  // Preserve the destructive-action warning before retaining auto-approval
  // badges. Otherwise warning truncation can reduce it to empty text, making
  // the row fit while hiding that queued input will be discarded.
  if (discardWarning) sacrificeBypassBadgesUntilFit();

  // Extremely narrow terminals may not fit even the full discard warning.
  // Drop the lower-priority confirmation text and truncate the warning so the
  // status row never exceeds its layout budget.
  if (discardWarning && statusBarSegmentsWidth(fitted) > innerWidth) {
    const fittedNoticeIndex = fittedNotice ? fitted.indexOf(fittedNotice) : -1;
    if (fittedNoticeIndex >= 0) fitted.splice(fittedNoticeIndex, 1);
    const fittedWarningIndex = fitted.indexOf(discardWarning);
    fitted[fittedWarningIndex] = truncateSegmentIntoRemainingWidth(
      fitted,
      fittedWarningIndex,
      discardWarning,
      innerWidth,
    );
  }

  // Last resort: a bypass badge wider than innerWidth is unfittable above and
  // would soft-wrap the row, breaking the 2-row chrome budget. Sacrifice
  // badges from the tail — mirroring how liveness is sacrificed above — only
  // while the row still overflows.
  sacrificeBypassBadgesUntilFit();

  return fitted;
}

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

  const compacted = [...segments];
  const priorities = unique(
    compacted
      .map((segment) => segment.compactPriority)
      .filter(filterNotNullish),
  ).sort((a, b) => a - b);

  // Lowest-priority segments compact first; returns as soon as the row fits.
  const sweep = (
    apply: (index: number, segment: StatusBarSegment) => boolean,
  ): readonly StatusBarSegment[] | undefined => {
    for (const priority of priorities) {
      for (let index = compacted.length - 1; index >= 0; index -= 1) {
        const segment = compacted[index];
        if (segment?.compactPriority !== priority || !apply(index, segment)) {
          continue;
        }
        if (statusBarSegmentsWidth(compacted) <= innerWidth) return compacted;
      }
    }
    return undefined;
  };

  return (
    // Shrink segments to their compactText before removing anything — a
    // narrowed segment beats a missing one.
    sweep((index, segment) => {
      if (!segment.compactText || segment.compactText === segment.text) {
        return false;
      }
      compacted[index] = { ...segment, text: segment.compactText };
      return true;
    }) ??
    sweep((index) => {
      compacted.splice(index, 1);
      return true;
    }) ??
    compacted
  );
}

// Bindings use the shared KeyHints vocabulary (`key action` joined with
// KEY_HINT_SEPARATOR) so the status bar and modal footers read as one system
// (.agents/docs/archived/feature/2026-05-14-cli-tui-ink/2026-05-14-10-architecture.md § Intuitiveness conventions).
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
    childNavigationAvailable = false,
    parentNavigationAvailable = false,
    transcriptAvailable = false,
  }: StatusBarShortcutsInput,
  ctrlCAction: CtrlCAction,
  maxColumns: number | undefined,
): string {
  const parentBack = parentNavigationAvailable
    ? keyHintText({ key: 'Esc', action: SESSION_LIST.parentAction })
    : undefined;
  const childList = childNavigationAvailable
    ? keyHintText({ key: 'Tab', action: SESSION_LIST.openAction })
    : undefined;
  const fullOutput = transcriptAvailable
    ? keyHintText({ key: 'Ctrl-T', action: 'transcript' })
    : undefined;
  const commands = chatInputAvailable
    ? keyHintText({ key: '/', action: 'commands' })
    : undefined;
  const ctrlC = keyHintText({ key: 'Ctrl-C', action: ctrlCAction });
  return firstFittingCandidate({
    candidates: [
      statusBarBindingRow([parentBack, childList, fullOutput, commands, ctrlC]),
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
  const tabBinding = keyHintText({ key: 'Tab', action: 'input' });
  const escBinding = keyHintText({ key: 'Esc', action: 'input' });
  return firstFittingCandidate({
    candidates: [
      statusBarBindingRow([
        selectBinding,
        enterBinding,
        expandBinding,
        killBinding,
        tabBinding,
        escBinding,
        ctrlCBinding,
      ]),
      selectionKillable &&
        statusBarBindingRow([
          selectBinding,
          killBinding,
          tabBinding,
          escBinding,
          ctrlCBinding,
        ]),
      statusBarBindingRow([enterBinding, escBinding, ctrlCBinding]),
      ctrlCBinding,
    ],
    fallback: ctrlCBinding,
    maxColumns,
    measure: textDisplayWidth,
  });
}

function approvalPolicySegment(
  policy: TexraApprovalPolicy | undefined,
): StatusBarSegment | undefined {
  switch (policy) {
    case undefined:
    case 'ask':
      return undefined;
    case 'never':
      // Same word the /approval picker uses for this policy — the bar is how
      // users confirm their selection took effect.
      return {
        text: 'never',
        color: COLOR_WARNING,
        compactPriority: STATUS_BAR_COMPACT_PRIORITY.approvalPolicy,
      };
    case 'yolo':
      return {
        text: 'auto-approve',
        color: COLOR_ERROR,
        compactPriority: STATUS_BAR_COMPACT_PRIORITY.approvalPolicy,
      };
    default:
      return policy satisfies never;
  }
}

interface StatusBarRunTarget {
  readonly ctrlCAction: CtrlCAction;
  readonly displayRunId: RunId | undefined;
  readonly isChildRun: boolean;
}

/**
 * Which run the status bar describes (the active run when the view
 * holds it), and what Ctrl-C does there.
 */
export function statusBarRunTarget({
  activeRunId,
  canStopActiveRun,
  canStopPendingRun = false,
  ownedRunIds,
  view,
}: {
  readonly activeRunId: RunId | undefined;
  readonly canStopActiveRun: boolean;
  readonly canStopPendingRun?: boolean;
  /** The runs this TUI runs: the root run and its descendants. */
  readonly ownedRunIds: readonly RunId[];
  readonly view: SessionView;
}): StatusBarRunTarget {
  const active = runViewOf(view, activeRunId);
  const isLive = (runId: RunId): boolean =>
    isActivePhase(runPhaseOf(runViewOf(view, runId)));
  const hasLiveRun = ownedRunIds.some(isLive);
  const canStopVisibleRun =
    canStopActiveRun && (canStopPendingRun || hasLiveRun);
  let ctrlCAction: CtrlCAction;
  if (!canStopVisibleRun) {
    ctrlCAction = 'exit';
  } else {
    ctrlCAction = active?.parentId ? 'stop root' : 'stop';
  }
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
    return `Resume this session with: ${formatResumeCommand(
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
  view: Pick<SessionView, 'policy' | 'queuedFollowUps'>,
  input: StatusBarChrome,
): StatusBarDisplay {
  const left: StatusBarSegment[] = [
    { text: STATUS_DIAMOND, color: COLOR_HINT, decorative: true },
  ];
  const turn = input.turn;
  const status = runPhaseOf(run);
  const active = isActivePhase(status);
  const queuedCount =
    run === undefined ? 0 : (view.queuedFollowUps.get(run.id)?.length ?? 0);

  // No run yet: the root keeps its status slot.
  const statusLabel = run?.statusLabel ?? '-';
  const spinPrefix =
    active && turn?.runningFrame ? `${turn.runningFrame} ` : '';

  // A notice must not hide the only indication that an active run is still
  // alive. Keep that liveness compact so the notice remains the focal text.
  let transientLivenessIndex: number | undefined;
  if (input.transientNotice) {
    if (active) {
      const elapsed =
        turn?.elapsedMs === undefined
          ? ''
          : ` ${formatCompactDuration(turn.elapsedMs)}`;
      transientLivenessIndex = left.length;
      left.push({
        text: `${spinPrefix}${statusLabel}${elapsed}`,
        compactText:
          turn?.elapsedMs === undefined
            ? 'run'
            : `run ${formatCompactDuration(turn.elapsedMs)}`,
        color: 'dim',
      });
    }
  } else {
    left.push({
      text: `${spinPrefix}${statusLabel}`,
      color: 'dim',
    });
    if (active && turn?.elapsedMs !== undefined) {
      left.push({
        text: formatCompactDuration(turn.elapsedMs),
        color: 'dim',
        compactPriority: STATUS_BAR_COMPACT_PRIORITY.elapsed,
      });
    }
  }
  // Routine activity, not caution: these sit onscreen for whole turns, and
  // painting them yellow trains the eye to ignore the color that also
  // announces auto-approval bypasses and quota exhaustion.
  if (run?.compactingActive === true && active) {
    left.push({
      text: 'compacting...',
      color: 'dim',
      compactPriority: STATUS_BAR_COMPACT_PRIORITY.compacting,
    });
  } else if (run?.thinkingActive === true && active) {
    left.push({
      text: 'thinking...',
      color: 'dim',
      compactPriority: STATUS_BAR_COMPACT_PRIORITY.thinking,
    });
  }

  let transientNoticeIndex: number | undefined;
  let discardWarningIndex: number | undefined;
  if (input.transientNotice) {
    transientNoticeIndex = left.length;
    left.push({ text: input.transientNotice.text, color: COLOR_WARNING });
    if (input.transientNotice.kind === 'exit' && queuedCount > 0) {
      // Exiting drops queued follow-ups silently — warn before the user
      // confirms with the second Ctrl-C.
      discardWarningIndex = left.length;
      left.push({
        text: `${formatResultCount(queuedCount, 'queued follow-up')} will be discarded`,
        color: COLOR_ERROR,
      });
    }
  }

  // One slot carries a reflection run's round (mirrors the SubagentList row's
  // `flowLabel`). A chat's turn count is not something anyone acts on.
  const position = flowPosition(run?.flow ?? undefined);
  // Every direct and nested subagent the displayed run owns.
  const subagents = run?.rollup.total ?? 0;
  const flowText =
    position?.kind === 'turn' ? undefined : formatFlowPositionLabel(position);
  left.push(
    ...(
      [
        input.ctrlCAction === 'stop root' && !active
          ? {
              text: 'root active',
              color: COLOR_WARNING,
              compactPriority: STATUS_BAR_COMPACT_PRIORITY.rootActive,
            }
          : undefined,
        input.subscriptionProbeFailed
          ? {
              text: 'subscription status unavailable',
              compactText: 'sub unknown',
              color: COLOR_WARNING,
              compactPriority: STATUS_BAR_COMPACT_PRIORITY.accessMode,
            }
          : accessModeSegment(input.modelAccess),
        subscriptionQuotaSegment(input.subscriptionQuota),
        approvalPolicySegment(input.approvalPolicy),
        input.location
          ? {
              text: input.location.context
                ? `${input.location.context} › ${input.location.label}`
                : input.location.label,
              compactText: input.location.context ?? input.location.label,
              color: 'dim',
              compactPriority: STATUS_BAR_COMPACT_PRIORITY.location,
            }
          : undefined,
        flowText === undefined
          ? undefined
          : {
              text: flowText,
              color: 'dim',
              compactPriority: STATUS_BAR_COMPACT_PRIORITY.flow,
            },
        formatUsage(run?.context ?? undefined, run?.usage),
        queuedCount > 0
          ? {
              text: `queued ${queuedCount}`,
              color: COLOR_WARNING,
              compactPriority: STATUS_BAR_COMPACT_PRIORITY.queuedFollowUp,
            }
          : undefined,
        subagents > 0
          ? {
              text: formatResultCount(subagents, 'agent'),
              compactText: `${subagents} ${SUBAGENT.compactCountSuffix}`,
              color: 'dim',
              compactPriority: STATUS_BAR_COMPACT_PRIORITY.activeSubagent,
            }
          : undefined,
        input.runningSessions > 0
          ? {
              text: `${input.runningSessions} active`,
              compactText: `${input.runningSessions} ${RUNNING_SESSION.compactCountSuffix}`,
              color: 'dim',
              compactPriority: STATUS_BAR_COMPACT_PRIORITY.activeSubagent,
            }
          : undefined,
        input.approvalDepth > 0
          ? {
              text: formatResultCount(
                input.approvalDepth,
                input.approvalKind ?? 'approval',
              ),
              color: COLOR_WARNING,
              compactPriority: STATUS_BAR_COMPACT_PRIORITY.approvalDepth,
            }
          : undefined,
      ] satisfies (StatusBarSegment | undefined)[]
    ).filter(filterNotNullish),
  );
  const bypass = run === undefined ? undefined : view.policy.get(run.id);
  for (const badge of BYPASS_BADGES) {
    if (bypass?.bypasses[badge.field]) {
      left.push({
        text: badge.text,
        badge: true,
        badgeColor: badge.badgeColor,
        compactPriority: STATUS_BAR_COMPACT_PRIORITY.bypassBadge,
      });
    }
  }
  const fittedLeft =
    transientNoticeIndex !== undefined
      ? fitTransientNoticeStatusBarLeftSegments(
          left,
          transientNoticeIndex,
          transientLivenessIndex,
          discardWarningIndex,
          input.width,
        )
      : fitStatusBarLeftSegments(left, input.width);

  return {
    left: fittedLeft,
    bindings: resolveStatusBarBindings(input),
  };
}
