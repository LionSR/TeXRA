import { Box, Text, useWindowSize } from 'ink';
import { Badge } from '@inkjs/ui';
import { useMemo, useRef, useState } from 'react';

import { getServerSideKeyService } from '@auth/serverKeys';
import { resolveCliModelAccessRoute } from '@cli/runtime/modelAccessRoute';
import { loadingFrameAt } from '@cli/tui/ui/LoadingIndicator';
import { COLOR_ERROR } from '@cli/tui/ui/colors';
import { useLiveNowMsSince } from '@cli/tui/useLiveNowMs';
import { usePollingInterval } from '@cli/tui/usePollingInterval';
import {
  isCodexSubscriptionActive,
  isKimiCodeSubscriptionActive,
  isXaiSubscriptionActive,
} from '@model/providerCapabilities';
import type { SpendingStatus } from '@shared/schemas';
import { isActivePhase } from '@shared/streams/streamStatus';

import { approvalQueueStatus } from '../state/approvalQueue';
import { terminalCapabilities } from '../state/terminalCapabilities';
import {
  codexPreferenceVersion as codexPreferenceVersionSignal,
  transientNotice as transientNoticeSignal,
  activeStreamId as activeStreamIdSignal,
  rootRunPending as rootRunPendingSignal,
  rootRunStreamId as rootRunStreamIdSignal,
  sessionMeta as sessionMetaSignal,
  streams as streamsSignal,
  NO_BYPASS,
} from '../state/cliState';
import { chatTuiCanStopVisibleRun } from '../state/sessionRunState';
import {
  childStreamEntries as childStreamEntriesSignal,
  parentStream as parentStreamSignal,
  visibleSubagentRows,
} from '../state/childExecutions';
import { useSignal } from '../state/useSignal';
import {
  buildStatusBarDisplay,
  statusBarStreamTarget,
} from './statusBarDisplay';

const CODEX_SUBSCRIPTION_REFRESH_MS = 10_000;
const RELAY_QUOTA_REFRESH_MS = 10_000;

interface StatusBarProps {
  readonly agentSelectionAvailable?: boolean;
  readonly childListFocused?: boolean;
  readonly childListSelectionKillable?: boolean;
  readonly childListSelectionWorkflowControllable?: boolean;
  readonly runningSessions?: number;
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
  const transientNotice = useSignal(transientNoticeSignal);
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
  // Use root-session access facts only before any stream exists.
  const accessModel = statusSlice?.model ?? sessionMeta.model;

  // Whether the selected stream's model would currently route through
  // ChatGPT, Grok, or Kimi Code subscription access. The completed usage
  // snapshot supersedes this prospective value in the display. Polling
  // re-reads external config changes; an in-process access change also bumps
  // `codexPreferenceVersion` for an immediate refresh.
  const codexPreferenceVersion = useSignal(codexPreferenceVersionSignal);
  const [subscriptionResolution, setSubscriptionResolution] = useState<{
    readonly model: string;
    readonly preferenceVersion: number;
    readonly active: boolean;
    readonly grokActive: boolean;
    readonly kimiCodeActive: boolean;
  }>();
  const resolutionCurrent =
    subscriptionResolution?.model === accessModel &&
    subscriptionResolution.preferenceVersion === codexPreferenceVersion;
  const resolution = resolutionCurrent ? subscriptionResolution : undefined;
  const subscriptionActive = resolution?.active ?? false;
  const grokSubscriptionActive = resolution?.grokActive ?? false;
  const kimiCodeActive = resolution?.kimiCodeActive ?? false;
  const modelAccess = resolveCliModelAccessRoute({
    apiMode: sessionMeta.apiMode,
    subscriptionActive,
    grokSubscriptionActive,
    kimiCodeActive,
    usageRoute: statusSlice?.usage?.usageRoute,
  });

  // Both periodic reads run on the shared poll registry (`usePollingInterval`)
  // so cadence and cleanup live in one place; the `resetKey` re-fires
  // immediately when the read's inputs change, matching the old effect deps.
  const subscriptionInFlightRef = useRef(false);
  usePollingInterval(
    () => {
      if (subscriptionInFlightRef.current) return; // Skip if the previous read has not resolved.
      subscriptionInFlightRef.current = true;
      void Promise.all([
        isCodexSubscriptionActive(accessModel),
        isXaiSubscriptionActive(accessModel),
        isKimiCodeSubscriptionActive(accessModel),
      ])
        .then(([active, grokActive, kimiActive]) =>
          setSubscriptionResolution({
            model: accessModel,
            preferenceVersion: codexPreferenceVersion,
            active,
            grokActive,
            kimiCodeActive: kimiActive,
          }),
        )
        .catch(() =>
          setSubscriptionResolution({
            model: accessModel,
            preferenceVersion: codexPreferenceVersion,
            active: false,
            grokActive: false,
            kimiCodeActive: false,
          }),
        )
        .finally(() => {
          subscriptionInFlightRef.current = false;
        });
    },
    CODEX_SUBSCRIPTION_REFRESH_MS,
    `${accessModel}:${codexPreferenceVersion}`,
  );

  // The relay spend snapshot only changes when the tier config is refetched
  // (5-minute TTL), so poll the cached accessor rather than waiting for the
  // next launch: a quota warning that only appears at startup is useless to a
  // session that crosses the threshold mid-run. `getSpendingStatus` returns
  // the retained snapshot object, so an unchanged read re-renders nothing.
  const [relayQuota, setRelayQuota] = useState<SpendingStatus>();
  usePollingInterval(
    () =>
      setRelayQuota(getServerSideKeyService().getSpendingStatus() ?? undefined),
    RELAY_QUOTA_REFRESH_MS,
  );

  const runStartedAt = isActivePhase(statusSlice?.status)
    ? statusSlice?.runStartedAt
    : undefined;
  const now = useLiveNowMsSince([runStartedAt]);

  // Rebuilds the retained + active child rows, so keep it off the 1 Hz
  // elapsed-time re-render path.
  const displayStreamId = target.displayStreamId;
  const subagentCount = useMemo(
    () =>
      displayStreamId === undefined
        ? 0
        : visibleSubagentRows(displayStreamId, childStreamEntries, streams)
            .length,
    [childStreamEntries, displayStreamId, streams],
  );

  const display = buildStatusBarDisplay({
    status: statusSlice?.status,
    substate: statusSlice?.substate,
    elapsedMs: runStartedAt !== undefined ? now - runStartedAt : undefined,
    runningFrame: runStartedAt !== undefined ? loadingFrameAt(now) : undefined,
    transientNotice,
    commandName: props.commandName,
    bypass: statusSlice?.bypass ?? NO_BYPASS,
    thinkingActive: statusSlice?.thinkingActive ?? false,
    compactingActive: statusSlice?.compactingActive ?? false,
    queuedFollowUpMessages: statusSlice?.queuedFollowUpMessages ?? [],
    usage: statusSlice?.usage,
    stage: statusSlice?.stage,
    subagents: subagentCount,
    runningSessions: props.runningSessions ?? 0,
    approvalDepth: approvals.depth,
    approvalKind: approvals.kind,
    model: accessModel,
    modelAccess,
    relayQuota,
    transcriptMode: sessionMeta.transcriptMode,
    approvalPolicy: sessionMeta.approvalPolicy,
    width: columns,
    ctrlCAction: target.ctrlCAction,
    isChildStream: target.isChildStream,
    foreground: {
      inputActive: props.foregroundInputActive,
      escapeAction: props.foregroundEscapeAction,
      shortcutsActive: props.shortcutsActive,
    },
    childList: {
      focused: props.childListFocused,
      selectionKillable: props.childListSelectionKillable,
      selectionWorkflowControllable:
        props.childListSelectionWorkflowControllable,
    },
    shortcuts: {
      agentSelectionAvailable: props.agentSelectionAvailable,
      childNavigationAvailable: props.childNavigationAvailable,
      parentNavigationAvailable:
        activeStreamId !== undefined && parentStream.has(activeStreamId),
      streamFocusAvailable: props.streamFocusAvailable,
      shiftEnterNewline: caps.kittyKeyboard,
      transcriptAvailable: props.transcriptAvailable,
    },
  });

  return (
    <Box flexDirection="column">
      {/* height+overflow clamp: if the fitting sweep ever misses, clip the
          row instead of letting Text soft-wrap the status area to 3 rows and
          break the pinned 2-row chrome budget (scrollback churn, no alt
          screen to hide it). */}
      <Box paddingX={1} height={1} overflow="hidden">
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
