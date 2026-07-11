import { MODEL_CONFIGS } from 'llm-zoo';

import { computeUtilizationPercent } from '@agent/modelHandlers/support/contextUtilization';
import {
  defaultShortcutModifierLabel,
  metaChordLabel,
} from '@cli/runtime/shortcutLabels';
import type { CliApprovalPolicy } from '@cli/schemas/cliSettings';
import { isActivePhase } from '@common/constants/streamStatus';
import {
  type RoundStage,
  type StreamPhase,
  type StreamSubstate,
  type StreamTabId,
  type TokenUsageStats,
} from '@shared/schemas';
import { summarizeFollowupMessage } from '@shared/subagentFollowup';
import {
  clamp,
  filterNotNullish,
  formatCompactDuration,
  formatCompactTokenCount,
} from '@utils/core';

import { numberedFollowUpPreview } from '../render/followUpPreview';
import {
  textDisplayWidth,
  truncateSummaryToWidth,
} from '../render/terminalText';
import { formatCliStatusLabel } from '../sessionStatus';
import { STATUS_DIAMOND } from '../ui/glyphs';
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

type StatusBarColor = 'cyan' | 'yellow' | 'red' | 'dim';
type CtrlCAction = 'exit' | 'stop' | 'stop root';

interface StatusBarSegment {
  readonly text: string;
  readonly color?: StatusBarColor;
  readonly badge?: boolean;
  readonly badgeColor?: 'red' | 'yellow';
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
  /** True when more than the root stream exists, i.e. a subagent or
   *  child stream is live. Gates the stream-navigation hints, which are
   *  no-ops in a plain single-stream chat. */
  readonly hasMultipleStreams: boolean;
  readonly model: string;
  readonly apiMode: string;
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
}

interface StatusBarDisplay {
  readonly left: readonly StatusBarSegment[];
  readonly right?: string;
  readonly bindings: string;
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
  const contextWindow = MODEL_CONFIGS[model]?.contextWindow;
  if (!contextWindow || contextWindow <= 0) {
    return { ...base, text: formatCompactTokenCount(used), color: 'dim' };
  }

  const ratio = used / contextWindow;
  const percent = Math.max(
    1,
    Math.round(computeUtilizationPercent(used, contextWindow)),
  );
  let color: StatusBarColor;
  if (ratio >= 0.9) color = 'red';
  else if (ratio >= 0.6) color = 'yellow';
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

function statusBarBindingsText(
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
  const setupControlsOnly =
    agentSelectionAvailable &&
    !taskControlsAvailable &&
    !subagentControlsAvailable &&
    !hasMultipleStreams;
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
  return maxColumns === undefined || textDisplayWidth(text) <= maxColumns;
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
        color: 'yellow',
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
        color: 'yellow',
        compactPriority: STATUS_BAR_COMPACT_PRIORITY.approvalPolicy,
      };
    case 'yolo':
      return {
        text: 'yolo',
        color: 'red',
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
  readonly badgeColor: 'red' | 'yellow';
}> = [
  { field: 'superYolo', text: 'YOLO', badgeColor: 'red' },
  { field: 'bash', text: 'AUTO-BASH', badgeColor: 'yellow' },
  { field: 'toolEdit', text: 'AUTO-EDIT', badgeColor: 'yellow' },
];

export function buildStatusBarDisplay(
  input: StatusBarDisplayInput,
): StatusBarDisplay {
  const left: StatusBarSegment[] = [
    { text: STATUS_DIAMOND, color: 'cyan', decorative: true },
  ];

  if (input.pendingExitHint) {
    left.push({ text: PENDING_EXIT_HINT_TEXT, color: 'yellow' });
    const queuedCount = input.queuedFollowUpMessages.length;
    if (queuedCount > 0) {
      // Exiting drops queued follow-ups silently — warn before the user
      // confirms with the second Ctrl-C.
      left.push({
        text: `${queuedCount} queued follow-up${
          queuedCount === 1 ? '' : 's'
        } will be discarded`,
        color: 'red',
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
        color: 'yellow',
        compactPriority: STATUS_BAR_COMPACT_PRIORITY.thinking,
      });
    }
  }

  const rootActive = rootActiveSegment(input);
  if (rootActive) left.push(rootActive);

  left.push(
    input.subscriptionActive
      ? { text: 'subscription', color: 'cyan', compactText: 'sub' }
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
    bindings:
      input.pendingExitHint && input.pendingExitResumeId
        ? `Resume this session with: ${formatResumeCommand(
            input.commandName,
            input.pendingExitResumeId,
            { approvalPolicy: input.approvalPolicy },
          )}`
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
