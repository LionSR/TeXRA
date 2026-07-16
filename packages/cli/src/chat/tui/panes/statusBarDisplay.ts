import { MODEL_CONFIGS } from 'llm-zoo';

import { computeUtilizationPercent } from '@agent/modelHandlers/support/contextUtilization';
import {
  defaultShortcutModifierLabel,
  metaChordLabel,
} from '@cli/runtime/shortcutLabels';
import type { CliApprovalPolicy } from '@cli/schemas/cliSettings';
import { resolveProviderCapabilities } from '@model/providerCapabilities';
import { getRuntimeModelConfig } from '@model/runtimeModelRegistry';
import {
  type RoundStage,
  type StreamPhase,
  type StreamSubstate,
  type StreamTabId,
  type TokenUsageStats,
} from '@shared/schemas';
import { summarizeFollowupMessage } from '@shared/subagentFollowup';
import { isActivePhase } from '@shared/streams/streamStatus';
import {
  clamp,
  filterNotNullish,
  formatCompactDuration,
  formatCompactTokenCount,
} from '@utils/core';
import { formatResultCount } from '@utils/text/stringUtils';

import { numberedFollowUpPreview } from '../render/followUpPreview';
import {
  textDisplayWidth,
  truncateSummaryToWidth,
} from '../render/terminalText';
import { formatCliStatusLabel } from '../sessionStatus';
import { COLOR_ERROR, COLOR_HINT, COLOR_WARNING } from '../ui/colors';
import { STATUS_DIAMOND } from '../ui/glyphs';
import { KEY_HINT_SEPARATOR, keyHintText } from '../ui/KeyHints';
import {
  STATUS_BAR_HORIZONTAL_PADDING,
  STATUS_BAR_RIGHT_PREVIEW_GAP,
} from '../ui/theme';
import { formatResumeCommand } from '../state/resumeHint';
import {
  thinkingIndicatorVisible,
  type BypassState,
  type StreamSlice,
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
  readonly pendingExitHint: boolean;
  readonly pendingExitResumeId: string | undefined;
  readonly commandName?: string;
  readonly bypass: BypassState;
  readonly thinkingActive?: boolean;
  readonly queuedFollowUpMessages: readonly string[];
  readonly queuedFollowUpPreview?: boolean;
  readonly usage: TokenUsageStats | undefined;
  readonly roundStage: RoundStage | undefined;
  readonly activeSubagents: number;
  readonly activeProcesses: number;
  readonly approvalDepth: number;
  readonly approvalKind?: ApprovalQueueStatusKind;
  readonly taskControlsAvailable?: boolean;
  readonly agentSelectionAvailable?: boolean;
  readonly subagentControlsAvailable: boolean;
  /** True when the current stream tree has selectable session rows. */
  readonly sessionNavigationAvailable: boolean;
  readonly model: string;
  readonly apiMode: string;
  /** Ephemeral transcripts cannot be resumed and require a persistent warning. */
  readonly transcriptMode?: 'persistent' | 'ephemeral';
  /** True when the active model routes through the ChatGPT subscription; the
   *  mode segment then reads "subscription" instead of the api-mode. */
  readonly subscriptionActive?: boolean;
  readonly approvalPolicy?: CliApprovalPolicy;
  readonly shortcutModifierLabel?: string;
  /** Advertise Shift+Enter for newline when the Kitty keyboard protocol is
   *  active; otherwise the universal Ctrl-J is the only reliable binding. */
  readonly shiftEnterNewline?: boolean;
  /** True when the focused stream has transcript entries. */
  readonly transcriptAvailable?: boolean;
  /** Terminal width in columns. Used to keep right-side previews from
   *  colliding with durable left-side status segments. */
  readonly width?: number;
  readonly ctrlCAction?: CtrlCAction;
  /** True when `status` belongs to a focused child/subagent stream rather
   *  than the root session — see `statusBarStreamTarget`. */
  readonly isChildStream?: boolean;
  /** False while a foreground surface (approval, picker, form, transcript,
   *  slash palette, or reverse search) owns input and global chat shortcuts are
   *  intentionally inactive. */
  readonly shortcutsActive?: boolean;
  /** Label for the foreground surface's Escape action while shortcutsActive is
   *  false. */
  readonly foregroundEscapeAction?: string;
  /** True while the persistent session list, rather than the input, owns keys. */
  readonly sessionListFocused?: boolean;
}

interface StatusBarDisplay {
  readonly left: readonly StatusBarSegment[];
  readonly right?: string;
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
    const capped = config
      ? resolveProviderCapabilities({ model: config, useOpenRouter: false })
          ?.contextWindow
      : undefined;
    if (capped) return capped;
  }
  return MODEL_CONFIGS[model]?.contextWindow;
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
        text: `r${roundStage.index + 1}`,
        color: 'dim',
        compactPriority: STATUS_BAR_COMPACT_PRIORITY.round,
      }
    : undefined;
}

const QUEUED_FOLLOW_UP_PREVIEW_LENGTH = 48;
const QUEUED_FOLLOW_UP_PREVIEW_ITEMS = 2;
const QUEUED_FOLLOW_UP_MIN_ITEM_PREVIEW = 8;
const QUEUED_FOLLOW_UP_SEPARATOR = ' · ';
const PENDING_EXIT_HINT_TEXT = 'Press Ctrl-C again to exit';
const STATUS_BAR_MIN_RIGHT_PREVIEW = 12;
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

function queuedFollowUpsListSummary(
  messages: readonly string[],
  maxColumns: number,
): string | undefined {
  const previewItems = messages.slice(0, QUEUED_FOLLOW_UP_PREVIEW_ITEMS);
  const overflowCount = messages.length - previewItems.length;
  const overflowMarker =
    overflowCount > 0 ? `+${overflowCount} more` : undefined;
  const separatorColumns =
    Math.max(0, previewItems.length - 1 + (overflowMarker ? 1 : 0)) *
    textDisplayWidth(QUEUED_FOLLOW_UP_SEPARATOR);
  const overflowColumns = overflowMarker ? textDisplayWidth(overflowMarker) : 0;
  const itemColumns = Math.floor(
    (maxColumns - separatorColumns - overflowColumns) / previewItems.length,
  );
  if (itemColumns < QUEUED_FOLLOW_UP_MIN_ITEM_PREVIEW) return undefined;

  const previewParts = previewItems.map((message, index) =>
    numberedFollowUpPreview(message, index, itemColumns),
  );
  if (overflowMarker) previewParts.push(overflowMarker);
  return previewParts.join(QUEUED_FOLLOW_UP_SEPARATOR);
}

export function queuedFollowUpsSummary(
  messages: readonly string[],
  maxColumns?: number,
): string | undefined {
  if (messages.length === 0) return undefined;
  const previewLength =
    maxColumns === undefined
      ? QUEUED_FOLLOW_UP_PREVIEW_LENGTH
      : clamp(maxColumns, 0, QUEUED_FOLLOW_UP_PREVIEW_LENGTH);
  if (previewLength < STATUS_BAR_MIN_RIGHT_PREVIEW) return undefined;
  if (messages.length > 1) {
    return queuedFollowUpsListSummary(messages, previewLength);
  }
  return truncateSummaryToWidth(
    summarizeFollowupMessage(messages[0] ?? ''),
    previewLength,
  );
}

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

function fitPendingExitStatusBarLeftSegments(
  segments: readonly StatusBarSegment[],
  width: number | undefined,
): readonly StatusBarSegment[] {
  const innerWidth = statusBarInnerWidth(width);
  if (innerWidth === undefined) return segments;

  const fitted = [...segments];
  while (fitted.length > 2 && statusBarSegmentsWidth(fitted) > innerWidth) {
    fitted.pop();
  }

  const icon = fitted[0];
  const prompt = fitted[1];
  if (icon && prompt && statusBarSegmentsWidth(fitted) > innerWidth) {
    const iconAndGapWidth = statusBarSegmentWidth(icon) + 1;
    fitted[1] = {
      ...prompt,
      text: truncateSummaryToWidth(
        prompt.text,
        Math.max(0, innerWidth - iconAndGapWidth),
      ),
    };
  }

  return fitted;
}

function rightStatusBudget(
  segments: readonly StatusBarSegment[],
  width: number | undefined,
): number | undefined {
  const innerWidth = statusBarInnerWidth(width);
  if (innerWidth === undefined) return undefined;
  return Math.max(
    0,
    innerWidth -
      statusBarSegmentsWidth(segments) -
      STATUS_BAR_RIGHT_PREVIEW_GAP,
  );
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
  taskControlsAvailable = true,
  agentSelectionAvailable = false,
  subagentControlsAvailable: boolean,
  sessionNavigationAvailable: boolean,
  modifierLabel = defaultShortcutModifierLabel(),
  shiftEnterNewline = false,
  transcriptAvailable = false,
  ctrlCAction: CtrlCAction = 'exit',
  maxColumns?: number,
): string {
  const memoKey = [
    taskControlsAvailable,
    agentSelectionAvailable,
    subagentControlsAvailable,
    sessionNavigationAvailable,
    modifierLabel,
    shiftEnterNewline,
    transcriptAvailable,
    ctrlCAction,
    maxColumns,
  ].join('|');
  if (memoKey === lastBindingsKey) return lastBindingsText;
  const streamTabs = sessionNavigationAvailable
    ? keyHintText({ key: 'Tab', action: 'sessions' })
    : undefined;
  const streamFocus = sessionNavigationAvailable
    ? keyHintText({
        key: metaChordLabel(modifierLabel, '1..9'),
        action: 'focus',
      })
    : undefined;
  const transcript = transcriptAvailable
    ? keyHintText({ key: 'Ctrl-T', action: 'transcript' })
    : undefined;
  const tasks = taskControlsAvailable
    ? keyHintText({ key: metaChordLabel(modifierLabel, 'p'), action: 'tasks' })
    : undefined;
  const subagents = subagentControlsAvailable
    ? keyHintText({
        key: metaChordLabel(modifierLabel, 's'),
        action: 'subagents',
      })
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
    agentSelectionAvailable &&
    !taskControlsAvailable &&
    !subagentControlsAvailable &&
    !sessionNavigationAvailable;
  const candidates = [
    // Session navigation only applies when the current tree has selectable
    // rows; unrelated or not-yet-attached streams do not make Tab actionable.
    statusBarBindingRow([
      streamTabs,
      streamFocus,
      transcript,
      tasks,
      subagents,
      status,
      agent,
      model,
      api,
      newline,
      ctrlC,
    ]),
    setupControlsOnly &&
      statusBarBindingRow([transcript, agent, model, api, newline, ctrlC]),
    setupControlsOnly && statusBarBindingRow([agent, model, api, ctrlC]),
    statusBarBindingRow([
      streamTabs,
      transcript,
      tasks,
      subagents,
      agent,
      status,
      ctrlC,
    ]),
    statusBarBindingRow([
      streamTabs,
      transcript,
      tasks,
      subagents,
      agent,
      ctrlC,
    ]),
    (taskControlsAvailable ||
      subagentControlsAvailable ||
      agentSelectionAvailable) &&
      statusBarBindingRow([streamTabs, tasks, subagents, agent, ctrlC]),
    sessionNavigationAvailable &&
      taskControlsAvailable &&
      statusBarBindingRow([streamTabs, transcript, tasks, ctrlC]),
    taskControlsAvailable && statusBarBindingRow([transcript, tasks, ctrlC]),
    taskControlsAvailable && statusBarBindingRow([tasks, ctrlC]),
    subagentControlsAvailable &&
      statusBarBindingRow([streamTabs, transcript, subagents, ctrlC]),
    subagentControlsAvailable &&
      statusBarBindingRow([transcript, subagents, ctrlC]),
    subagentControlsAvailable && statusBarBindingRow([subagents, ctrlC]),
    transcriptAvailable && statusBarBindingRow([streamTabs, transcript, ctrlC]),
    transcriptAvailable && statusBarBindingRow([transcript, ctrlC]),
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

function sessionListBindingsText(
  ctrlCAction: CtrlCAction,
  maxColumns?: number,
): string {
  const ctrlCBinding = keyHintText({ key: 'Ctrl-C', action: ctrlCAction });
  const candidates = [
    [
      keyHintText({ key: 'Up/Down', action: 'select' }),
      keyHintText({ key: 'Enter', action: 'focus' }),
      keyHintText({ key: 'Tab', action: 'input' }),
      keyHintText({ key: 'Esc', action: 'input' }),
      ctrlCBinding,
    ].join(KEY_HINT_SEPARATOR),
    [
      keyHintText({ key: 'Up/Down', action: 'select' }),
      keyHintText({ key: 'Enter', action: 'focus' }),
      ctrlCBinding,
    ].join(KEY_HINT_SEPARATOR),
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
  { field: 'superYolo', text: 'YOLO', badgeColor: COLOR_ERROR },
  { field: 'bash', text: 'AUTO-BASH', badgeColor: COLOR_WARNING },
  { field: 'toolEdit', text: 'AUTO-EDIT', badgeColor: COLOR_WARNING },
];

// Which text occupies the bindings row is a priority order, not a single
// condition: an active pending-exit prompt always wins, then the session
// list, then any other foreground surface, and only then the normal chat
// shortcuts.
function resolveStatusBarBindings(input: StatusBarDisplayInput): string {
  if (input.pendingExitHint && input.pendingExitResumeId) {
    return `Resume this session with: ${formatResumeCommand(
      input.commandName,
      input.pendingExitResumeId,
      { approvalPolicy: input.approvalPolicy },
    )}`;
  }

  const maxColumns = statusBarInnerWidth(input.width);
  if (input.sessionListFocused) {
    return sessionListBindingsText(input.ctrlCAction ?? 'exit', maxColumns);
  }
  if (input.shortcutsActive === false) {
    return foregroundBindingsText(
      input.ctrlCAction ?? 'exit',
      maxColumns,
      input.foregroundEscapeAction,
    );
  }
  return statusBarBindingsText(
    input.taskControlsAvailable ?? true,
    input.agentSelectionAvailable ?? false,
    input.subagentControlsAvailable,
    input.sessionNavigationAvailable,
    input.shortcutModifierLabel,
    input.shiftEnterNewline,
    input.transcriptAvailable,
    input.ctrlCAction,
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

  if (input.pendingExitHint) {
    left.push({ text: PENDING_EXIT_HINT_TEXT, color: COLOR_WARNING });
    const queuedCount = input.queuedFollowUpMessages.length;
    if (queuedCount > 0) {
      // Exiting drops queued follow-ups silently — warn before the user
      // confirms with the second Ctrl-C.
      left.push({
        text: `${formatResultCount(queuedCount, 'queued follow-up')} will be discarded`,
        color: COLOR_ERROR,
      });
    }
  } else {
    left.push({
      text: formatCliStatusLabel(
        input.status,
        input.substate,
        input.isChildStream,
      ),
      color: 'dim',
    });
    if (isActivePhase(input.status) && input.elapsedMs !== undefined) {
      left.push({
        text: formatCompactDuration(input.elapsedMs),
        color: 'dim',
        compactPriority: STATUS_BAR_COMPACT_PRIORITY.elapsed,
      });
    }
    if (
      thinkingIndicatorVisible({
        status: input.status,
        thinkingActive: input.thinkingActive === true,
      })
    ) {
      left.push({
        text: 'thinking...',
        color: COLOR_WARNING,
        compactPriority: STATUS_BAR_COMPACT_PRIORITY.thinking,
      });
    }
  }

  const rootActive = rootActiveSegment(input);
  if (rootActive) left.push(rootActive);

  left.push(
    input.subscriptionActive
      ? { text: 'subscription', color: COLOR_HINT, compactText: 'sub' }
      : { text: input.apiMode, color: 'dim' },
  );
  const policy = approvalPolicySegment(input.approvalPolicy);
  if (policy) left.push(policy);

  const round = roundSegment(input.roundStage);
  if (round) left.push(round);

  const usage = formatUsage(input.usage, input.model);
  if (usage) left.push(usage);

  const queued = queuedFollowUpsCountSegment(input.queuedFollowUpMessages);
  if (queued) left.push(queued);

  if (input.activeSubagents > 0) {
    left.push({
      text: `${input.activeSubagents} sub`,
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
  const fittedLeft = input.pendingExitHint
    ? fitPendingExitStatusBarLeftSegments(left, input.width)
    : fitStatusBarLeftSegments(left, input.width);
  const queuedCountVisible =
    queued === undefined || fittedLeft.includes(queued);
  const queuedPreviewVisible =
    input.queuedFollowUpPreview !== false && queuedCountVisible;

  return {
    left: fittedLeft,
    right: queuedPreviewVisible
      ? queuedFollowUpsSummary(
          input.queuedFollowUpMessages,
          rightStatusBudget(fittedLeft, input.width),
        )
      : undefined,
    bindings: resolveStatusBarBindings(input),
  };
}
