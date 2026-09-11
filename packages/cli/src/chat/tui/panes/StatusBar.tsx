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
import {
  isEmptyUsage,
  type SubscriptionUsageProvider,
  type SubscriptionUsageSnapshot,
  type UsageRoute,
} from '@shared/schemas';
import { descendantRuns } from '@shared/session/sessionView';
import { isActivePhase } from '@shared/runs/runStatus';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { terminalCapabilities } from '../state/terminalCapabilities';
import {
  codexPreferenceVersion as codexPreferenceVersionSignal,
  transientNotice as transientNoticeSignal,
  selectedRunId as selectedRunIdSignal,
  claimedRunId as claimedRunIdSignal,
  rootRunPending as rootRunPendingSignal,
  rootRunId as rootRunIdSignal,
  sessionMeta as sessionMetaSignal,
} from '../state/cliState';
import {
  ancestorPhaseLabel,
  sessionView,
  runPhaseOf,
  runViewOf,
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
  statusBarRunTarget,
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
  readonly runFocusAvailable: boolean;
  readonly transcriptAvailable?: boolean;
}

export function StatusBar(props: StatusBarProps): React.JSX.Element {
  const subscriptionUsage = useMemo(() => new SubscriptionUsageService(), []);
  const { write: writeStderr } = useStderr();
  const activeRunId = useSignal(selectedRunIdSignal);
  const view = useSignal(sessionView());
  const rootRunId = useSignal(rootRunIdSignal);
  const sessionMeta = useSignal(sessionMetaSignal);
  const transientNotice = useSignal(transientNoticeSignal);
  const caps = useSignal(terminalCapabilities);
  const { columns } = useWindowSize();
  // The Ctrl-C stop/exit hint derives from published run-state signals, never
  // from impure session closures: memoized renders cache a closure's result
  // on the closure's identity, which froze the hint at its boot-time value
  // for the whole run (#8273).
  const rootRunPending = useSignal(rootRunPendingSignal);
  const claimedRunId = useSignal(claimedRunIdSignal);
  const runStopFacts = {
    runPending: rootRunPending,
    runId: claimedRunId,
    status: runPhaseOf(runViewOf(view, claimedRunId)),
  };
  const ownedRunIds = useMemo(
    () => descendantRuns(view, rootRunId, { includeRoot: true }),
    [view, rootRunId],
  );
  const target = statusBarRunTarget({
    activeRunId,
    canStopActiveRun: chatTuiCanStopVisibleRun(runStopFacts),
    // The whole pending-run window, not just its launch gap: a restored
    // stream's phase is derived, so a run whose stream has not reported one
    // yet must still read "stop" — Ctrl-C would stop it.
    canStopPendingRun: chatTuiCanStopActiveRun(runStopFacts),
    ownedRunIds,
    view,
  });
  const displayRunId = target.displayRunId;
  const displayRun = runViewOf(view, displayRunId);
  const displayStatus = runPhaseOf(displayRun);
  // The run's cumulative usage: the same figure the subagent rows and the
  // exit summary present.
  const displayUsage =
    displayRun && !isEmptyUsage(displayRun.usage)
      ? displayRun.usage
      : undefined;
  // Use root-session access facts only before any stream exists.
  const accessModel = displayRun?.model ?? sessionMeta.model;

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
    isActivePhase(displayStatus) && displayRun?.runStartedAt !== null
      ? displayRun?.runStartedAt
      : undefined;
  const now = useLiveNowMsSince([runStartedAt]);

  const subagentCount = displayRun?.rollup.total ?? 0;
  // Every request awaiting the user: the fold's approvals and open
  // inquiries, the same list the modal and the title read.
  const attention = attentionRequests(view);

  // Nested-session location: the nearest workflow-script ancestor's open
  // phase, then the focused stream's label.
  const focusedRunId = target.isChildRun ? displayRunId : undefined;
  const focusedLabel =
    focusedRunId === undefined
      ? undefined
      : (runViewOf(view, focusedRunId)?.label ?? focusedRunId);
  const focusedPhaseHeading =
    focusedRunId === undefined
      ? undefined
      : ancestorPhaseLabel(view, focusedRunId);

  const display = buildStatusBarDisplay({
    status: displayStatus,
    statusLabel: displayRun?.statusLabel,
    turn: {
      elapsedMs: runStartedAt !== undefined ? now - runStartedAt : undefined,
      runningFrame:
        runStartedAt !== undefined ? loadingFrameAt(now) : undefined,
      thinkingActive: displayRun?.thinkingActive ?? false,
      compactingActive: displayRun?.compactingActive ?? false,
    },
    transientNotice,
    commandName: props.commandName,
    bypass:
      displayRunId === undefined
        ? undefined
        : view.policy.get(displayRunId)?.bypasses,
    queuedFollowUpMessages:
      displayRunId === undefined
        ? []
        : (view.queuedFollowUps.get(displayRunId) ?? []),
    usage: displayUsage,
    contextState: displayRun?.context ?? undefined,
    stage: displayRun?.stage ?? undefined,
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
    isChildRun: target.isChildRun,
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
      parentNavigationAvailable: runViewOf(view, activeRunId)?.parentId != null,
      runFocusAvailable: props.runFocusAvailable,
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
