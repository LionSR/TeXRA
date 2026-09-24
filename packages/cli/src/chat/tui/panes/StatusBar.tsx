import { Box, Text, useStderr, useWindowSize } from 'ink';
import { Effect, Exit } from 'effect';
import { useMemo, useRef, useState } from 'react';

import { loadingFrameAt } from '@cli/tui/ui/LoadingIndicator';
import { COLOR_ERROR } from '@cli/tui/ui/colors';
import { useLiveNowMsSince } from '@cli/tui/useLiveNowMs';
import { usePollingInterval } from '@cli/tui/usePollingInterval';
import { SubscriptionUsageService } from '@controllers/modelAccess/subscriptionUsage/SubscriptionUsageService';
import { readProspectiveUsageRoute } from '@model/computeModelOptions';
import type { ProcessRuntime, ProcessServices } from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { isEmptyUsage } from '@shared/schemas';
import { descendantRuns } from '@shared/session/sessionView';
import { isActivePhase } from '@shared/runs/runStatus';
import { toErrorMessage } from '@utils/errors/errorMessage';

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
  ancestorPositionLabel,
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
  /**
   * The secret store the subscription quota and route probes read, with the
   * runtime that settles the route program, threaded from the chat surface
   * that opened it — this component owns no runtime of its own.
   */
  readonly secrets: PlatformSecrets;
  /** The three setting slots the subscription route probe reads. */
  readonly stores: SettingsStores;
  readonly runtime: ProcessRuntime;
  readonly childListFocused?: boolean;
  readonly childListSelectionKillable?: boolean;
  readonly childListSelectionResumable?: boolean;
  readonly runningSessions?: number;
  readonly childNavigationAvailable: boolean;
  readonly commandName?: string;
  readonly foregroundInputActive?: boolean;
  readonly transcriptAvailable?: boolean;
}

/**
 * Poll `read` every `intervalMs` on the shared poll registry, and at once when
 * `key` changes. One rule governs staleness: a key already in flight is not
 * re-read, and only the latest request settles, so a superseded read never
 * overwrites a newer one. The settled exit is returned only while its key is
 * still current; an undefined key reads nothing.
 */
function usePolledRead<K extends string, A, E>(
  runtime: ProcessRuntime,
  key: K | undefined,
  read: (key: K) => Effect.Effect<A, E, ProcessServices>,
  intervalMs: number,
): Exit.Exit<A, E> | undefined {
  const [settled, setSettled] = useState<{
    readonly key: K;
    readonly exit: Exit.Exit<A, E>;
  }>();
  const requestRef = useRef<{ generation: number; inFlightKey?: K }>({
    generation: 0,
  });
  usePollingInterval(
    () => {
      const request = requestRef.current;
      if (key !== undefined && request.inFlightKey === key) return;
      const generation = ++request.generation;
      request.inFlightKey = key;
      if (key === undefined) {
        setSettled(undefined);
        return;
      }
      runtime.runFork(read(key)).addObserver((exit) => {
        if (request.generation !== generation) return;
        request.inFlightKey = undefined;
        setSettled({ key, exit });
      });
    },
    intervalMs,
    key,
  );
  return settled !== undefined && settled.key === key
    ? settled.exit
    : undefined;
}

export function StatusBar(props: StatusBarProps): React.JSX.Element {
  const subscriptionUsage = useMemo(
    () =>
      new SubscriptionUsageService({
        secrets: props.secrets,
        stores: props.stores,
      }),
    [props.secrets, props.stores],
  );
  const { write: writeStderr } = useStderr();
  const activeRunId = useSignal(selectedRunIdSignal);
  const view = useSignal(sessionView());
  const rootRunId = useSignal(rootRunIdSignal);
  const sessionMeta = useSignal(sessionMetaSignal);
  const transientNotice = useSignal(transientNoticeSignal);
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
  // immediate refresh. A probe failure is reported once per read key until
  // that key probes successfully.
  const codexPreferenceVersion = useSignal(codexPreferenceVersionSignal);
  const reportedProbeFailureKeysRef = useRef(new Set<string>());
  const routeReadKey = `${accessModel}:${codexPreferenceVersion}`;
  const routeRead = usePolledRead(
    props.runtime,
    routeReadKey,
    () =>
      readProspectiveUsageRoute(
        { ...props.stores, secrets: props.secrets },
        accessModel,
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() =>
            reportedProbeFailureKeysRef.current.delete(routeReadKey),
          ),
        ),
        Effect.tapError((error) =>
          Effect.sync(() => {
            if (reportedProbeFailureKeysRef.current.has(routeReadKey)) return;
            reportedProbeFailureKeysRef.current.add(routeReadKey);
            writeStderr(
              `[warn] [cli.tui] subscription route probe failed for ${accessModel}: ${toErrorMessage(error)}\n`,
            );
          }),
        ),
      ),
    CODEX_SUBSCRIPTION_REFRESH_MS,
  );
  const prospectiveRoute =
    routeRead !== undefined && Exit.isSuccess(routeRead)
      ? routeRead.value
      : undefined;
  const subscriptionProbeFailed =
    routeRead !== undefined &&
    Exit.isFailure(routeRead) &&
    displayUsage?.usageRoute === undefined;
  const modelAccess = displayUsage?.usageRoute ?? prospectiveRoute;

  // `getUsage` always succeeds with a snapshot (see its class doc): an
  // `unavailable` snapshot is the designed carrier of a transport failure.
  const subscriptionUsageProvider = subscriptionUsageProviderForStatus({
    usageRoute: displayUsage?.usageRoute,
    prospectiveRoute,
  });
  const quotaRead = usePolledRead(
    props.runtime,
    subscriptionUsageProvider,
    (provider) => subscriptionUsage.getUsage(provider),
    SUBSCRIPTION_QUOTA_REFRESH_MS,
  );
  const subscriptionQuota =
    quotaRead !== undefined && Exit.isSuccess(quotaRead)
      ? quotaRead.value
      : undefined;

  const runStartedAt =
    isActivePhase(displayStatus) && displayRun?.runStartedAt !== null
      ? displayRun?.runStartedAt
      : undefined;
  const now = useLiveNowMsSince([runStartedAt]);

  const subagentCount = displayRun?.rollup.total ?? 0;
  // Every request awaiting the user: the fold's pending approvals, the
  // same list the modal and the title read.
  const attention = attentionRequests(view);

  // Nested-session location: the nearest ancestor's open phase or loop
  // position, then the focused stream's label.
  const focusedRunId = target.isChildRun ? displayRunId : undefined;
  const focusedLabel =
    focusedRunId === undefined
      ? undefined
      : (runViewOf(view, focusedRunId)?.label ?? focusedRunId);
  const focusedRoundHeading =
    focusedRunId === undefined
      ? undefined
      : ancestorPositionLabel(view, focusedRunId);

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
    queuedFollowUpMessages: (displayRunId === undefined
      ? []
      : (view.queuedFollowUps.get(displayRunId) ?? [])
    ).map((followUp) => followUp.text),
    usage: displayUsage,
    contextState: displayRun?.context ?? undefined,
    flow: displayRun?.flow ?? undefined,
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
        : { context: focusedRoundHeading, label: focusedLabel },
    foreground: {
      inputActive: props.foregroundInputActive,
    },
    childList: {
      focused: props.childListFocused,
      selectionKillable: props.childListSelectionKillable,
      selectionResumable: props.childListSelectionResumable,
    },
    shortcuts: {
      chatInputAvailable: props.chatInputAvailable,
      childNavigationAvailable: props.childNavigationAvailable,
      parentNavigationAvailable: runViewOf(view, activeRunId)?.parentId != null,
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
              <Text
                key={`${segment.text}-${index}`}
                backgroundColor={segment.badgeColor ?? COLOR_ERROR}
              >
                {' '}
                <Text color="black">{segment.text.toUpperCase()}</Text>{' '}
              </Text>
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
