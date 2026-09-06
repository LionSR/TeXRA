import { Box, Text, useStderr, useWindowSize } from 'ink';
import { Badge } from '@inkjs/ui';
import { useLayoutEffect, useMemo, useRef, useState } from 'react';

import { resolveCliModelAccessRoute } from '@cli/runtime/modelAccessRoute';
import { loadingFrameAt } from '@cli/tui/ui/LoadingIndicator';
import { COLOR_ERROR } from '@cli/tui/ui/colors';
import { useLiveNowMsSince } from '@cli/tui/useLiveNowMs';
import { usePollingInterval } from '@cli/tui/usePollingInterval';
import { SubscriptionUsageService } from '@controllers/modelAccess/subscriptionUsage/SubscriptionUsageService';
import { activeSubscriptionUsageRoute } from '@model/codingPlanSubscriptions';
import type {
  SubscriptionUsageProvider,
  SubscriptionUsageSnapshot,
  UsageRoute,
} from '@shared/schemas';
import { isActivePhase } from '@shared/streams/streamStatus';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { terminalCapabilities } from '../state/terminalCapabilities';
import {
  codexPreferenceVersion as codexPreferenceVersionSignal,
  transientNotice as transientNoticeSignal,
  selectedStreamId as selectedStreamIdSignal,
  rootRunPending as rootRunPendingSignal,
  rootRunStreamId as rootRunStreamIdSignal,
  sessionMeta as sessionMetaSignal,
  rootStreamId as rootStreamIdSignal,
} from '../state/cliState';
import {
  ancestorPhaseLabel,
  cumulativeUsageOf,
  descendantStreamIds,
  sessionView,
  streamPhaseOf,
  streamViewOf,
} from '../state/sessionView';
import {
  chatTuiCanStopActiveRun,
  chatTuiCanStopVisibleRun,
} from '../state/sessionRunState';
import { attentionRequests } from '../state/approvalQueue';
import { useSignal } from '../state/useSignal';
import {
  approvalQueueStatusKind,
  buildStatusBarDisplay,
  statusBarStreamTarget,
  subscriptionUsageProviderForStatus,
} from './statusBarDisplay';

const CODEX_SUBSCRIPTION_REFRESH_MS = 10_000;
const SUBSCRIPTION_QUOTA_REFRESH_MS = 30_000;
interface StatusBarProps {
  /** True when the focused stream has a composer for slash commands and text. */
  readonly chatInputAvailable: boolean;
  readonly childListFocused?: boolean;
  readonly childListSelectionKillable?: boolean;
  readonly childListSelectionResumable?: boolean;
  readonly runningSessions?: number;
  readonly childNavigationAvailable: boolean;
  readonly commandName?: string;
  readonly foregroundEscapeAction?: string;
  readonly foregroundInputActive?: boolean;
  readonly streamFocusAvailable: boolean;
  readonly transcriptAvailable?: boolean;
}

export function StatusBar(props: StatusBarProps): React.JSX.Element {
  const subscriptionUsage = useMemo(() => new SubscriptionUsageService(), []);
  const { write: writeStderr } = useStderr();
  const activeStreamId = useSignal(selectedStreamIdSignal);
  const view = useSignal(sessionView());
  const rootStreamId = useSignal(rootStreamIdSignal);
  const sessionMeta = useSignal(sessionMetaSignal);
  const transientNotice = useSignal(transientNoticeSignal);
  const caps = useSignal(terminalCapabilities);
  const { columns } = useWindowSize();
  // The Ctrl-C stop/exit hint derives from published run-state signals, never
  // from impure session closures: memoized renders cache a closure's result
  // on the closure's identity, which froze the hint at its boot-time value
  // for the whole run (#8273).
  const rootRunPending = useSignal(rootRunPendingSignal);
  const rootRunStreamId = useSignal(rootRunStreamIdSignal);
  const runStopFacts = {
    runPending: rootRunPending,
    streamId: rootRunStreamId,
    status: streamPhaseOf(streamViewOf(view, rootRunStreamId)),
  };
  const ownedStreamIds = useMemo(
    () => descendantStreamIds(view, rootStreamId),
    [view, rootStreamId],
  );
  const target = statusBarStreamTarget({
    activeStreamId,
    canStopActiveRun: chatTuiCanStopVisibleRun(runStopFacts),
    // The whole pending-run window, not just its launch gap: a restored
    // stream's phase is derived, so a run whose stream has not reported one
    // yet must still read "stop" — Ctrl-C would stop it.
    canStopPendingRun: chatTuiCanStopActiveRun(runStopFacts),
    ownedStreamIds,
    view,
  });
  const displayStreamId = target.displayStreamId;
  const displayStream = streamViewOf(view, displayStreamId);
  const displayStatus = streamPhaseOf(displayStream);
  // The run's cumulative usage: the same figure the subagent rows and the
  // exit summary present.
  const displayUsage = cumulativeUsageOf(displayStream);
  // Use root-session access facts only before any stream exists.
  const accessModel = displayStream?.model ?? sessionMeta.model;

  // Which subscription, if any, would serve the selected stream's model on its
  // next request. The completed usage snapshot supersedes this prospective
  // value in the display. Polling re-reads external config changes; an
  // in-process access change also bumps `codexPreferenceVersion` for an
  // immediate refresh.
  const codexPreferenceVersion = useSignal(codexPreferenceVersionSignal);
  const [subscriptionResolution, setSubscriptionResolution] = useState<{
    readonly model: string;
    readonly preferenceVersion: number;
    readonly route?: UsageRoute;
    readonly failed?: true;
  }>();
  const resolutionCurrent =
    subscriptionResolution?.model === accessModel &&
    subscriptionResolution.preferenceVersion === codexPreferenceVersion;
  const prospectiveRoute = resolutionCurrent
    ? subscriptionResolution?.route
    : undefined;
  const subscriptionProbeFailed =
    resolutionCurrent &&
    subscriptionResolution?.failed === true &&
    displayUsage?.usageRoute === undefined;
  const modelAccess = resolveCliModelAccessRoute({
    usageRoute: displayUsage?.usageRoute,
    prospectiveRoute,
  });

  // Both periodic reads run on the shared poll registry (`usePollingInterval`)
  // so cadence and cleanup live in one place; the `resetKey` re-fires
  // immediately when the read's inputs change, matching the old effect deps.
  // Scope the in-flight guard by read key so a pending lookup for the old
  // model/preference cannot suppress the reset-triggered re-fire. Completions
  // also check the latest desired key and request generation so a superseded
  // promise cannot overwrite a newer resolution, including when a key is reused.
  // Failure reports stay latched per key until that key probes successfully.
  const subscriptionInFlightKeyRef = useRef<string | null>(null);
  const subscriptionRequestGenerationRef = useRef(0);
  const reportedSubscriptionProbeFailureKeysRef = useRef(new Set<string>());
  const subscriptionReadKey = `${accessModel}:${codexPreferenceVersion}`;
  const subscriptionDesiredKeyRef = useRef(subscriptionReadKey);
  useLayoutEffect(() => {
    if (subscriptionDesiredKeyRef.current !== subscriptionReadKey) {
      subscriptionDesiredKeyRef.current = subscriptionReadKey;
      subscriptionRequestGenerationRef.current += 1;
    }
  }, [subscriptionReadKey]);
  usePollingInterval(
    () => {
      const readKey = subscriptionReadKey;
      if (subscriptionInFlightKeyRef.current === readKey) return;
      subscriptionInFlightKeyRef.current = readKey;
      const requestGeneration = ++subscriptionRequestGenerationRef.current;
      void activeSubscriptionUsageRoute(accessModel)
        .then((route) => {
          if (
            subscriptionDesiredKeyRef.current !== readKey ||
            subscriptionRequestGenerationRef.current !== requestGeneration
          ) {
            return;
          }
          reportedSubscriptionProbeFailureKeysRef.current.delete(readKey);
          setSubscriptionResolution({
            model: accessModel,
            preferenceVersion: codexPreferenceVersion,
            route,
          });
        })
        .catch((error: unknown) => {
          if (
            subscriptionDesiredKeyRef.current !== readKey ||
            subscriptionRequestGenerationRef.current !== requestGeneration
          ) {
            return;
          }
          if (!reportedSubscriptionProbeFailureKeysRef.current.has(readKey)) {
            reportedSubscriptionProbeFailureKeysRef.current.add(readKey);
            writeStderr(
              `[warn] [cli.tui] subscription route probe failed for ${accessModel}: ${toErrorMessage(error)}\n`,
            );
          }
          setSubscriptionResolution({
            model: accessModel,
            preferenceVersion: codexPreferenceVersion,
            failed: true,
          });
        })
        .finally(() => {
          if (subscriptionRequestGenerationRef.current === requestGeneration) {
            subscriptionInFlightKeyRef.current = null;
          }
        });
    },
    CODEX_SUBSCRIPTION_REFRESH_MS,
    subscriptionReadKey,
  );

  const subscriptionUsageProvider = subscriptionUsageProviderForStatus({
    usageRoute: displayUsage?.usageRoute,
    prospectiveRoute,
  });
  const [subscriptionQuotaRead, setSubscriptionQuotaRead] = useState<{
    readonly provider: SubscriptionUsageProvider;
    readonly snapshot: SubscriptionUsageSnapshot;
  }>();
  const desiredUsageProviderRef = useRef(subscriptionUsageProvider);
  desiredUsageProviderRef.current = subscriptionUsageProvider;
  usePollingInterval(
    () => {
      if (subscriptionUsageProvider === undefined) {
        setSubscriptionQuotaRead(undefined);
        return;
      }
      const provider = subscriptionUsageProvider;
      // `getUsage` always resolves to a snapshot rather than rejecting (see its
      // class doc), and an `unavailable` snapshot is the designed carrier of a
      // transport failure — so there is no rejection arm to write here.
      void subscriptionUsage.getUsage(provider).then((snapshot) => {
        if (desiredUsageProviderRef.current !== provider) return;
        setSubscriptionQuotaRead({
          provider,
          snapshot,
        });
      });
    },
    SUBSCRIPTION_QUOTA_REFRESH_MS,
    subscriptionUsageProvider,
  );
  const subscriptionQuota =
    subscriptionQuotaRead !== undefined &&
    subscriptionQuotaRead.provider === subscriptionUsageProvider
      ? subscriptionQuotaRead.snapshot
      : undefined;

  const runStartedAt =
    isActivePhase(displayStatus) && displayStream?.runStartedAt !== null
      ? displayStream?.runStartedAt
      : undefined;
  const now = useLiveNowMsSince([runStartedAt]);

  const subagentCount = displayStream?.rollup.total ?? 0;
  // Every request awaiting the user: the fold's approvals and open
  // inquiries, the same list the modal and the title read.
  const attention = attentionRequests(view);

  // Nested-session location: the nearest workflow-script ancestor's open
  // phase, then the focused stream's label.
  const focusedStreamId = target.isChildStream ? displayStreamId : undefined;
  const focusedLabel =
    focusedStreamId === undefined
      ? undefined
      : (streamViewOf(view, focusedStreamId)?.label ?? focusedStreamId);
  const focusedPhaseHeading =
    focusedStreamId === undefined
      ? undefined
      : ancestorPhaseLabel(view, focusedStreamId);

  const display = buildStatusBarDisplay({
    status: displayStatus,
    statusLabel: displayStream?.statusLabel,
    elapsedMs: runStartedAt !== undefined ? now - runStartedAt : undefined,
    runningFrame: runStartedAt !== undefined ? loadingFrameAt(now) : undefined,
    transientNotice,
    commandName: props.commandName,
    bypass:
      displayStreamId === undefined
        ? undefined
        : view.policy.get(displayStreamId)?.bypasses,
    thinkingActive: displayStream?.thinkingActive ?? false,
    compactingActive: displayStream?.compactingActive ?? false,
    queuedFollowUpMessages:
      displayStreamId === undefined
        ? []
        : (view.queuedFollowUps.get(displayStreamId) ?? []),
    usage: displayUsage,
    contextState: displayStream?.context ?? undefined,
    stage: displayStream?.stage ?? undefined,
    subagents: subagentCount,
    runningSessions: props.runningSessions ?? 0,
    approvalDepth: attention.length,
    approvalKind: approvalQueueStatusKind(
      attention.map((request) => request.kind),
    ),
    modelAccess,
    subscriptionProbeFailed,
    subscriptionQuota,
    approvalPolicy: sessionMeta.approvalPolicy,
    width: columns,
    ctrlCAction: target.ctrlCAction,
    isChildStream: target.isChildStream,
    location:
      focusedLabel === undefined
        ? undefined
        : { context: focusedPhaseHeading, label: focusedLabel },
    foreground: {
      inputActive: props.foregroundInputActive,
      escapeAction: props.foregroundEscapeAction,
    },
    childList: {
      focused: props.childListFocused,
      selectionKillable: props.childListSelectionKillable,
      selectionResumable: props.childListSelectionResumable,
    },
    shortcuts: {
      agentSelectionAvailable: !rootRunPending,
      chatInputAvailable: props.chatInputAvailable,
      childNavigationAvailable: props.childNavigationAvailable,
      parentNavigationAvailable:
        streamViewOf(view, activeStreamId)?.parentId != null,
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
