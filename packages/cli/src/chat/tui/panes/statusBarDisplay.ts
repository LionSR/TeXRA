import {
  defaultShortcutModifierLabel,
  metaChordLabel,
} from '@cli/runtime/shortcutLabels';
import {
  textDisplayWidth,
  truncateSummaryToWidth,
} from '@cli/runtime/terminalText';
import { COLOR_ERROR, COLOR_HINT, COLOR_WARNING } from '@cli/tui/ui/colors';
import { STATUS_DIAMOND } from '@cli/tui/ui/glyphs';
import { KEY_HINT_SEPARATOR, keyHintText } from '@cli/tui/ui/KeyHints';
import { STATUS_BAR_HORIZONTAL_PADDING } from '@cli/tui/ui/theme';
import type { TexraApprovalPolicy } from '@shared/approvalPolicy';
import {
  codingPlanForUsageRoute,
  CODING_PLAN_SUBSCRIPTIONS,
} from '@shared/codingPlanSubscriptions';
import {
  type ContextStateData,
  type SubscriptionUsageSnapshot,
  type SubscriptionUsageProvider,
  type StreamPhase,
  type StreamStage,
  type StreamSubstate,
  type StreamTabId,
  type TokenUsageStats,
  type UsageRoute,
} from '@shared/schemas';
import { usageRouteBadge } from '@shared/copy/modelAccess';
import {
  FOREGROUND_OWNERSHIP,
  RUNNING_SESSION,
  SESSION_LIST,
  SUBAGENT,
} from '@shared/copy/nestedRuns';
import { isActivePhase } from '@shared/streams/streamStatus';
import { formatStageLabel } from '@shared/streams/streamStatusDisplay';
import {
  filterNotNullish,
  formatCompactDuration,
  formatCompactTokenCount,
  unique,
} from '@utils/core';
import { formatResultCount } from '@utils/text/stringUtils';

import { formatCliStatusLabel } from '../sessionStatus';
import { formatResumeCommand } from '../state/resumeHint';
import {
  type BypassState,
  type StreamSlice,
  type TransientNotice,
} from '../state/cliState';
import {
  activeStreamScope,
  nearestActiveStreamAncestor,
} from '../state/streamViews';
import type { ApprovalQueueStatusKind } from '../state/approvalQueue';

// 'dim' is not an Ink color name — it is a sentinel this file's own renderer
// (`StatusBar.tsx`) reads to apply `dimColor` instead of an explicit `color`.
type StatusBarColor =
  typeof COLOR_HINT | typeof COLOR_WARNING | typeof COLOR_ERROR | 'dim';
type CtrlCAction = 'exit' | 'stop' | 'stop root';

/** Choose the quota owner, preferring the route of completed usage. */
export function subscriptionUsageProviderForStatus({
  usageRoute,
  modelAccess,
  prospectiveCodingPlan,
}: {
  readonly usageRoute: UsageRoute | undefined;
  readonly modelAccess: UsageRoute;
  readonly prospectiveCodingPlan?: SubscriptionUsageProvider;
}): SubscriptionUsageProvider | undefined {
  if (usageRoute === 'chatgpt-subscription') return 'chatgpt';
  const completedCodingPlan = codingPlanForUsageRoute(usageRoute);
  if (completedCodingPlan) return completedCodingPlan.usageProvider;
  if (usageRoute !== undefined) return undefined;
  if (modelAccess === 'chatgpt-subscription') return 'chatgpt';
  return CODING_PLAN_SUBSCRIPTIONS.find(
    (plan) =>
      plan.usageProvider === prospectiveCodingPlan &&
      plan.usageRoute === modelAccess,
  )?.usageProvider;
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

export interface StatusBarDisplayInput {
  readonly status: StreamPhase | undefined;
  readonly substate?: StreamSubstate;
  /** Milliseconds since the running turn began. When set and `status` is
   *  `running`, the bar shows a live `Ns` segment so a long token-less
   *  "thinking" turn still reads as alive. Omitted in tests/headless. */
  readonly elapsedMs?: number;
  /** Current 1 Hz spin-cycle character (see `ui/LoadingIndicator`'s
   *  `loadingFrameAt`) shown ahead of the status label while a turn is
   *  active, so "running" reads as alive rather than a static word. Omitted
   *  in tests/headless, same as `elapsedMs`. */
  readonly runningFrame?: string;
  readonly transientNotice: TransientNotice | undefined;
  readonly commandName?: string;
  readonly bypass: BypassState;
  readonly thinkingActive?: boolean;
  readonly compactingActive?: boolean;
  readonly queuedFollowUpMessages: readonly string[];
  /** Latest usage snapshot — read for `usageRoute` (which subscription quota
   *  to show), never for context occupancy: that is `contextState`. */
  readonly usage: TokenUsageStats | undefined;
  /** Model-handler-authoritative context occupancy for the displayed stream
   *  (`StreamExecutionState.contextState`). */
  readonly contextState: ContextStateData | undefined;
  readonly stage: StreamStage | undefined;
  /** Retained and active direct subagents owned by the displayed stream. */
  readonly subagents: number;
  /** Visible child sessions still in flight (see RUNNING_SESSION copy). */
  readonly runningSessions: number;
  readonly approvalDepth: number;
  readonly approvalKind?: ApprovalQueueStatusKind;
  readonly modelAccess: UsageRoute;
  /** Latest quota snapshot for the subscription serving this model. */
  readonly subscriptionQuota?: SubscriptionUsageSnapshot;
  /** Ephemeral transcripts cannot be resumed and require a persistent warning. */
  readonly transcriptMode?: 'persistent' | 'ephemeral';
  readonly approvalPolicy?: TexraApprovalPolicy;
  /** Terminal width in columns. */
  readonly width?: number;
  readonly ctrlCAction?: CtrlCAction;
  /** True when `status` belongs to a focused child/subagent stream rather
   *  than the root session — see `statusBarStreamTarget`. */
  readonly isChildStream?: boolean;
  /** Nested-session location (`Survey (1/1) › Agent runtime`). Omitted on
   *  the root session, where the header already names the conversation. */
  readonly location?: string;
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

interface StatusBarForegroundInput {
  /** True while a modal, form, palette, or search surface owns input. */
  readonly inputActive?: boolean;
  /** Label for the foreground surface's Escape action while `shortcutsActive`
   *  is false. */
  readonly escapeAction?: string;
  /** False while a foreground surface owns input and global chat shortcuts
   *  are intentionally inactive. */
  readonly shortcutsActive?: boolean;
}

interface StatusBarChildListInput {
  /** True while the persistent child list, rather than the input, owns keys. */
  readonly focused?: boolean;
  readonly selectionKillable?: boolean;
  /** True while the focused row is an in-flight workflow-script grandchild
   *  that can be skipped or retried. */
  readonly selectionWorkflowControllable?: boolean;
}

interface StatusBarShortcutsInput {
  readonly agentSelectionAvailable?: boolean;
  /** True when slash commands and text entry are actionable in this view. */
  readonly chatInputAvailable: boolean;
  /** True when bare Escape can focus the active stream's immediate parent. */
  readonly parentNavigationAvailable?: boolean;
  /** True when the persistent child list has a session row. */
  readonly childNavigationAvailable?: boolean;
  /** True when Alt/Esc-1..9 has at least one stream target. */
  readonly streamFocusAvailable?: boolean;
  readonly modifierLabel?: string;
  /** Advertise Shift+Enter for newline when the Kitty keyboard protocol is
   *  active; otherwise the universal Ctrl-J is the only reliable binding. */
  readonly shiftEnterNewline?: boolean;
  /** True when the focused stream has output that can be printed in full. */
  readonly transcriptAvailable?: boolean;
}

interface StatusBarDisplay {
  readonly left: readonly StatusBarSegment[];
  readonly bindings: string;
}

function accessModeSegment(access: UsageRoute): StatusBarSegment {
  // `usageRouteBadge` is undefined only for an unset route; the bar always
  // resolves one through `resolveCliModelAccessRoute`.
  const badge = usageRouteBadge(access)!;
  // The bar names how the call is paid for, not which subscription; the /api
  // form and /status name the subscription itself.
  return badge.subscription
    ? {
        text: 'subscription',
        color: COLOR_HINT,
        compactText: 'sub',
        compactPriority: STATUS_BAR_COMPACT_PRIORITY.accessMode,
      }
    : {
        text: badge.compactLabel,
        color: 'dim',
        compactPriority: STATUS_BAR_COMPACT_PRIORITY.accessMode,
      };
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

// The gauge renders `StreamExecutionState.contextState` — the model handler's
// own reading of the window it served the last response under, which is the
// only value that stays right across subscription caps and compaction. The
// `usage` fallback covers the pre-first-response window, where the handler has
// reported no occupancy yet: show the input-token count bare rather than
// substituting a registry window the run may never have used.
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
  // the handler reports `inputTokens` here.
  const { inputTokens: used, contextWindow, utilizationPercent } = contextState;
  const percent = Math.max(1, Math.round(utilizationPercent));
  // Bands match the progress view's context gauge (`fillColor` in UsagePanel),
  // and read the handler's own `utilizationPercent` rather than re-dividing
  // used/contextWindow — the same number told two ways drifts.
  let color: StatusBarColor;
  if (utilizationPercent > 80) color = COLOR_ERROR;
  else if (utilizationPercent > 65) color = COLOR_WARNING;
  else color = 'dim';
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

// One status-bar slot carries whichever stage this stream has (mirrors the
// SubagentList row's `stageLabel`).
function locationSegment(
  location: string | undefined,
): StatusBarSegment | undefined {
  if (!location) return undefined;
  const separator = location.indexOf(' › ');
  return {
    text: location,
    compactText: separator >= 0 ? location.slice(0, separator) : location,
    color: 'dim',
    compactPriority: STATUS_BAR_COMPACT_PRIORITY.location,
  };
}

function stageSegment(
  stage: StreamStage | undefined,
): StatusBarSegment | undefined {
  if (stage === undefined) return undefined;
  const text = formatStageLabel(stage);
  if (text === undefined) return undefined;
  return {
    text,
    // Keep stage visibility on narrow terminals: degrade to the bare
    // current round/phase label instead of dropping the planned total's
    // context.
    compactText: formatStageLabel({ ...stage, total: undefined }),
    color: 'dim',
    compactPriority: STATUS_BAR_COMPACT_PRIORITY.stage,
  };
}

// Lower values are removed first when the left status group exceeds the row.
const STATUS_BAR_COMPACT_PRIORITY = {
  activeSubagent: 20,
  stage: 30,
  usage: 40,
  queuedFollowUp: 50,
  approvalPolicy: 55,
  ephemeralBadge: 58,
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

function queuedFollowUpsCountSegment(
  messages: readonly string[],
): StatusBarSegment | undefined {
  return messages.length > 0
    ? {
        text: `queued ${messages.length}`,
        color: COLOR_WARNING,
        compactPriority: STATUS_BAR_COMPACT_PRIORITY.queuedFollowUp,
      }
    : undefined;
}

function subagentsSegment(subagents: number): StatusBarSegment | undefined {
  return subagents > 0
    ? {
        text: formatResultCount(subagents, 'agent'),
        compactText: `${subagents} ${SUBAGENT.compactCountSuffix}`,
        color: 'dim',
        compactPriority: STATUS_BAR_COMPACT_PRIORITY.activeSubagent,
      }
    : undefined;
}

function runningSessionsSegment(
  runningSessions: number,
): StatusBarSegment | undefined {
  return runningSessions > 0
    ? {
        text: `${runningSessions} active`,
        compactText: `${runningSessions} ${RUNNING_SESSION.compactCountSuffix}`,
        color: 'dim',
        compactPriority: STATUS_BAR_COMPACT_PRIORITY.activeSubagent,
      }
    : undefined;
}

function pendingInteractionSegment({
  depth,
  kind = 'approval',
}: {
  readonly depth: number;
  readonly kind?: ApprovalQueueStatusKind;
}): StatusBarSegment | undefined {
  if (depth <= 0) return undefined;
  return {
    text: formatResultCount(depth, kind),
    color: COLOR_WARNING,
    compactPriority: STATUS_BAR_COMPACT_PRIORITY.approvalDepth,
  };
}

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

  // Compact liveness before removing content. In particular, the queued-input
  // discard warning is safety-critical and must not be displaced by the wider
  // animated form of the running marker.
  if (liveness?.compactText && statusBarSegmentsWidth(fitted) > innerWidth) {
    const index = fitted.indexOf(liveness);
    liveness = { ...liveness, text: liveness.compactText };
    fitted[index] = liveness;
  }

  // Remove trailing segments after the notice (excluding the discard warning).
  while (statusBarSegmentsWidth(fitted) > innerWidth) {
    const removableIndex = fitted.findLastIndex(
      (segment, index) => index > noticeIndex && segment !== discardWarning,
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
// (docs/prds/cli-tui-ink/2026-05-14-10-architecture.md § Intuitiveness conventions).
function statusBarBindingRow(
  bindings: readonly (string | false | undefined)[],
): string {
  return bindings
    .filter((binding): binding is string => !!binding)
    .join(KEY_HINT_SEPARATOR);
}

// Every bindings row below is a widest-first cascade: candidates are built
// eagerly, and the first one that fits the row wins. Inapplicable candidates
// are left in place as `false`/`undefined` so each list still reads top to
// bottom as "this layout, else this one".
function firstRowThatFits(
  candidates: readonly (string | false | undefined)[],
  maxColumns: number | undefined,
  fallback: string,
): string {
  return (
    candidates.find(
      (candidate): candidate is string =>
        typeof candidate === 'string' &&
        (maxColumns === undefined || textDisplayWidth(candidate) <= maxColumns),
    ) ?? fallback
  );
}

// No module-level memo: the bindings cascade below eagerly builds ~13
// candidate rows and stringWidth-measures them until one fits, and its inputs
// are a handful of flags that change far less often than the StatusBar
// re-renders. Any render-path caching belongs in the React component
// (`useMemo`), not in this pure module — module-scoped `let`s survive across
// vitest cases and silently alias inputs if a joined value ever contains '|'.
function statusBarBindingsText(
  {
    agentSelectionAvailable = false,
    chatInputAvailable,
    childNavigationAvailable = false,
    parentNavigationAvailable = false,
    streamFocusAvailable = false,
    modifierLabel = defaultShortcutModifierLabel(),
    shiftEnterNewline = false,
    transcriptAvailable = false,
  }: StatusBarShortcutsInput,
  ctrlCAction: CtrlCAction,
  maxColumns: number | undefined,
): string {
  const childList = childNavigationAvailable
    ? keyHintText({ key: 'Tab', action: SESSION_LIST.openAction })
    : undefined;
  const parentBack = parentNavigationAvailable
    ? keyHintText({ key: 'Esc', action: SESSION_LIST.parentAction })
    : undefined;
  const streamFocus = streamFocusAvailable
    ? keyHintText({
        key: metaChordLabel(modifierLabel, '1..9'),
        action: 'focus',
      })
    : undefined;
  const fullOutput = transcriptAvailable
    ? keyHintText({ key: 'Ctrl-T', action: 'transcript' })
    : undefined;
  const chatHint = (key: string, action: string): string | undefined =>
    chatInputAvailable ? keyHintText({ key, action }) : undefined;
  const agent = agentSelectionAvailable
    ? chatHint('/agent', 'agents')
    : undefined;
  const status = chatHint('/status', 'details');
  const model = chatHint('/model', 'models');
  const api = chatHint('/api', 'api');
  const newline = chatHint(
    shiftEnterNewline ? 'Shift-Enter' : 'Ctrl-J',
    'newline',
  );
  const ctrlC = keyHintText({ key: 'Ctrl-C', action: ctrlCAction });
  const setupControlsOnly =
    chatInputAvailable && agentSelectionAvailable && !childNavigationAvailable;
  const candidates = [
    // Child navigation only applies when the current tree has a visible row;
    // unrelated or not-yet-attached streams do not make Tab actionable.
    statusBarBindingRow([
      childList,
      streamFocus,
      fullOutput,
      status,
      agent,
      model,
      api,
      newline,
      ctrlC,
    ]),
    setupControlsOnly &&
      statusBarBindingRow([fullOutput, agent, model, api, newline, ctrlC]),
    childNavigationAvailable &&
      statusBarBindingRow([childList, fullOutput, agent, status, ctrlC]),
    childNavigationAvailable &&
      statusBarBindingRow([childList, fullOutput, agent, ctrlC]),
    childNavigationAvailable &&
      transcriptAvailable &&
      statusBarBindingRow([childList, fullOutput, ctrlC]),
    parentNavigationAvailable &&
      transcriptAvailable &&
      statusBarBindingRow([fullOutput, ctrlC]),
    setupControlsOnly && statusBarBindingRow([agent, model, api, ctrlC]),
    statusBarBindingRow([childList, fullOutput, agent, status, ctrlC]),
    statusBarBindingRow([childList, fullOutput, agent, ctrlC]),
    (childNavigationAvailable || agentSelectionAvailable) &&
      statusBarBindingRow([childList, agent, ctrlC]),
    childNavigationAvailable &&
      statusBarBindingRow([childList, fullOutput, ctrlC]),
    transcriptAvailable && statusBarBindingRow([childList, fullOutput, ctrlC]),
    parentNavigationAvailable && ctrlC,
    childNavigationAvailable && childList,
    transcriptAvailable && statusBarBindingRow([fullOutput, ctrlC]),
  ].map((candidate) =>
    parentBack && candidate
      ? statusBarBindingRow([parentBack, candidate])
      : candidate,
  );
  if (parentBack) candidates.push(parentBack);

  return firstRowThatFits(candidates, maxColumns, ctrlC);
}

function foregroundBindingsText(
  ctrlCAction: CtrlCAction,
  maxColumns?: number,
  escapeAction = 'close',
): string {
  const ctrlCBinding = keyHintText({ key: 'Ctrl-C', action: ctrlCAction });
  const escBinding = keyHintText({ key: 'Esc', action: escapeAction });
  return firstRowThatFits(
    [
      statusBarBindingRow([
        FOREGROUND_OWNERSHIP.keysGoAbove,
        escBinding,
        ctrlCBinding,
      ]),
      statusBarBindingRow([escBinding, ctrlCBinding]),
    ],
    maxColumns,
    ctrlCBinding,
  );
}

function childListBindingsText(
  {
    selectionKillable = false,
    selectionWorkflowControllable = false,
  }: StatusBarChildListInput,
  ctrlCAction: CtrlCAction,
  maxColumns: number | undefined,
): string {
  const ctrlCBinding = keyHintText({ key: 'Ctrl-C', action: ctrlCAction });
  const enterBinding = keyHintText({ key: 'Enter', action: 'focus' });
  const killBinding = selectionKillable
    ? keyHintText({ key: 'k', action: 'kill' })
    : undefined;
  const skipBinding = selectionWorkflowControllable
    ? keyHintText({ key: 's', action: 'skip' })
    : undefined;
  const retryBinding = selectionWorkflowControllable
    ? keyHintText({ key: 'r', action: 'retry' })
    : undefined;
  const selectBinding = keyHintText({ key: '↑/↓', action: 'select' });
  const tabBinding = keyHintText({ key: 'Tab', action: 'input' });
  const escBinding = keyHintText({ key: 'Esc', action: 'input' });
  return firstRowThatFits(
    [
      statusBarBindingRow([
        selectBinding,
        enterBinding,
        killBinding,
        skipBinding,
        retryBinding,
        tabBinding,
        escBinding,
        ctrlCBinding,
      ]),
      statusBarBindingRow([
        selectBinding,
        enterBinding,
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
    maxColumns,
    ctrlCBinding,
  );
}

export function ctrlCActionForFocus({
  activeStreamId,
  canStopActiveRun,
  parentStream,
}: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly canStopActiveRun: boolean;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
}): CtrlCAction {
  if (!canStopActiveRun) return 'exit';
  return activeStreamScope({ activeStreamId, parentStream }).kind === 'child'
    ? 'stop root'
    : 'stop';
}

function rootActiveSegment(
  input: StatusBarDisplayInput,
): StatusBarSegment | undefined {
  return input.ctrlCAction === 'stop root' && !isActivePhase(input.status)
    ? {
        text: 'root active',
        color: COLOR_WARNING,
        compactPriority: STATUS_BAR_COMPACT_PRIORITY.rootActive,
      }
    : undefined;
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
        text: 'yolo',
        color: COLOR_ERROR,
        compactPriority: STATUS_BAR_COMPACT_PRIORITY.approvalPolicy,
      };
    default:
      return policy satisfies never;
  }
}

interface StatusBarStreamTarget {
  readonly ctrlCAction: CtrlCAction;
  readonly displaySlice: StreamSlice | undefined;
  /** The stream id `displaySlice` was resolved for — the live-ancestor
   *  fallback can surface an ancestor other than the nominally "active" id,
   *  so this is not always `activeStreamId`. */
  readonly displayStreamId: StreamTabId | undefined;
  /** True when `displaySlice` belongs to a child/subagent stream rather than
   *  the root session (the live-ancestor fallback can surface an ancestor
   *  other than the nominally "active" id, so this is derived from whichever
   *  stream is actually displayed, not from `activeStreamId` alone). */
  readonly isChildStream: boolean;
}

export function statusBarStreamTarget({
  activeStreamId,
  canStopActiveRun,
  canStopPendingRunWithoutStream = false,
  parentStream,
  streams,
}: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly canStopActiveRun: boolean;
  readonly canStopPendingRunWithoutStream?: boolean;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}): StatusBarStreamTarget {
  const activeSlice = activeStreamId ? streams.get(activeStreamId) : undefined;
  const liveAncestor = nearestActiveStreamAncestor<StreamSlice>({
    activeStreamId,
    parentStream,
    values: streams,
    canUseValue: (stream) => isActivePhase(stream.status),
  });
  let hasPendingOrLiveStream = false;
  for (const stream of streams.values()) {
    if (stream.status === undefined || isActivePhase(stream.status)) {
      hasPendingOrLiveStream = true;
      break;
    }
  }
  const canStopVisibleRun =
    canStopActiveRun &&
    (canStopPendingRunWithoutStream || hasPendingOrLiveStream);
  const displayStreamId = activeSlice ? activeStreamId : liveAncestor?.streamId;
  return {
    ctrlCAction: ctrlCActionForFocus({
      activeStreamId,
      canStopActiveRun: canStopVisibleRun,
      parentStream,
    }),
    displaySlice: activeSlice ?? liveAncestor?.value,
    displayStreamId,
    isChildStream:
      displayStreamId !== undefined &&
      parentStream.get(displayStreamId) !== undefined,
  };
}

// Bypass badges, in emission order. One row per BypassState flag.
const BYPASS_BADGES: ReadonlyArray<{
  readonly field: keyof BypassState;
  readonly text: string;
  readonly badgeColor: typeof COLOR_ERROR | typeof COLOR_WARNING;
}> = [
  { field: 'superYolo', text: 'AUTO-TASK', badgeColor: COLOR_ERROR },
  { field: 'bash', text: 'AUTO-BASH', badgeColor: COLOR_WARNING },
  { field: 'toolEdit', text: 'AUTO-EDIT', badgeColor: COLOR_WARNING },
];

// Which text occupies the bindings row is a priority order, not a single
// condition: a resumable exit confirmation always wins, then an actual
// foreground surface, then the child list, and only then normal chat shortcuts.
function resolveStatusBarBindings(input: StatusBarDisplayInput): string {
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
    return foregroundBindingsText(
      ctrlCAction,
      maxColumns,
      input.foreground.escapeAction,
    );
  }
  if (input.childList.focused) {
    return childListBindingsText(input.childList, ctrlCAction, maxColumns);
  }
  if (input.foreground.shortcutsActive === false) {
    return foregroundBindingsText(
      ctrlCAction,
      maxColumns,
      input.foreground.escapeAction,
    );
  }
  return statusBarBindingsText(input.shortcuts, ctrlCAction, maxColumns);
}

function buildStatusSegments(input: StatusBarDisplayInput): {
  segments: StatusBarSegment[];
  transientLivenessIndex?: number;
} {
  const segments: StatusBarSegment[] = [];
  const statusLabel = formatCliStatusLabel(
    input.status,
    input.substate,
    input.isChildStream,
  );
  const spinPrefix =
    isActivePhase(input.status) && input.runningFrame
      ? `${input.runningFrame} `
      : '';

  // A notice must not hide the only indication that an active run is still
  // alive. Keep that liveness compact so the notice remains the focal text.
  let transientLivenessIndex: number | undefined;
  if (input.transientNotice) {
    if (isActivePhase(input.status)) {
      const elapsed =
        input.elapsedMs === undefined
          ? ''
          : ` ${formatCompactDuration(input.elapsedMs)}`;
      transientLivenessIndex = segments.length;
      segments.push({
        text: `${spinPrefix}${statusLabel}${elapsed}`,
        compactText:
          input.elapsedMs === undefined
            ? 'run'
            : `run ${formatCompactDuration(input.elapsedMs)}`,
        color: 'dim',
      });
    }
  } else {
    segments.push({
      text: `${spinPrefix}${statusLabel}`,
      color: 'dim',
    });
    if (isActivePhase(input.status) && input.elapsedMs !== undefined) {
      segments.push({
        text: formatCompactDuration(input.elapsedMs),
        color: 'dim',
        compactPriority: STATUS_BAR_COMPACT_PRIORITY.elapsed,
      });
    }
  }
  // Routine activity, not caution: these sit onscreen for whole turns, and
  // painting them yellow trains the eye to ignore the color that also
  // announces auto-approval bypasses and quota exhaustion.
  if (input.compactingActive === true && isActivePhase(input.status)) {
    segments.push({
      text: 'compacting...',
      color: 'dim',
      compactPriority: STATUS_BAR_COMPACT_PRIORITY.compacting,
    });
  } else if (input.thinkingActive === true && isActivePhase(input.status)) {
    segments.push({
      text: 'thinking...',
      color: 'dim',
      compactPriority: STATUS_BAR_COMPACT_PRIORITY.thinking,
    });
  }
  return { segments, transientLivenessIndex };
}

export function buildStatusBarDisplay(
  input: StatusBarDisplayInput,
): StatusBarDisplay {
  const left: StatusBarSegment[] = [
    { text: STATUS_DIAMOND, color: COLOR_HINT, decorative: true },
  ];
  if (input.transcriptMode === 'ephemeral') {
    left.push({
      text: 'EPHEMERAL TRANSCRIPT',
      compactText: 'EPHEMERAL',
      badge: true,
      badgeColor: COLOR_WARNING,
      compactPriority: STATUS_BAR_COMPACT_PRIORITY.ephemeralBadge,
    });
  }

  const { segments: statusSegs, transientLivenessIndex: statusLivenessIndex } =
    buildStatusSegments(input);
  const transientLivenessIndex =
    statusLivenessIndex === undefined
      ? undefined
      : left.length + statusLivenessIndex;
  left.push(...statusSegs);

  let transientNoticeIndex: number | undefined;
  let discardWarningIndex: number | undefined;
  if (input.transientNotice) {
    transientNoticeIndex = left.length;
    left.push({ text: input.transientNotice.text, color: COLOR_WARNING });
    const queuedCount = input.queuedFollowUpMessages.length;
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

  left.push(
    ...[
      rootActiveSegment(input),
      accessModeSegment(input.modelAccess),
      subscriptionQuotaSegment(input.subscriptionQuota),
      approvalPolicySegment(input.approvalPolicy),
      locationSegment(input.location),
      stageSegment(input.stage),
      formatUsage(input.contextState, input.usage),
      queuedFollowUpsCountSegment(input.queuedFollowUpMessages),
      subagentsSegment(input.subagents),
      runningSessionsSegment(input.runningSessions),
      pendingInteractionSegment({
        depth: input.approvalDepth,
        kind: input.approvalKind,
      }),
    ].filter(filterNotNullish),
  );
  for (const badge of BYPASS_BADGES) {
    if (input.bypass[badge.field]) {
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
