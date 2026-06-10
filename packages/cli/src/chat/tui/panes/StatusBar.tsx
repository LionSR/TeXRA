import process from 'node:process';

import { Box, Text, useWindowSize } from 'ink';
import { Badge } from '@inkjs/ui';
import { MODEL_CONFIGS } from 'llm-zoo';
import stringWidth from 'string-width';

import { shortCliApiMode } from '@cli/runtime/apiAccessMode';
import {
  LIVE_ELAPSED_STREAM_STATUSES,
  STREAM_STATUS,
  type ConversationProgress,
  type StreamStatus,
  type StreamTabId,
  type TokenUsageStats,
} from '@shared/schemas';
import { filterNotNullish } from '@utils/core';

import { truncateSummaryToWidth } from '../render/terminalText';
import { formatCliStatusLabel } from '../sessionStatus';
import {
  approvalQueueStatus,
  type ApprovalQueueStatusKind,
} from '../state/approvalQueue';
import { terminalCapabilities } from '../state/terminalCapabilities';
import {
  cliState,
  NO_BYPASS,
  type BypassState,
  type StreamSlice,
} from '../state/cliState';
import {
  activeStreamScope,
  nearestActiveStreamAncestor,
} from '../state/streamViews';
import { useLiveNowMs } from '../state/useLiveNowMs';
import { useSignal } from '../state/useSignal';

type StatusBarColor = 'cyan' | 'yellow' | 'red' | 'dim';
export type CtrlCAction = 'exit' | 'stop' | 'stop root';

export interface StatusBarSegment {
  readonly text: string;
  readonly color?: StatusBarColor;
  readonly badge?: boolean;
  readonly badgeColor?: 'red' | 'yellow';
  readonly compactPriority?: number;
}

export interface StatusBarDisplayInput {
  readonly status: string | undefined;
  /** Milliseconds since the running turn began. When set and `status` is
   *  `running`, the bar shows a live `Ns` segment so a long token-less
   *  "thinking" turn still reads as alive. Omitted in tests/headless. */
  readonly elapsedMs?: number;
  readonly pendingExitHint: boolean;
  readonly pendingExitResumeId: string | undefined;
  readonly bypass: BypassState;
  readonly thinkingActive?: boolean;
  readonly queuedFollowUpMessages: readonly string[];
  readonly queuedFollowUpPreview?: boolean;
  readonly usage: TokenUsageStats | undefined;
  readonly conversation: ConversationProgress | undefined;
  readonly activeSubagents: number;
  readonly activeProcesses: number;
  readonly approvalDepth: number;
  readonly approvalKind?: ApprovalQueueStatusKind;
  readonly taskControlsAvailable?: boolean;
  readonly agentSelectionAvailable?: boolean;
  readonly subagentControlsAvailable: boolean;
  /** True when more than the root stream exists, i.e. a subagent or
   *  child stream is live. Gates the stream-navigation hints, which are
   *  no-ops in a plain single-stream chat. */
  readonly hasMultipleStreams: boolean;
  readonly model: string;
  readonly apiMode: string;
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
  /** False while a foreground surface (approval, picker, form, transcript,
   *  slash palette, or reverse search) owns input and global chat shortcuts are
   *  intentionally inactive. */
  readonly shortcutsActive?: boolean;
  /** Label for the foreground surface's Escape action while shortcutsActive is
   *  false. */
  readonly foregroundEscapeAction?: string;
}

export interface StatusBarDisplay {
  readonly left: readonly StatusBarSegment[];
  readonly right?: string;
  readonly bindings: string;
}

function compactScale(scaled: number, suffix: string): string {
  const rounded = Number.isInteger(scaled)
    ? `${scaled}`
    : scaled.toFixed(1).replace(/\.0$/, '');
  return `${rounded}${suffix}`;
}

function formatCompactNumber(value: number): string {
  if (value < 1000) return `${value}`;
  if (value < 1_000_000) return compactScale(value / 1000, 'k');
  return compactScale(value / 1_000_000, 'M');
}

function formatUsage(
  usage: TokenUsageStats | undefined,
  model: string,
): StatusBarSegment | undefined {
  if (!usage) return undefined;
  const total = usage.inputTokens + usage.outputTokens;
  if (total <= 0) return undefined;

  const base = { compactPriority: STATUS_BAR_COMPACT_PRIORITY.usage };
  const contextWindow = MODEL_CONFIGS[model]?.contextWindow;
  if (!contextWindow || contextWindow <= 0) {
    return { ...base, text: formatCompactNumber(total), color: 'dim' };
  }

  const ratio = total / contextWindow;
  const percent = Math.max(1, Math.round(ratio * 100));
  let color: StatusBarColor;
  if (ratio >= 0.9) color = 'red';
  else if (ratio >= 0.6) color = 'yellow';
  else color = 'dim';
  return {
    ...base,
    text: `${formatCompactNumber(total)}/${formatCompactNumber(
      contextWindow,
    )} (${percent}%)`,
    color,
  };
}

function roundSegment(
  conversation: ConversationProgress | undefined,
): StatusBarSegment | undefined {
  const turns = conversation?.conversationTurns ?? 0;
  return turns > 0
    ? {
        text: `r${turns}`,
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
const STATUS_BAR_HORIZONTAL_PADDING = 2;
const STATUS_BAR_MIN_RIGHT_PREVIEW = 12;
// Preserve a readable separator between the left status group and right preview.
const STATUS_BAR_RIGHT_PREVIEW_GAP = 2;
// Lower values are removed first when the left status group exceeds the row.
const STATUS_BAR_COMPACT_PRIORITY = {
  activeProcess: 10,
  activeSubagent: 20,
  round: 30,
  usage: 40,
  queuedFollowUp: 50,
  approvalDepth: 60,
  rootActive: 65,
  elapsed: 70,
  thinking: 75,
} as const;

function numberedQueuedFollowUpPreview(
  message: string,
  index: number,
  maxColumns: number,
): string {
  const prefix = `${index + 1}. `;
  const bodyColumns = Math.max(0, maxColumns - stringWidth(prefix));
  return `${prefix}${truncateSummaryToWidth(message, bodyColumns)}`;
}

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
    stringWidth(QUEUED_FOLLOW_UP_SEPARATOR);
  const overflowColumns = overflowMarker ? stringWidth(overflowMarker) : 0;
  const itemColumns = Math.floor(
    (maxColumns - separatorColumns - overflowColumns) / previewItems.length,
  );
  if (itemColumns < QUEUED_FOLLOW_UP_MIN_ITEM_PREVIEW) return undefined;

  const previewParts = previewItems.map((message, index) =>
    numberedQueuedFollowUpPreview(message, index, itemColumns),
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
      : Math.min(QUEUED_FOLLOW_UP_PREVIEW_LENGTH, Math.max(0, maxColumns));
  if (previewLength < STATUS_BAR_MIN_RIGHT_PREVIEW) return undefined;
  if (messages.length > 1) {
    return queuedFollowUpsListSummary(messages, previewLength);
  }
  return truncateSummaryToWidth(messages[0] ?? '', previewLength);
}

function queuedFollowUpsCountSegment(
  messages: readonly string[],
): StatusBarSegment | undefined {
  return messages.length > 0
    ? {
        text: `queued ${messages.length}`,
        color: 'yellow',
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
    text: `${depth} ${kind}${depth === 1 ? '' : 's'}`,
    color: 'yellow',
    compactPriority: STATUS_BAR_COMPACT_PRIORITY.approvalDepth,
  };
}

function statusBarSegmentWidth(segment: StatusBarSegment): number {
  return stringWidth(segment.text) + (segment.badge ? 2 : 0);
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

function fitPendingExitStatusBarLeftSegments(
  segments: readonly StatusBarSegment[],
  width: number | undefined,
): readonly StatusBarSegment[] {
  if (width === undefined) return segments;

  const innerWidth = Math.max(0, width - STATUS_BAR_HORIZONTAL_PADDING);
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
  if (width === undefined) return undefined;
  const innerWidth = Math.max(0, width - STATUS_BAR_HORIZONTAL_PADDING);
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
  if (width === undefined) return segments;
  const innerWidth = Math.max(0, width - STATUS_BAR_HORIZONTAL_PADDING);
  if (statusBarSegmentsWidth(segments) <= innerWidth) return segments;

  const compacted = [...segments];
  const priorities = [
    ...new Set(
      compacted
        .map((segment) => segment.compactPriority)
        .filter(filterNotNullish),
    ),
  ].sort((a, b) => a - b);

  for (const priority of priorities) {
    for (let index = compacted.length - 1; index >= 0; index -= 1) {
      if (compacted[index]?.compactPriority !== priority) continue;
      compacted.splice(index, 1);
      if (statusBarSegmentsWidth(compacted) <= innerWidth) return compacted;
    }
  }

  return compacted;
}

export function defaultShortcutModifierLabel(
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'darwin' ? 'Esc' : 'Alt';
}

/** Bare modifier chord (`Alt-p` / `Esc p`) — also feeds the /help keyboard
 *  section, so the Esc-vs-Alt separator rule lives in one place. */
export function metaChordLabel(modifierLabel: string, key: string): string {
  const separator = modifierLabel === 'Esc' ? ' ' : '-';
  return `${modifierLabel}${separator}${key}`;
}

function metaShortcutLabel(modifierLabel: string, key: string): string {
  return `[${metaChordLabel(modifierLabel, key)}]`;
}

function statusBarBindingRow(
  bindings: readonly (string | false | undefined)[],
): string {
  return joinStatusBindings(
    bindings.filter((binding): binding is string => !!binding),
  );
}

// Single-slot memo for the bindings cascade below: it eagerly builds ~13
// candidate rows and stringWidth-measures them until one fits, yet its
// inputs are a handful of flags that change far less often than the
// StatusBar re-renders (every stream-sync tick plus every elapsed-seconds
// tick). Keyed on all inputs, so a changed flag just recomputes.
let lastBindingsKey: string | undefined;
let lastBindingsText = '';

export function statusBarBindingsText(
  taskControlsAvailable = true,
  agentSelectionAvailable = false,
  subagentControlsAvailable: boolean,
  hasMultipleStreams: boolean,
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
    hasMultipleStreams,
    modifierLabel,
    shiftEnterNewline,
    transcriptAvailable,
    ctrlCAction,
    maxColumns,
  ].join('|');
  if (memoKey === lastBindingsKey) return lastBindingsText;
  const focusBinding = metaShortcutLabel(modifierLabel, '1..9');
  const tasksBinding = metaShortcutLabel(modifierLabel, 'p');
  const subagentsBinding = metaShortcutLabel(modifierLabel, 's');
  const transcriptBinding = '[Ctrl-T]transcript';
  const streamTabs = hasMultipleStreams ? '[Tab]streams' : undefined;
  const streamFocus = hasMultipleStreams ? `${focusBinding}focus` : undefined;
  const transcript = transcriptAvailable ? transcriptBinding : undefined;
  const tasks = taskControlsAvailable ? `${tasksBinding}tasks` : undefined;
  const subagents = subagentControlsAvailable
    ? `${subagentsBinding}subagents`
    : undefined;
  const agent = agentSelectionAvailable ? '[/agent]agents' : undefined;
  const status = '[/status]details';
  const model = '[/model]models';
  const api = '[/api]api';
  const newline = shiftEnterNewline
    ? '[Shift-Enter]newline'
    : '[Ctrl-J]newline';
  const ctrlC = `[Ctrl-C]${ctrlCAction}`;
  const candidates = [
    // Stream cycling / numeric focus only do something when there is more
    // than one stream — hide the hints in a plain single-stream chat.
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
    agentSelectionAvailable &&
      statusBarBindingRow([transcript, agent, model, api, newline, ctrlC]),
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
    hasMultipleStreams &&
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

function joinStatusBindings(bindings: readonly string[]): string {
  return bindings.join('  ');
}

function fitsStatusBindings(text: string, maxColumns: number | undefined) {
  return maxColumns === undefined || stringWidth(text) <= maxColumns;
}

function foregroundBindingsText(
  ctrlCAction: CtrlCAction,
  maxColumns?: number,
  escapeAction = 'close',
): string {
  const ctrlCBinding = `[Ctrl-C]${ctrlCAction}`;
  const escBinding = `[Esc]${escapeAction}`;
  const full = `Use foreground panel shortcuts  ${escBinding}  ${ctrlCBinding}`;
  if (fitsStatusBindings(full, maxColumns)) return full;

  const compact = `${escBinding}  ${ctrlCBinding}`;
  if (fitsStatusBindings(compact, maxColumns)) return compact;

  return ctrlCBinding;
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

/** In-flight run statuses — stoppable, and live enough to represent a
 *  focused child's ancestor in the bar. */
function isLiveStreamStatus(status: string | undefined): boolean {
  return status !== undefined && LIVE_ELAPSED_STREAM_STATUSES.has(status);
}

function rootActiveSegment(
  input: StatusBarDisplayInput,
): StatusBarSegment | undefined {
  return input.ctrlCAction === 'stop root' && !isLiveStreamStatus(input.status)
    ? {
        text: 'root active',
        color: 'yellow',
        compactPriority: STATUS_BAR_COMPACT_PRIORITY.rootActive,
      }
    : undefined;
}

interface StatusBarVisibleStream {
  readonly status: StreamStatus | undefined;
}

export interface StatusBarStreamTarget {
  readonly ctrlCAction: CtrlCAction;
  readonly displaySlice: StreamSlice | undefined;
}

export function statusBarStreamTarget({
  activeStreamId,
  canStopActiveRun,
  parentStream,
  streams,
}: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly canStopActiveRun: boolean;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}): StatusBarStreamTarget {
  const activeSlice = activeStreamId ? streams.get(activeStreamId) : undefined;
  const liveAncestor = nearestActiveStreamAncestor({
    activeStreamId,
    parentStream,
    values: streams,
    canUseValue: (stream: StatusBarVisibleStream) =>
      isLiveStreamStatus(stream.status),
  });
  const canStopVisibleRun =
    isLiveStreamStatus(activeSlice?.status) || liveAncestor !== undefined;
  return {
    ctrlCAction: ctrlCActionForFocus({
      activeStreamId,
      canStopActiveRun: canStopActiveRun || canStopVisibleRun,
      parentStream,
    }),
    displaySlice: activeSlice ?? liveAncestor?.value,
  };
}

// Bypass badges, in emission order. One row per BypassState flag.
const BYPASS_BADGES: ReadonlyArray<{
  readonly field: keyof BypassState;
  readonly text: string;
  readonly badgeColor: 'red' | 'yellow';
}> = [
  { field: 'superYolo', text: 'YOLO', badgeColor: 'red' },
  { field: 'bash', text: 'AUTO-BASH', badgeColor: 'yellow' },
  { field: 'toolEdit', text: 'AUTO-APPROVE', badgeColor: 'yellow' },
];

export function buildStatusBarDisplay(
  input: StatusBarDisplayInput,
): StatusBarDisplay {
  const left: StatusBarSegment[] = [{ text: '◆', color: 'cyan' }];

  if (input.pendingExitHint) {
    left.push({ text: PENDING_EXIT_HINT_TEXT, color: 'yellow' });
  } else {
    left.push({ text: formatCliStatusLabel(input.status), color: 'dim' });
    if (
      input.status === STREAM_STATUS.RUNNING &&
      input.elapsedMs !== undefined
    ) {
      left.push({
        text: `${Math.floor(Math.max(0, input.elapsedMs) / 1000)}s`,
        color: 'dim',
        compactPriority: STATUS_BAR_COMPACT_PRIORITY.elapsed,
      });
    }
    if (
      input.status === STREAM_STATUS.RUNNING &&
      input.thinkingActive === true
    ) {
      left.push({
        text: 'thinking...',
        color: 'yellow',
        compactPriority: STATUS_BAR_COMPACT_PRIORITY.thinking,
      });
    }
  }

  const rootActive = rootActiveSegment(input);
  if (rootActive) left.push(rootActive);

  left.push({ text: input.apiMode, color: 'dim' });

  const round = roundSegment(input.conversation);
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
    bindings:
      input.pendingExitHint && input.pendingExitResumeId
        ? `Resume this session with: texra --resume ${input.pendingExitResumeId}`
        : input.shortcutsActive === false
          ? foregroundBindingsText(
              input.ctrlCAction ?? 'exit',
              input.width === undefined
                ? undefined
                : Math.max(0, input.width - STATUS_BAR_HORIZONTAL_PADDING),
              input.foregroundEscapeAction,
            )
          : statusBarBindingsText(
              input.taskControlsAvailable ?? true,
              input.agentSelectionAvailable ?? false,
              input.subagentControlsAvailable,
              input.hasMultipleStreams,
              input.shortcutModifierLabel,
              input.shiftEnterNewline,
              input.transcriptAvailable,
              input.ctrlCAction,
              input.width === undefined
                ? undefined
                : Math.max(0, input.width - STATUS_BAR_HORIZONTAL_PADDING),
            ),
  };
}

export interface StatusBarProps {
  readonly agentSelectionAvailable?: boolean;
  readonly canStopActiveRun?: () => boolean;
  readonly foregroundEscapeAction?: string;
  readonly queuedFollowUpPreview?: boolean;
  readonly shortcutsActive?: boolean;
  readonly subagentControlsAvailable: boolean;
  readonly taskControlsAvailable: boolean;
  readonly transcriptAvailable?: boolean;
}

export function StatusBar(props: StatusBarProps): React.JSX.Element {
  const activeStreamId = useSignal(cliState.activeStreamId);
  const streams = useSignal(cliState.streams);
  const parentStream = useSignal(cliState.parentStream);
  const sessionMeta = useSignal(cliState.sessionMeta);
  const pendingExitHint = useSignal(cliState.pendingExitHint);
  const pendingExitResumeId = useSignal(cliState.pendingExitResumeId);
  const approvals = useSignal(approvalQueueStatus);
  const caps = useSignal(terminalCapabilities);
  const { columns } = useWindowSize();
  const target = statusBarStreamTarget({
    activeStreamId,
    canStopActiveRun: props.canStopActiveRun?.() === true,
    parentStream,
    streams,
  });
  const statusSlice = target.displaySlice;

  const runStartedAt =
    statusSlice?.status === STREAM_STATUS.RUNNING
      ? statusSlice.runStartedAt
      : undefined;
  const now = useLiveNowMs(runStartedAt !== undefined, runStartedAt);

  const display = buildStatusBarDisplay({
    status: statusSlice?.status,
    elapsedMs: runStartedAt !== undefined ? now - runStartedAt : undefined,
    pendingExitHint,
    pendingExitResumeId,
    bypass: statusSlice?.bypass ?? NO_BYPASS,
    thinkingActive: statusSlice?.thinkingActive ?? false,
    queuedFollowUpMessages: statusSlice?.queuedFollowUpMessages ?? [],
    queuedFollowUpPreview: props.queuedFollowUpPreview,
    usage: statusSlice?.usage,
    conversation: statusSlice?.conversation,
    activeSubagents: statusSlice?.activeSubagents.length ?? 0,
    activeProcesses: statusSlice?.activeProcesses.length ?? 0,
    approvalDepth: approvals.depth,
    approvalKind: approvals.kind,
    taskControlsAvailable: props.taskControlsAvailable,
    agentSelectionAvailable: props.agentSelectionAvailable,
    subagentControlsAvailable: props.subagentControlsAvailable,
    hasMultipleStreams: streams.size > 1,
    model: sessionMeta.model,
    apiMode: shortCliApiMode(sessionMeta.apiMode),
    shiftEnterNewline: caps.kittyKeyboard,
    transcriptAvailable: props.transcriptAvailable,
    width: columns,
    ctrlCAction: target.ctrlCAction,
    foregroundEscapeAction: props.foregroundEscapeAction,
    shortcutsActive: props.shortcutsActive,
  });

  return (
    <Box flexDirection="column">
      <Box paddingX={1} justifyContent="space-between">
        <Box gap={1}>
          {display.left.map((segment, index) =>
            segment.badge ? (
              <Badge
                key={`${segment.text}-${index}`}
                color={segment.badgeColor ?? 'red'}
              >
                {segment.text}
              </Badge>
            ) : (
              <Text
                key={`${segment.text}-${index}`}
                color={segment.color === 'dim' ? undefined : segment.color}
                dimColor={segment.color === 'dim'}
              >
                {segment.text}
              </Text>
            ),
          )}
        </Box>
        {display.right ? (
          <Text dimColor wrap="truncate-end">
            {display.right}
          </Text>
        ) : null}
      </Box>
      <Box paddingX={1}>
        <Text dimColor wrap="truncate-end">
          {display.bindings}
        </Text>
      </Box>
    </Box>
  );
}
