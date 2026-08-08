import { MODEL_CONFIGS } from 'llm-zoo';

import { computeUtilizationPercent } from '@agent/modelHandlers/support/contextUtilization';
import {
  shortCliModelAccessRoute,
  type CliModelAccessRoute,
} from '@cli/runtime/modelAccessRoute';
import {
  defaultShortcutModifierLabel,
  metaChordLabel,
} from '@cli/runtime/shortcutLabels';
import { COLOR_ERROR, COLOR_HINT, COLOR_WARNING } from '@cli/tui/ui/colors';
import { STATUS_DIAMOND } from '@cli/tui/ui/glyphs';
import { KEY_HINT_SEPARATOR, keyHintText } from '@cli/tui/ui/KeyHints';
import { STATUS_BAR_HORIZONTAL_PADDING } from '@cli/tui/ui/theme';
import { getRuntimeModelConfig } from '@model/runtimeModelRegistry';
import { resolveProviderCapabilities } from '@model/providerCapabilities';
import type { TexraApprovalPolicy } from '@shared/approvalPolicy';
import {
  spendingQuotaRemainingPercent,
  spendingQuotaState,
  type SpendingStatus,
  type StreamPhase,
  type StreamStage,
  type StreamSubstate,
  type StreamTabId,
  type TokenUsageStats,
} from '@shared/schemas';
import { INCLUDED_ACCESS } from '@shared/copy/modelAccess';
import {
  FOREGROUND_OWNERSHIP,
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

import {
  textDisplayWidth,
  truncateSummaryToWidth,
} from '../render/terminalText';
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
  readonly usage: TokenUsageStats | undefined;
  readonly stage: StreamStage | undefined;
  /** Retained and active direct subagents owned by the displayed stream. */
  readonly subagents: number;
  readonly approvalDepth: number;
  readonly approvalKind?: ApprovalQueueStatusKind;
  readonly model: string;
  readonly modelAccess: CliModelAccessRoute;
  /** Latest relay spend snapshot, when the tier config has been fetched with
   *  auth. Only meaningful while the route is `included`. */
  readonly relayQuota?: SpendingStatus;
  /** Ephemeral transcripts cannot be resumed and require a persistent warning. */
  readonly transcriptMode?: 'persistent' | 'ephemeral';
  readonly approvalPolicy?: TexraApprovalPolicy;
  /** Terminal width in columns. */
  readonly width?: number;
  readonly ctrlCAction?: CtrlCAction;
  /** True when `status` belongs to a focused child/subagent stream rather
   *  than the root session — see `statusBarStreamTarget`. */
  readonly isChildStream?: boolean;
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

// ChatGPT/Codex-subscription turns run under a smaller enforced context
// window than the model's raw API contextWindow (see providerCapabilities.ts).
// `usage.usageRoute` is stamped by the handler that produced this specific
// snapshot, so it's ground truth for *this* usage regardless of what the CLI
// is currently configured to use — and resolveProviderCapabilities() only
// ever stamps 'chatgpt-subscription' when useOpenRouter was false for that
// turn, so passing `false` here isn't an assumption, it's already implied.
function effectiveContextWindow(
  usage: TokenUsageStats,
  model: string,
): number | undefined {
  if (usage.usageRoute === 'chatgpt-subscription') {
    const config = getRuntimeModelConfig(model);
    return config
      ? resolveProviderCapabilities({ model: config, useOpenRouter: false })
          ?.contextWindow
      : undefined;
  }
  return MODEL_CONFIGS[model]?.contextWindow;
}

function accessModeSegment(access: CliModelAccessRoute): StatusBarSegment {
  const label = shortCliModelAccessRoute(access);
  return label === 'subscription'
    ? {
        text: label,
        color: COLOR_HINT,
        compactText: 'sub',
        compactPriority: STATUS_BAR_COMPACT_PRIORITY.accessMode,
      }
    : {
        text: label,
        color: 'dim',
        // Narrow rows keep a recognizable stem of the full name rather than
        // dropping how the session is paid for altogether.
        compactText: access === 'included' ? 'included' : 'API keys',
        compactPriority: STATUS_BAR_COMPACT_PRIORITY.accessMode,
      };
}

// Relay spend only constrains the included-access route; a subscription or a
// personal key spends nothing against the monthly quota, so the warning would
// be noise there. Thresholds come from `spendingQuotaState` so the CLI and the
// Settings quota meter warn at the same point.
function relayQuotaSegment(
  quota: SpendingStatus | undefined,
  access: CliModelAccessRoute,
): StatusBarSegment | undefined {
  if (quota === undefined || access !== 'included') return undefined;
  const state = spendingQuotaState(quota);
  switch (state) {
    case 'ok':
      return undefined;
    case 'warning': {
      const remaining = spendingQuotaRemainingPercent(quota);
      return {
        text: `${INCLUDED_ACCESS.inline} ${remaining}% left`,
        compactText: `incl. ${remaining}%`,
        color: COLOR_WARNING,
        compactPriority: STATUS_BAR_COMPACT_PRIORITY.relayQuota,
      };
    }
    case 'exhausted':
      return {
        text: `${INCLUDED_ACCESS.inline} used up`,
        compactText: 'incl. 0%',
        color: COLOR_ERROR,
        compactPriority: STATUS_BAR_COMPACT_PRIORITY.relayQuota,
      };
    default:
      return state satisfies never;
  }
}

function formatUsage(
  usage: TokenUsageStats | undefined,
  model: string,
): StatusBarSegment | undefined {
  if (!usage) return undefined;
  // Context-window occupancy is input tokens only — the prompt that fills the
  // window. Output tokens are the generated response, not part of the context,
  // so they must not inflate the gauge. This matches every other surface
  // (ModelHandler utilizationPercent, trace, transcript recorder, the extension
  // UsagePanel), which all compute inputTokens / contextWindow.
  const used = usage.inputTokens;
  if (used <= 0) return undefined;

  const base = { compactPriority: STATUS_BAR_COMPACT_PRIORITY.usage };
  const contextWindow = effectiveContextWindow(usage, model);
  if (!contextWindow || contextWindow <= 0) {
    return { ...base, text: formatCompactTokenCount(used), color: 'dim' };
  }

  const ratio = used / contextWindow;
  const percent = Math.max(
    1,
    Math.round(computeUtilizationPercent(used, contextWindow)),
  );
  let color: StatusBarColor;
  if (ratio >= 0.9) color = COLOR_ERROR;
  else if (ratio >= 0.6) color = COLOR_WARNING;
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
  relayQuota: 68,
  elapsed: 70,
  // Durable session status: outlives the transient counts above but must
  // still be compactable — a priority-less segment breaks narrow bars (see
  // bypassBadge below).
  accessMode: 72,
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
        text: formatResultCount(subagents, SUBAGENT.countNoun),
        compactText: `${subagents} ${SUBAGENT.compactCountSuffix}`,
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

// Single-slot memo for the bindings cascade below: it eagerly builds ~13
// candidate rows and stringWidth-measures them until one fits, yet its
// inputs are a handful of flags that change far less often than the
// StatusBar re-renders (every stream-sync tick plus every elapsed-seconds
// tick). Keyed on all inputs, so a changed flag just recomputes.
let lastBindingsKey: string | undefined;
let lastBindingsText = '';

function statusBarBindingsText(
  {
    agentSelectionAvailable = false,
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
  const memoKey = [
    agentSelectionAvailable,
    childNavigationAvailable,
    parentNavigationAvailable,
    streamFocusAvailable,
    modifierLabel,
    shiftEnterNewline,
    transcriptAvailable,
    ctrlCAction,
    maxColumns,
  ].join('|');
  if (memoKey === lastBindingsKey) return lastBindingsText;
  const childList = childNavigationAvailable
    ? keyHintText({ key: 'Tab', action: SESSION_LIST.openAction })
    : undefined;
  const parentBack = parentNavigationAvailable
    ? keyHintText({ key: 'Esc', action: 'back' })
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
  const agent = agentSelectionAvailable
    ? keyHintText({ key: '/agent', action: 'agents' })
    : undefined;
  const status = keyHintText({ key: '/status', action: 'details' });
  const model = keyHintText({ key: '/model', action: 'models' });
  const api = keyHintText({ key: '/api', action: 'api' });
  const newline = keyHintText({
    key: shiftEnterNewline ? 'Shift-Enter' : 'Ctrl-J',
    action: 'newline',
  });
  const ctrlC = keyHintText({ key: 'Ctrl-C', action: ctrlCAction });
  const setupControlsOnly =
    agentSelectionAvailable && !childNavigationAvailable;
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

  const text = firstRowThatFits(candidates, maxColumns, ctrlC);
  lastBindingsKey = memoKey;
  lastBindingsText = text;
  return text;
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
      statusBarBindingRow([
        selectBinding,
        enterBinding,
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
      relayQuotaSegment(input.relayQuota, input.modelAccess),
      approvalPolicySegment(input.approvalPolicy),
      stageSegment(input.stage),
      formatUsage(input.usage, input.model),
      queuedFollowUpsCountSegment(input.queuedFollowUpMessages),
      subagentsSegment(input.subagents),
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
