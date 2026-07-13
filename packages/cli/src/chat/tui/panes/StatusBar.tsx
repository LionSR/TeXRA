import { Box, Text, useWindowSize } from 'ink';
import { Badge } from '@inkjs/ui';
import { useEffect, useState } from 'react';

import { shortCliApiMode } from '@cli/runtime/apiAccessMode';
import { isActivePhase } from '@common/constants/streamStatus';
import { isCodexSubscriptionActive } from '@model/codexSubscriptionActive';

import { approvalQueueStatus } from '../state/approvalQueue';
import { terminalCapabilities } from '../state/terminalCapabilities';
import {
  codexPreferenceVersion as codexPreferenceVersionSignal,
  pendingExitHint as pendingExitHintSignal,
  pendingExitResumeId as pendingExitResumeIdSignal,
  activeStreamId as activeStreamIdSignal,
  rootRunPending as rootRunPendingSignal,
  rootRunStreamId as rootRunStreamIdSignal,
  sessionMeta as sessionMetaSignal,
  streams as streamsSignal,
  NO_BYPASS,
} from '../state/cliState';
import { chatTuiCanStopVisibleRun } from '../state/sessionRunState';
import {
  activeSubagentsFor,
  childStreamEntries as childStreamEntriesSignal,
  parentStream as parentStreamSignal,
} from '../state/childExecutions';
import { useLiveNowMs } from '../state/useLiveNowMs';
import { COLOR_ERROR } from '../ui/colors';
import { useSignal } from '../state/useSignal';
import {
  buildStatusBarDisplay,
  statusBarStreamTarget,
} from './statusBarDisplay';

const CODEX_SUBSCRIPTION_REFRESH_MS = 10_000;

interface StatusBarProps {
  readonly agentSelectionAvailable?: boolean;
  readonly commandName?: string;
  readonly foregroundEscapeAction?: string;
  readonly queuedFollowUpPreview?: boolean;
  readonly shortcutsActive?: boolean;
  readonly subagentControlsAvailable: boolean;
  readonly taskControlsAvailable: boolean;
  readonly transcriptAvailable?: boolean;
}

export function StatusBar(props: StatusBarProps): React.JSX.Element {
  const activeStreamId = useSignal(activeStreamIdSignal);
  const streams = useSignal(streamsSignal);
  const parentStream = useSignal(parentStreamSignal);
  const childStreamEntries = useSignal(childStreamEntriesSignal);
  const sessionMeta = useSignal(sessionMetaSignal);
  const pendingExitHint = useSignal(pendingExitHintSignal);
  const pendingExitResumeId = useSignal(pendingExitResumeIdSignal);
  const approvals = useSignal(approvalQueueStatus);
  const caps = useSignal(terminalCapabilities);
  const { columns } = useWindowSize();
  // The Ctrl-C stop/exit hint derives from published run-state signals, never
  // from impure session closures: memoized renders cache a closure's result
  // on the closure's identity, which froze the hint at its boot-time value
  // for the whole run (#8273).
  const rootRunPending = useSignal(rootRunPendingSignal);
  const rootRunStreamId = useSignal(rootRunStreamIdSignal);
  const target = statusBarStreamTarget({
    activeStreamId,
    canStopActiveRun: chatTuiCanStopVisibleRun({
      runPending: rootRunPending,
      streamId: rootRunStreamId,
      status: rootRunStreamId
        ? streams.get(rootRunStreamId)?.status
        : undefined,
    }),
    canStopPendingRunWithoutStream:
      rootRunPending && rootRunStreamId === undefined,
    parentStream,
    streams,
  });
  const statusSlice = target.displaySlice;

  // Whether the active model is currently routing through the ChatGPT
  // subscription (preference + eligibility + signed in). Kept in polled state
  // rather than read on every render: the poll re-reads the preference so an
  // external config change is reflected within the interval, and an in-process
  // `/subscription` toggle bumps `codexPreferenceVersion` to refresh at once.
  const codexPreferenceVersion = useSignal(codexPreferenceVersionSignal);
  const [subscriptionActive, setSubscriptionActive] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    const refresh = (): void => {
      if (inFlight) return; // Skip if the previous read has not resolved.
      inFlight = true;
      void isCodexSubscriptionActive(sessionMeta.model)
        .then((active) => {
          if (!cancelled) setSubscriptionActive(active);
        })
        .catch(() => {
          if (!cancelled) setSubscriptionActive(false);
        })
        .finally(() => {
          inFlight = false;
        });
    };
    refresh();
    const refreshTimer = setInterval(refresh, CODEX_SUBSCRIPTION_REFRESH_MS);
    refreshTimer.unref?.();
    return () => {
      cancelled = true;
      clearInterval(refreshTimer);
    };
  }, [sessionMeta.model, codexPreferenceVersion]);

  const runStartedAt = isActivePhase(statusSlice?.status)
    ? statusSlice?.runStartedAt
    : undefined;
  const now = useLiveNowMs(runStartedAt !== undefined, runStartedAt);

  const display = buildStatusBarDisplay({
    status: statusSlice?.status,
    substate: statusSlice?.substate,
    elapsedMs: runStartedAt !== undefined ? now - runStartedAt : undefined,
    pendingExitHint,
    pendingExitResumeId,
    commandName: props.commandName,
    bypass: statusSlice?.bypass ?? NO_BYPASS,
    thinkingActive: statusSlice?.thinkingActive ?? false,
    queuedFollowUpMessages: statusSlice?.queuedFollowUpMessages ?? [],
    queuedFollowUpPreview: props.queuedFollowUpPreview,
    usage: statusSlice?.usage,
    roundStage: statusSlice?.roundStage,
    activeSubagents:
      target.displayStreamId !== undefined
        ? activeSubagentsFor(
            target.displayStreamId,
            childStreamEntries,
            streams,
          ).length
        : 0,
    activeProcesses: statusSlice?.activeProcesses.length ?? 0,
    approvalDepth: approvals.depth,
    approvalKind: approvals.kind,
    taskControlsAvailable: props.taskControlsAvailable,
    agentSelectionAvailable: props.agentSelectionAvailable,
    subagentControlsAvailable: props.subagentControlsAvailable,
    hasMultipleStreams: streams.size > 1,
    model: sessionMeta.model,
    apiMode: shortCliApiMode(sessionMeta.apiMode),
    transcriptMode: sessionMeta.transcriptMode,
    subscriptionActive,
    approvalPolicy: sessionMeta.approvalPolicy,
    shiftEnterNewline: caps.kittyKeyboard,
    transcriptAvailable: props.transcriptAvailable,
    width: columns,
    ctrlCAction: target.ctrlCAction,
    isChildStream: target.isChildStream,
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
                color={segment.badgeColor ?? COLOR_ERROR}
              >
                {segment.text}
              </Badge>
            ) : (
              <Text
                key={`${segment.text}-${index}`}
                aria-hidden={segment.decorative}
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
