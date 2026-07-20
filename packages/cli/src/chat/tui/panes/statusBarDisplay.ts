import { MODEL_CONFIGS } from 'llm-zoo';

import { computeUtilizationPercent } from '@agent/modelHandlers/support/contextUtilization';
import type { CliApprovalPolicy } from '@cli/schemas/cliSettings';
import {
  shortCliModelAccessRoute,
  type CliModelAccessRoute,
} from '@cli/runtime/modelAccessRoute';
import {
  defaultShortcutModifierLabel,
  metaChordLabel,
} from '@cli/runtime/shortcutLabels';
import { getRuntimeModelConfig } from '@model/runtimeModelRegistry';
import { resolveProviderCapabilities } from '@model/providerCapabilities';
import {
  type RoundStage,
  type StreamPhase,
  type StreamSubstate,
  type StreamTabId,
  type TokenUsageStats,
} from '@shared/schemas';
import { isActivePhase } from '@shared/streams/streamStatus';
import { formatRoundStageLabel } from '@shared/streams/streamStatusDisplay';
import {
  filterNotNullish,
  formatCompactDuration,
  formatCompactTokenCount,
} from '@utils/core';
import { formatResultCount } from '@utils/text/stringUtils';

import {
  textDisplayWidth,
  truncateSummaryToWidth,
} from '../render/terminalText';
import { formatCliStatusLabel } from '../sessionStatus';
import { COLOR_ERROR, COLOR_HINT, COLOR_WARNING } from '../ui/colors';
import { STATUS_DIAMOND } from '../ui/glyphs';
import { KEY_HINT_SEPARATOR, keyHintText } from '../ui/KeyHints';
import { STATUS_BAR_HORIZONTAL_PADDING } from '../ui/theme';
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
  readonly queuedFollowUpMessages: readonly string[];
  readonly usage: TokenUsageStats | undefined;
  readonly roundStage: RoundStage | undefined;
  /** Retained and active direct subagents owned by the displayed stream. */
  readonly subagents: number;
  readonly activeProcesses: number;
  readonly approvalDepth: number;
  readonly approvalKind?: ApprovalQueueStatusKind;
  readonly model: string;
  readonly modelAccess: CliModelAccessRoute;
  /** Ephemeral transcripts cannot be resumed and require a persistent warning. */
  readonly transcriptMode?: 'persistent' | 'ephemeral';
  readonly approvalPolicy?: CliApprovalPolicy;
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
  readonly selectionKind?: 'stream' | 'process';
  readonly selectionKillable?: boolean;
  /** True while the focused row is an in-flight workflow-script grandchild
   *  that can be skipped or retried. */
  readonly selectionWorkflowControllable?: boolean;
}

interface StatusBarShortcutsInput {
  readonly agentSelectionAvailable?: boolean;
  /** True when the persistent child list has a session or process row. */
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
    ? { text: label, color: COLOR_HINT, compactText: 'sub' }
    : { text: label, color: 'dim' };
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

function roundSegment(
  roundStage: RoundStage | undefined,
): StatusBarSegment | undefined {
  return roundStage !== undefined
    ? {
        text: formatRoundStageLabel(roundStage),
        // Keep round visibility on narrow terminals: degrade to the bare
        // current-round label instead of dropping the planned total's context.
        compactText: formatRoundStageLabel({ index: roundStage.index }),
        color: 'dim',
        compactPriority: STATUS_BAR_COMPACT_PRIORITY.round,
      }
    : undefined;
}

// Lower values are removed first when the left status group exceeds the row.
const STATUS_BAR_COMPACT_PRIORITY = {
  activeProcess: 10,
  activeSubagent: 20,
  round: 30,
  usage: 40,
  queuedFollowUp: 50,
  approvalPolicy: 55,
  approvalDepth: 60,
  rootActive: 65,
  elapsed: 70,
  thinking: 75,
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

export function statusBarSegmentText(segment: StatusBarSegment): string {
  return segment.text;
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

  while (statusBarSegmentsWidth(fitted) > innerWidth) {
    const removableIndex = fitted.findLastIndex(
      (segment, index) => index > noticeIndex && segment !== discardWarning,
    );
    if (removableIndex < 0) break;
    fitted.splice(removableIndex, 1);
  }

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
    const fixedWidth = fitted.reduce(
      (total, segment, index) =>
        index === fittedNoticeIndex
          ? total
          : total + statusBarSegmentWidth(segment),
      fitted.length - 1,
    );
    fittedNotice = {
      ...notice,
      text: truncateSummaryToWidth(
        notice.text,
        Math.max(0, innerWidth - fixedWidth),
      ),
    };
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
    const fixedWidth = fitted.reduce(
      (total, segment, index) =>
        index === fittedWarningIndex
          ? total
          : total + statusBarSegmentWidth(segment),
      fitted.length - 1,
    );
    fitted[fittedWarningIndex] = {
      ...discardWarning,
      text: truncateSummaryToWidth(
        discardWarning.text,
        Math.max(0, innerWidth - fixedWidth),
      ),
    };
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
  const priorities = [
    ...new Set(
      compacted
        .map((segment) => segment.compactPriority)
        .filter(filterNotNullish),
    ),
  ].sort((a, b) => a - b);

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
// (docs/prds/cli-tui-ink/10-architecture.md § Intuitiveness conventions).
function statusBarBindingRow(
  bindings: readonly (string | false | undefined)[],
): string {
  return bindings
    .filter((binding): binding is string => !!binding)
    .join(KEY_HINT_SEPARATOR);
}

// Single-slot memo for the bindings cascade below: it eagerly builds ~13
// candidate rows and stringWidth-measures them until one fits, yet its
// inputs are a handful of flags that change far less often than the
// StatusBar re-renders (every stream-sync tick plus every elapsed-seconds
// tick). Keyed on all inputs, so a changed flag just recomputes.
let lastBindingsKey: string | undefined;
let lastBindingsText = '';

function statusBarBindingsText(
  agentSelectionAvailable = false,
  childNavigationAvailable = false,
  streamFocusAvailable = false,
  modifierLabel = defaultShortcutModifierLabel(),
  shiftEnterNewline = false,
  transcriptAvailable = false,
  ctrlCAction: CtrlCAction = 'exit',
  maxColumns?: number,
): string {
  const memoKey = [
    agentSelectionAvailable,
    childNavigationAvailable,
    streamFocusAvailable,
    modifierLabel,
    shiftEnterNewline,
    transcriptAvailable,
    ctrlCAction,
    maxColumns,
  ].join('|');
  if (memoKey === lastBindingsKey) return lastBindingsText;
  const childList = childNavigationAvailable
    ? keyHintText({ key: 'Tab', action: 'children' })
    : undefined;
  const streamFocus = streamFocusAvailable
    ? keyHintText({
        key: metaChordLabel(modifierLabel, '1..9'),
        action: 'focus',
      })
    : undefined;
  const fullOutput = transcriptAvailable
    ? keyHintText({ key: 'Ctrl-T', action: 'full output' })
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
    setupControlsOnly && statusBarBindingRow([agent, model, api, ctrlC]),
    statusBarBindingRow([childList, fullOutput, agent, status, ctrlC]),
    statusBarBindingRow([childList, fullOutput, agent, ctrlC]),
    (childNavigationAvailable || agentSelectionAvailable) &&
      statusBarBindingRow([childList, agent, ctrlC]),
    childNavigationAvailable &&
      statusBarBindingRow([childList, fullOutput, ctrlC]),
    transcriptAvailable && statusBarBindingRow([childList, fullOutput, ctrlC]),
    transcriptAvailable && statusBarBindingRow([fullOutput, ctrlC]),
  ];

  const text =
    candidates.find(
      (candidate): candidate is string =>
        typeof candidate === 'string' &&
        fitsStatusBindings(candidate, maxColumns),
    ) ?? ctrlC;
  lastBindingsKey = memoKey;
  lastBindingsText = text;
  return text;
}

function fitsStatusBindings(text: string, maxColumns: number | undefined) {
  return maxColumns === undefined || textDisplayWidth(text) <= maxColumns;
}

function foregroundBindingsText(
  ctrlCAction: CtrlCAction,
  maxColumns?: number,
  escapeAction = 'close',
): string {
  const ctrlCBinding = keyHintText({ key: 'Ctrl-C', action: ctrlCAction });
  const escBinding = keyHintText({ key: 'Esc', action: escapeAction });
  const full = [
    'Use foreground panel shortcuts',
    escBinding,
    ctrlCBinding,
  ].join(KEY_HINT_SEPARATOR);
  if (fitsStatusBindings(full, maxColumns)) return full;

  const compact = [escBinding, ctrlCBinding].join(KEY_HINT_SEPARATOR);
  if (fitsStatusBindings(compact, maxColumns)) return compact;

  return ctrlCBinding;
}

function childListBindingsText(
  ctrlCAction: CtrlCAction,
  selectionKind: 'stream' | 'process' | undefined,
  selectionKillable: boolean,
  selectionWorkflowControllable: boolean,
  maxColumns?: number,
): string {
  const ctrlCBinding = keyHintText({ key: 'Ctrl-C', action: ctrlCAction });
  const enterBinding = keyHintText({
    key: 'Enter',
    action: selectionKind === 'process' ? 'details' : 'focus',
  });
  const fullOutputBinding =
    selectionKind === 'stream'
      ? keyHintText({ key: 'v', action: 'full output' })
      : undefined;
  const killBinding = selectionKillable
    ? keyHintText({ key: 'k', action: 'kill' })
    : undefined;
  const skipBinding = selectionWorkflowControllable
    ? keyHintText({ key: 's', action: 'skip' })
    : undefined;
  const retryBinding = selectionWorkflowControllable
    ? keyHintText({ key: 'r', action: 'retry' })
    : undefined;
  const candidates = [
    statusBarBindingRow([
      keyHintText({ key: 'Up/Down', action: 'select' }),
      enterBinding,
      fullOutputBinding,
      killBinding,
      skipBinding,
      retryBinding,
      keyHintText({ key: 'Tab', action: 'input' }),
      keyHintText({ key: 'Esc', action: 'input' }),
      ctrlCBinding,
    ]),
    statusBarBindingRow([
      keyHintText({ key: 'Up/Down', action: 'select' }),
      enterBinding,
      fullOutputBinding,
      killBinding,
      keyHintText({ key: 'Tab', action: 'input' }),
      keyHintText({ key: 'Esc', action: 'input' }),
      ctrlCBinding,
    ]),
    statusBarBindingRow([
      keyHintText({ key: 'Up/Down', action: 'select' }),
      enterBinding,
      keyHintText({ key: 'Tab', action: 'input' }),
      keyHintText({ key: 'Esc', action: 'input' }),
      ctrlCBinding,
    ]),
    statusBarBindingRow([
      enterBinding,
      keyHintText({ key: 'Esc', action: 'input' }),
      ctrlCBinding,
    ]),
    ctrlCBinding,
  ];
  return (
    candidates.find((candidate) => fitsStatusBindings(candidate, maxColumns)) ??
    ctrlCBinding
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

function hasPendingOrLiveStream(
  streams: ReadonlyMap<StreamTabId, StatusBarVisibleStream>,
): boolean {
  for (const stream of streams.values()) {
    if (stream.status === undefined || isActivePhase(stream.status)) {
      return true;
    }
  }
  return false;
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
  policy: CliApprovalPolicy | undefined,
): StatusBarSegment | undefined {
  switch (policy) {
    case undefined:
    case 'ask':
      return undefined;
    case 'never':
      return {
        text: 'deny',
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

interface StatusBarVisibleStream {
  readonly status: StreamPhase | undefined;
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
  const canStopVisibleRun =
    canStopActiveRun &&
    (canStopPendingRunWithoutStream || hasPendingOrLiveStream(streams));
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
    return childListBindingsText(
      ctrlCAction,
      input.childList.selectionKind,
      input.childList.selectionKillable ?? false,
      input.childList.selectionWorkflowControllable ?? false,
      maxColumns,
    );
  }
  if (input.foreground.shortcutsActive === false) {
    return foregroundBindingsText(
      ctrlCAction,
      maxColumns,
      input.foreground.escapeAction,
    );
  }
  return statusBarBindingsText(
    input.shortcuts.agentSelectionAvailable ?? false,
    input.shortcuts.childNavigationAvailable,
    input.shortcuts.streamFocusAvailable,
    input.shortcuts.modifierLabel,
    input.shortcuts.shiftEnterNewline,
    input.shortcuts.transcriptAvailable,
    ctrlCAction,
    maxColumns,
  );
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
    });
  }

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
      transientLivenessIndex = left.length;
      left.push({
        text: `${spinPrefix}${statusLabel}${elapsed}`,
        compactText:
          input.elapsedMs === undefined
            ? 'run'
            : `run ${formatCompactDuration(input.elapsedMs)}`,
        color: 'dim',
      });
    }
  } else {
    left.push({
      text: `${spinPrefix}${statusLabel}`,
      color: 'dim',
    });
    if (isActivePhase(input.status) && input.elapsedMs !== undefined) {
      left.push({
        text: formatCompactDuration(input.elapsedMs),
        color: 'dim',
        compactPriority: STATUS_BAR_COMPACT_PRIORITY.elapsed,
      });
    }
  }
  if (input.thinkingActive === true && isActivePhase(input.status)) {
    left.push({
      text: 'thinking...',
      color: COLOR_WARNING,
      compactPriority: STATUS_BAR_COMPACT_PRIORITY.thinking,
    });
  }

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

  const rootActive = rootActiveSegment(input);
  if (rootActive) left.push(rootActive);

  left.push(accessModeSegment(input.modelAccess));
  const policy = approvalPolicySegment(input.approvalPolicy);
  if (policy) left.push(policy);

  const round = roundSegment(input.roundStage);
  if (round) left.push(round);

  const usage = formatUsage(input.usage, input.model);
  if (usage) left.push(usage);

  const queued = queuedFollowUpsCountSegment(input.queuedFollowUpMessages);
  if (queued) left.push(queued);

  if (input.subagents > 0) {
    left.push({
      text: `${input.subagents} subagent${input.subagents === 1 ? '' : 's'}`,
      compactText: `${input.subagents} sub`,
      color: 'dim',
      compactPriority: STATUS_BAR_COMPACT_PRIORITY.activeSubagent,
    });
  }
  if (input.activeProcesses > 0) {
    left.push({
      text: `${input.activeProcesses} proc`,
      color: 'dim',
      compactPriority: STATUS_BAR_COMPACT_PRIORITY.activeProcess,
    });
  }
  const pendingInteraction = pendingInteractionSegment({
    depth: input.approvalDepth,
    kind: input.approvalKind,
  });
  if (pendingInteraction) left.push(pendingInteraction);
  for (const badge of BYPASS_BADGES) {
    if (input.bypass[badge.field]) {
      left.push({
        text: badge.text,
        badge: true,
        badgeColor: badge.badgeColor,
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
