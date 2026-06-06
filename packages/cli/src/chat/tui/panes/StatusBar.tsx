import process from 'node:process';

import { Box, Text, useWindowSize } from 'ink';
import { Badge } from '@inkjs/ui';
import { MODEL_CONFIGS } from 'llm-zoo';
import stringWidth from 'string-width';

import { shortCliApiMode } from '@cli/runtime/apiAccessMode';
import {
  STREAM_STATUS,
  type ConversationProgress,
  type StreamStatus,
  type StreamTabId,
  type TokenUsageStats,
} from '@shared/schemas';
import { filterNotNullish } from '@utils/core';
import { collapseWhitespace } from '@utils/text/stringUtils';

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
import { resolveChildControlDisplayTargets } from '../state/childControls';
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
} as const;

function truncateSummaryToColumns(text: string, maxColumns: number): string {
  const summary = collapseWhitespace(text);
  if (stringWidth(summary) <= maxColumns) return summary;

  const ellipsis = '…';
  const contentColumns = Math.max(0, maxColumns - stringWidth(ellipsis));
  let width = 0;
  let truncated = '';
  for (const char of summary) {
    const charWidth = stringWidth(char);
    if (width + charWidth > contentColumns) break;
    truncated += char;
    width += charWidth;
  }
  return `${truncated}${ellipsis}`;
}

function numberedQueuedFollowUpPreview(
  message: string,
  index: number,
  maxColumns: number,
): string {
  const prefix = `${index + 1}. `;
  const bodyColumns = Math.max(0, maxColumns - stringWidth(prefix));
  return `${prefix}${truncateSummaryToColumns(message, bodyColumns)}`;
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
  return truncateSummaryToColumns(messages[0] ?? '', previewLength);
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
      text: truncateSummaryToColumns(
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

function metaShortcutLabel(modifierLabel: string, key: string): string {
  const separator = modifierLabel === 'Esc' ? ' ' : '-';
  return `[${modifierLabel}${separator}${key}]`;
}

export function statusBarBindingsText(
  taskControlsAvailable = true,
  agentSelectionAvailable = false,
  subagentControlsAvailable: boolean,
  hasMultipleStreams: boolean,
  modifierLabel = defaultShortcutModifierLabel(),
  shiftEnterNewline = false,
  ctrlCAction: CtrlCAction = 'exit',
  maxColumns?: number,
): string {
  const focusBinding = metaShortcutLabel(modifierLabel, '1..9');
  const tasksBinding = metaShortcutLabel(modifierLabel, 'p');
  const subagentsBinding = metaShortcutLabel(modifierLabel, 's');
  const bindings: string[] = [
    // Stream cycling / numeric focus only do something when there is more
    // than one stream — hide the hints in a plain single-stream chat.
    ...(hasMultipleStreams ? ['[Tab]streams', `${focusBinding}focus`] : []),
    ...(taskControlsAvailable ? [`${tasksBinding}tasks`] : []),
    '[/status]details',
    ...(agentSelectionAvailable ? ['[/agent]agents'] : []),
    '[/model]models',
    '[/api]api',
    shiftEnterNewline ? '[Shift-Enter]newline' : '[Ctrl-J]newline',
    `[Ctrl-C]${ctrlCAction}`,
  ];
  if (subagentControlsAvailable) {
    const tasksIndex = bindings.indexOf(`${tasksBinding}tasks`);
    const statusIndex = bindings.indexOf('[/status]details');
    let insertSubagentsAt = bindings.length;
    if (tasksIndex >= 0) insertSubagentsAt = tasksIndex + 1;
    else if (statusIndex >= 0) insertSubagentsAt = statusIndex;
    bindings.splice(insertSubagentsAt, 0, `${subagentsBinding}subagents`);
  }
  const fullBindings = joinStatusBindings(bindings);
  if (fitsStatusBindings(fullBindings, maxColumns)) return fullBindings;

  if (agentSelectionAvailable) {
    const setupBindings = joinStatusBindings([
      '[/agent]agents',
      '[/model]models',
      '[/api]api',
      shiftEnterNewline ? '[Shift-Enter]newline' : '[Ctrl-J]newline',
      `[Ctrl-C]${ctrlCAction}`,
    ]);
    if (fitsStatusBindings(setupBindings, maxColumns)) return setupBindings;
  }

  const compactBindings = joinStatusBindings([
    ...(hasMultipleStreams ? ['[Tab]streams'] : []),
    ...(taskControlsAvailable ? [`${tasksBinding}tasks`] : []),
    ...(subagentControlsAvailable ? [`${subagentsBinding}subagents`] : []),
    ...(agentSelectionAvailable ? ['[/agent]agents'] : []),
    '[/status]details',
    `[Ctrl-C]${ctrlCAction}`,
  ]);
  if (fitsStatusBindings(compactBindings, maxColumns)) return compactBindings;

  const minimalBindings = joinStatusBindings([
    ...(hasMultipleStreams ? ['[Tab]streams'] : []),
    ...(taskControlsAvailable ? [`${tasksBinding}tasks`] : []),
    ...(subagentControlsAvailable ? [`${subagentsBinding}subagents`] : []),
    ...(agentSelectionAvailable ? ['[/agent]agents'] : []),
    `[Ctrl-C]${ctrlCAction}`,
  ]);
  if (fitsStatusBindings(minimalBindings, maxColumns)) return minimalBindings;

  if (hasMultipleStreams && taskControlsAvailable) {
    const taskFocusedBindings = joinStatusBindings([
      '[Tab]streams',
      `${tasksBinding}tasks`,
      `[Ctrl-C]${ctrlCAction}`,
    ]);
    if (fitsStatusBindings(taskFocusedBindings, maxColumns)) {
      return taskFocusedBindings;
    }
  }

  if (taskControlsAvailable) {
    const bareTaskBindings = joinStatusBindings([
      `${tasksBinding}tasks`,
      `[Ctrl-C]${ctrlCAction}`,
    ]);
    if (fitsStatusBindings(bareTaskBindings, maxColumns)) {
      return bareTaskBindings;
    }
  }

  if (subagentControlsAvailable) {
    const subagentFocusedBindings = joinStatusBindings([
      ...(hasMultipleStreams ? ['[Tab]streams'] : []),
      `${subagentsBinding}subagents`,
      `[Ctrl-C]${ctrlCAction}`,
    ]);
    if (fitsStatusBindings(subagentFocusedBindings, maxColumns)) {
      return subagentFocusedBindings;
    }

    const bareSubagentBindings = joinStatusBindings([
      `${subagentsBinding}subagents`,
      `[Ctrl-C]${ctrlCAction}`,
    ]);
    if (fitsStatusBindings(bareSubagentBindings, maxColumns)) {
      return bareSubagentBindings;
    }
  }

  return `[Ctrl-C]${ctrlCAction}`;
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
  return activeStreamId && parentStream.has(activeStreamId)
    ? 'stop root'
    : 'stop';
}

function statusBarCanStopStatus(status: string | undefined): boolean {
  return (
    status === STREAM_STATUS.INITIALIZING ||
    status === STREAM_STATUS.RUNNING ||
    status === STREAM_STATUS.RESUMING
  );
}

function rootActiveSegment(input: StatusBarDisplayInput) {
  return input.ctrlCAction === 'stop root' &&
    !statusBarCanStopStatus(input.status)
    ? {
        text: 'root active',
        color: 'yellow' as const,
        compactPriority: STATUS_BAR_COMPACT_PRIORITY.rootActive,
      }
    : undefined;
}

function statusBarCanRepresentLiveAncestor(
  status: StreamStatus | undefined,
): boolean {
  return (
    status === STREAM_STATUS.INITIALIZING ||
    status === STREAM_STATUS.RUNNING ||
    status === STREAM_STATUS.RESUMING
  );
}

interface StatusBarVisibleStream {
  readonly status: StreamStatus | undefined;
}

function statusBarFindAncestorStream<T extends StatusBarVisibleStream>({
  activeStreamId,
  parentStream,
  streams,
  canUseStream,
}: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly streams: ReadonlyMap<StreamTabId, T>;
  readonly canUseStream: (stream: T) => boolean;
}): T | undefined {
  if (activeStreamId === undefined) return undefined;

  const visited = new Set<StreamTabId>([activeStreamId]);
  let parentStreamId = parentStream.get(activeStreamId);
  while (parentStreamId && !visited.has(parentStreamId)) {
    visited.add(parentStreamId);
    const parentStreamSlice = streams.get(parentStreamId);
    if (parentStreamSlice && canUseStream(parentStreamSlice)) {
      return parentStreamSlice;
    }
    parentStreamId = parentStream.get(parentStreamId);
  }
  return undefined;
}

export function statusBarCanStopVisibleRun({
  activeStreamId,
  parentStream,
  status,
  streams,
}: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly status: StreamStatus | undefined;
  readonly streams: ReadonlyMap<StreamTabId, StatusBarVisibleStream>;
}): boolean {
  if (statusBarCanStopStatus(status)) return true;
  return (
    statusBarFindAncestorStream({
      activeStreamId,
      parentStream,
      streams,
      canUseStream: (stream) => statusBarCanStopStatus(stream.status),
    }) !== undefined
  );
}

export function statusBarDisplaySlice({
  activeStreamId,
  parentStream,
  streams,
}: {
  readonly activeStreamId: StreamTabId | undefined;
  readonly parentStream: ReadonlyMap<StreamTabId, StreamTabId>;
  readonly streams: ReadonlyMap<StreamTabId, StreamSlice>;
}): StreamSlice | undefined {
  const activeSlice = activeStreamId ? streams.get(activeStreamId) : undefined;
  if (activeSlice) return activeSlice;
  return statusBarFindAncestorStream({
    activeStreamId,
    parentStream,
    streams,
    canUseStream: (stream) => statusBarCanRepresentLiveAncestor(stream.status),
  });
}

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
  if (input.bypass.superYolo) {
    left.push({ text: 'YOLO', badge: true, badgeColor: 'red' });
  }
  if (input.bypass.bash) {
    left.push({ text: 'AUTO-BASH', badge: true, badgeColor: 'yellow' });
  }
  if (input.bypass.toolEdit) {
    left.push({ text: 'AUTO-APPROVE', badge: true, badgeColor: 'yellow' });
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
  const slice = activeStreamId ? streams.get(activeStreamId) : undefined;
  const statusSlice = statusBarDisplaySlice({
    activeStreamId,
    parentStream,
    streams,
  });
  const childControlTargets = resolveChildControlDisplayTargets({
    activeStreamId,
    parentStream,
    streams,
  });

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
    queuedFollowUpMessages: statusSlice?.queuedFollowUpMessages ?? [],
    queuedFollowUpPreview: props.queuedFollowUpPreview,
    usage: statusSlice?.usage,
    conversation: statusSlice?.conversation,
    activeSubagents: statusSlice?.activeSubagents.length ?? 0,
    activeProcesses: statusSlice?.activeProcesses.length ?? 0,
    approvalDepth: approvals.depth,
    approvalKind: approvals.kind,
    taskControlsAvailable: childControlTargets.tasks.hasItems,
    agentSelectionAvailable: props.agentSelectionAvailable,
    subagentControlsAvailable: childControlTargets.subagents.hasItems,
    hasMultipleStreams: streams.size > 1,
    model: sessionMeta.model,
    apiMode: shortCliApiMode(sessionMeta.apiMode),
    shiftEnterNewline: caps.kittyKeyboard,
    width: columns,
    ctrlCAction: ctrlCActionForFocus({
      activeStreamId,
      canStopActiveRun:
        props.canStopActiveRun?.() === true ||
        statusBarCanStopVisibleRun({
          activeStreamId,
          parentStream,
          status: slice?.status,
          streams,
        }),
      parentStream,
    }),
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
