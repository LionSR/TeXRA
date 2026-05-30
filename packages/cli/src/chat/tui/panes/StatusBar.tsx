import process from 'node:process';

import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { Badge } from '@inkjs/ui';
import { MODEL_CONFIGS } from 'llm-zoo';

import { shortCliApiMode } from '@cli/runtime/apiAccessMode';
import {
  STREAM_STATUS,
  type ConversationProgress,
  type TokenUsageStats,
} from '@shared/schemas';
import { truncateSummary } from '@utils/text/stringUtils';

import { approvalQueueDepth } from '../state/approvalQueue';
import { terminalCapabilities } from '../state/terminalCapabilities';
import {
  canShowSubagentControls,
  cliState,
  NO_BYPASS,
  type BypassState,
} from '../state/cliState';
import { useSignal } from '../state/useSignal';

type StatusBarColor = 'cyan' | 'yellow' | 'red' | 'dim';

export interface StatusBarSegment {
  readonly text: string;
  readonly color?: StatusBarColor;
  readonly badge?: boolean;
  readonly badgeColor?: 'red' | 'yellow';
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
  readonly usage: TokenUsageStats | undefined;
  readonly conversation: ConversationProgress | undefined;
  readonly activeSubagents: number;
  readonly activeProcesses: number;
  readonly approvalDepth: number;
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
}

export interface StatusBarDisplay {
  readonly left: readonly StatusBarSegment[];
  readonly right?: string;
  readonly bindings: string;
}

export function statusLabel(status: string | undefined): string {
  switch (status) {
    case STREAM_STATUS.INITIALIZING:
      return 'starting…';
    case STREAM_STATUS.RUNNING:
      return 'running';
    case STREAM_STATUS.WAITING:
      return 'idle';
    case STREAM_STATUS.STOPPED:
      return 'stopped';
    case STREAM_STATUS.READY:
      return 'ready';
    default:
      return status ?? '—';
  }
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

  const contextWindow = MODEL_CONFIGS[model]?.contextWindow;
  if (!contextWindow || contextWindow <= 0) {
    return { text: formatCompactNumber(total), color: 'dim' };
  }

  const ratio = total / contextWindow;
  const percent = Math.max(1, Math.round(ratio * 100));
  let color: StatusBarColor;
  if (ratio >= 0.9) color = 'red';
  else if (ratio >= 0.6) color = 'yellow';
  else color = 'dim';
  return {
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
  return turns > 0 ? { text: `r${turns}`, color: 'dim' } : undefined;
}

const QUEUED_FOLLOW_UP_PREVIEW_LENGTH = 48;

export function queuedFollowUpsSummary(
  messages: readonly string[],
): string | undefined {
  if (messages.length === 0) return undefined;
  const preview = truncateSummary(
    messages[0] ?? '',
    QUEUED_FOLLOW_UP_PREVIEW_LENGTH,
  );
  return messages.length === 1
    ? `queued: ${preview}`
    : `queued ${messages.length}: ${preview}`;
}

function queuedFollowUpsCountSegment(
  messages: readonly string[],
): StatusBarSegment | undefined {
  return messages.length > 0
    ? { text: `queued ${messages.length}`, color: 'yellow' }
    : undefined;
}

export function defaultShortcutModifierLabel(
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === 'darwin' ? 'Option' : 'Alt';
}

function statusBarBindings(
  modifierLabel: string,
  hasMultipleStreams: boolean,
  shiftEnterNewline: boolean,
): readonly string[] {
  return [
    // Stream cycling / numeric focus only do something when there is more
    // than one stream — hide the hints in a plain single-stream chat.
    ...(hasMultipleStreams
      ? ['[Tab]streams', `[${modifierLabel}-1..9]focus`]
      : []),
    `[${modifierLabel}-p]tasks`,
    '[/status]details',
    '[/model]models',
    '[/api]api',
    shiftEnterNewline ? '[Shift-Enter]newline' : '[Ctrl-J]newline',
    '[Ctrl-C]stop',
  ];
}

export function statusBarBindingsText(
  subagentControlsAvailable: boolean,
  hasMultipleStreams: boolean,
  modifierLabel = defaultShortcutModifierLabel(),
  shiftEnterNewline = false,
): string {
  const bindings: string[] = [
    ...statusBarBindings(modifierLabel, hasMultipleStreams, shiftEnterNewline),
  ];
  if (subagentControlsAvailable) {
    const tasksBinding = `[${modifierLabel}-p]tasks`;
    const tasksIndex = bindings.indexOf(tasksBinding);
    bindings.splice(
      tasksIndex >= 0 ? tasksIndex + 1 : bindings.length,
      0,
      `[${modifierLabel}-s]subagents`,
    );
  }
  return bindings.join('  ');
}

export function buildStatusBarDisplay(
  input: StatusBarDisplayInput,
): StatusBarDisplay {
  const left: StatusBarSegment[] = [{ text: '◆', color: 'cyan' }];

  if (input.pendingExitHint) {
    left.push({ text: 'Press Ctrl-C again to exit', color: 'yellow' });
  } else {
    left.push({ text: statusLabel(input.status), color: 'dim' });
    if (
      input.status === STREAM_STATUS.RUNNING &&
      input.elapsedMs !== undefined
    ) {
      left.push({
        text: `${Math.floor(Math.max(0, input.elapsedMs) / 1000)}s`,
        color: 'dim',
      });
    }
  }

  left.push({ text: input.apiMode, color: 'dim' });

  const round = roundSegment(input.conversation);
  if (round) left.push(round);

  const usage = formatUsage(input.usage, input.model);
  if (usage) left.push(usage);

  const queued = queuedFollowUpsCountSegment(input.queuedFollowUpMessages);
  if (queued) left.push(queued);

  if (input.activeSubagents > 0) {
    left.push({ text: `${input.activeSubagents} sub`, color: 'dim' });
  }
  if (input.activeProcesses > 0) {
    left.push({ text: `${input.activeProcesses} proc`, color: 'dim' });
  }
  if (input.approvalDepth > 0) {
    left.push({
      text: `${input.approvalDepth} approval${
        input.approvalDepth === 1 ? '' : 's'
      }`,
      color: 'yellow',
    });
  }
  if (input.bypass.superYolo) {
    left.push({ text: 'YOLO', badge: true, badgeColor: 'red' });
  }
  if (input.bypass.toolEdit) {
    left.push({ text: 'BYPASS', badge: true, badgeColor: 'yellow' });
  }

  return {
    left,
    right: queuedFollowUpsSummary(input.queuedFollowUpMessages),
    bindings:
      input.pendingExitHint && input.pendingExitResumeId
        ? `Resume this session with: texra --resume ${input.pendingExitResumeId}`
        : statusBarBindingsText(
            input.subagentControlsAvailable,
            input.hasMultipleStreams,
            input.shortcutModifierLabel,
            input.shiftEnterNewline,
          ),
  };
}

export function statusBarSegmentText(segment: StatusBarSegment): string {
  return segment.text;
}

export function StatusBar(): React.JSX.Element {
  const activeStreamId = useSignal(cliState.activeStreamId);
  const streams = useSignal(cliState.streams);
  const sessionMeta = useSignal(cliState.sessionMeta);
  const pendingExitHint = useSignal(cliState.pendingExitHint);
  const pendingExitResumeId = useSignal(cliState.pendingExitResumeId);
  const approvals = useSignal(approvalQueueDepth);
  const caps = useSignal(terminalCapabilities);
  const slice = activeStreamId ? streams.get(activeStreamId) : undefined;

  // Re-render once a second while a turn is running so the elapsed segment
  // ticks even when the model streams no tokens (the live region is otherwise
  // only repainted by stream-log change events). The interval is armed only
  // while `runStartedAt` is set, so an idle session adds no churn.
  const runStartedAt =
    slice?.status === STREAM_STATUS.RUNNING ? slice.runStartedAt : undefined;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (runStartedAt === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [runStartedAt]);

  const display = buildStatusBarDisplay({
    status: slice?.status,
    elapsedMs: runStartedAt !== undefined ? now - runStartedAt : undefined,
    pendingExitHint,
    pendingExitResumeId,
    bypass: slice?.bypass ?? NO_BYPASS,
    queuedFollowUpMessages: slice?.queuedFollowUpMessages ?? [],
    usage: slice?.usage,
    conversation: slice?.conversation,
    activeSubagents: slice?.activeSubagents.length ?? 0,
    activeProcesses: slice?.activeProcesses.length ?? 0,
    approvalDepth: approvals,
    subagentControlsAvailable: canShowSubagentControls(sessionMeta, slice),
    hasMultipleStreams: streams.size > 1,
    model: sessionMeta.model,
    apiMode: shortCliApiMode(sessionMeta.apiMode),
    shiftEnterNewline: caps.kittyKeyboard,
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
