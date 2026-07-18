import { Box, Text, useWindowSize } from 'ink';
import { Badge } from '@inkjs/ui';
import { useEffect, useState } from 'react';

import { resolveCliModelAccessRoute } from '@cli/runtime/modelAccessRoute';
import { isCodexSubscriptionActive } from '@model/codexSubscriptionActive';
import { isActivePhase } from '@shared/streams/streamStatus';

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
  streamAccessTarget,
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
import { loadingFrameAt } from '../ui/LoadingIndicator';
import { useSignal } from '../state/useSignal';
import {
  buildStatusBarDisplay,
  statusBarStreamTarget,
} from './statusBarDisplay';

const CODEX_SUBSCRIPTION_REFRESH_MS = 10_000;

interface StatusBarProps {
  readonly agentSelectionAvailable?: boolean;
  readonly childListFocused?: boolean;
  readonly childListSelectionKind?: 'stream' | 'process';
  readonly childListSelectionKillable?: boolean;
  readonly childListSelectionWorkflowControllable?: boolean;
  readonly childNavigationAvailable: boolean;
  readonly commandName?: string;
  readonly foregroundEscapeAction?: string;
  readonly foregroundInputActive?: boolean;
  readonly shortcutsActive?: boolean;
  readonly streamFocusAvailable: boolean;
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
  const accessTarget = streamAccessTarget(statusSlice, sessionMeta);

  // Whether the selected stream's model/category would currently route through
  // the ChatGPT subscription (preference + eligibility + signed in). The
  // completed usage snapshot supersedes this prospective value in the display.
  // Polling re-reads external config changes; an in-process access change also
  // bumps `codexPreferenceVersion` for an immediate refresh.
  const codexPreferenceVersion = useSignal(codexPreferenceVersionSignal);
  const [subscriptionResolution, setSubscriptionResolution] = useState<{
    readonly model: string;
    readonly category: typeof accessTarget.category;
    readonly preferenceVersion: number;
    readonly active: boolean;
  }>();
  const subscriptionActive =
    subscriptionResolution?.model === accessTarget.model &&
    subscriptionResolution.category === accessTarget.category &&
    subscriptionResolution.preferenceVersion === codexPreferenceVersion
      ? subscriptionResolution.active
      : false;
  const modelAccess = resolveCliModelAccessRoute({
    apiMode: sessionMeta.apiMode,
    subscriptionActive,
    usageRoute: statusSlice?.usage?.usageRoute,
  });

  useEffect(() => {
    let cancelled = false;
    const resolve = (active: boolean): void => {
      if (cancelled) return;
      setSubscriptionResolution({
        ...accessTarget,
        preferenceVersion: codexPreferenceVersion,
        active,
      });
    };
    const agentCategory = accessTarget.category;
    if (agentCategory === undefined) {
      resolve(false);
      return;
    }
    let inFlight = false;
    const refresh = (): void => {
      if (inFlight) return; // Skip if the previous read has not resolved.
      inFlight = true;
      void isCodexSubscriptionActive(accessTarget.model, agentCategory)
        .then(resolve)
        .catch(() => resolve(false))
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
  }, [accessTarget.category, accessTarget.model, codexPreferenceVersion]);

  const runStartedAt = isActivePhase(statusSlice?.status)
    ? statusSlice?.runStartedAt
    : undefined;
  const now = useLiveNowMs(runStartedAt !== undefined, runStartedAt);

  const display = buildStatusBarDisplay({
    status: statusSlice?.status,
    substate: statusSlice?.substate,
    elapsedMs: runStartedAt !== undefined ? now - runStartedAt : undefined,
    runningFrame: runStartedAt !== undefined ? loadingFrameAt(now) : undefined,
    pendingExitHint,
    pendingExitResumeId,
    commandName: props.commandName,
    bypass: statusSlice?.bypass ?? NO_BYPASS,
    thinkingActive: statusSlice?.thinkingActive ?? false,
    queuedFollowUpMessages: statusSlice?.queuedFollowUpMessages ?? [],
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
    agentSelectionAvailable: props.agentSelectionAvailable,
    childListFocused: props.childListFocused,
    childListSelectionKind: props.childListSelectionKind,
    childListSelectionKillable: props.childListSelectionKillable,
    childListSelectionWorkflowControllable:
      props.childListSelectionWorkflowControllable,
    childNavigationAvailable: props.childNavigationAvailable,
    streamFocusAvailable: props.streamFocusAvailable,
    model: accessTarget.model,
    modelAccess,
    transcriptMode: sessionMeta.transcriptMode,
    approvalPolicy: sessionMeta.approvalPolicy,
    shiftEnterNewline: caps.kittyKeyboard,
    transcriptAvailable: props.transcriptAvailable,
    width: columns,
    ctrlCAction: target.ctrlCAction,
    isChildStream: target.isChildStream,
    foregroundEscapeAction: props.foregroundEscapeAction,
    foregroundInputActive: props.foregroundInputActive,
    shortcutsActive: props.shortcutsActive,
  });

  return (
    <Box flexDirection="column">
      <Box paddingX={1}>
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
      </Box>
      <Box paddingX={1}>
        <Text dimColor wrap="truncate-end">
          {display.bindings}
        </Text>
      </Box>
    </Box>
  );
}
