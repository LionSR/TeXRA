import { Box, Text } from 'ink';
import { Badge } from '@inkjs/ui';
import { MODEL_CONFIGS } from 'llm-zoo';

import {
  STREAM_STATUS,
  type ConversationProgress,
  type TokenUsageStats,
} from '@shared/schemas';

import { approvalQueueDepth } from '../state/approvalQueue';
import { cliState, NO_BYPASS, type BypassState } from '../state/cliState';
import { useSignal } from '../state/useSignal';
import { shortCliApiMode } from '../../../runtime/apiAccessMode';

type StatusBarColor = 'cyan' | 'yellow' | 'red' | 'dim';

export interface StatusBarSegment {
  readonly text: string;
  readonly color?: StatusBarColor;
  readonly badge?: boolean;
  readonly badgeColor?: 'red' | 'yellow';
}

export interface StatusBarDisplayInput {
  readonly status: string | undefined;
  readonly pendingExitHint: boolean;
  readonly bypass: BypassState;
  readonly queuedFollowUps: number;
  readonly usage: TokenUsageStats | undefined;
  readonly conversation: ConversationProgress | undefined;
  readonly activeSubagents: number;
  readonly activeProcesses: number;
  readonly approvalDepth: number;
  readonly model: string;
  readonly apiMode: string;
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

function formatCompactNumber(value: number): string {
  if (value < 1000) return `${value}`;
  if (value < 1_000_000) {
    const thousands = value / 1000;
    const rounded = Number.isInteger(thousands)
      ? `${thousands}`
      : thousands.toFixed(1).replace(/\.0$/, '');
    return `${rounded}k`;
  }
  const millions = value / 1_000_000;
  const rounded = Number.isInteger(millions)
    ? `${millions}`
    : millions.toFixed(1).replace(/\.0$/, '');
  return `${rounded}M`;
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
  const color =
    ratio >= 0.9 ? 'red' : ratio >= 0.6 ? 'yellow' : ('dim' as const);
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

const STATUS_BAR_BINDINGS = [
  '[Tab]streams',
  '[Alt-1..9]focus',
  '[Alt-s/p]children',
  '[/status]details',
  '[/model]models',
  '[/api]api',
  '[Ctrl-C]stop',
] as const;

export function statusBarBindingsText(): string {
  return STATUS_BAR_BINDINGS.join('  ');
}

export function buildStatusBarDisplay(
  input: StatusBarDisplayInput,
): StatusBarDisplay {
  const left: StatusBarSegment[] = [{ text: '◆', color: 'cyan' }];

  if (input.pendingExitHint) {
    left.push({ text: 'Press Ctrl-C again to exit', color: 'yellow' });
  } else {
    left.push({ text: statusLabel(input.status), color: 'dim' });
  }

  left.push({ text: input.apiMode, color: 'dim' });

  const round = roundSegment(input.conversation);
  if (round) left.push(round);

  const usage = formatUsage(input.usage, input.model);
  if (usage) left.push(usage);

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
    right:
      input.queuedFollowUps > 0
        ? `queued: ${input.queuedFollowUps}`
        : undefined,
    bindings: statusBarBindingsText(),
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
  const approvals = useSignal(approvalQueueDepth);
  const slice = activeStreamId ? streams.get(activeStreamId) : undefined;
  const display = buildStatusBarDisplay({
    status: slice?.status,
    pendingExitHint,
    bypass: slice?.bypass ?? NO_BYPASS,
    queuedFollowUps: slice?.queuedFollowUps ?? 0,
    usage: slice?.usage,
    conversation: slice?.conversation,
    activeSubagents: slice?.activeSubagents.length ?? 0,
    activeProcesses: slice?.activeProcesses.length ?? 0,
    approvalDepth: approvals,
    model: sessionMeta.model,
    apiMode: shortCliApiMode(sessionMeta.apiMode),
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
        {display.right ? <Text dimColor>{display.right}</Text> : null}
      </Box>
      <Box paddingX={1}>
        <Text dimColor>{display.bindings}</Text>
      </Box>
    </Box>
  );
}
