import { Box, Text, useStderr, useWindowSize } from 'ink';
import { Cause, Effect, Exit, Fiber, Stream, type Duration } from 'effect';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { apiKeyEntry } from '@texra-ai/llm';
import { appSignalStream, readModelOptions } from '@texra-ai/harness/host';
import { isEmptyUsage, toErrorMessage } from '@texra-ai/harness/schemas';
import { isWorking } from '@texra-ai/harness/schemas';
import { loadingFrameAt } from '@cli/tui/ui/LoadingIndicator';
import { COLOR_ERROR } from '@cli/tui/ui/colors';
import { useLiveNowMsSince } from '@cli/tui/useLiveNowMs';
import { SubscriptionUsageService } from '@texra/controllers/modelAccess/subscriptionUsage/SubscriptionUsageService';

import {
  transientNotice as transientNoticeSignal,
  selectedRunId as selectedRunIdSignal,
  sessionMeta as sessionMetaSignal,
  childListFocused as childListFocusedSignal,
  childListHighlight,
  sessionListRunIds,
} from '../state/cliState';
import {
  killableRunId,
  resumableRunId,
  runningChildCount,
  runViewOf,
  sessionView,
} from '../state/sessionView';
import { resolveChildListTarget } from '../state/childControls';
import {
  chatTuiCanStopVisibleRun,
  runStopFacts as runStopFactsSignal,
} from '../state/sessionRunState';
import { attentionRequests as attentionRequestsSignal } from '../state/approvalQueue';
import { modelConnectionNeeded as modelConnectionNeededSignal } from '../modelConnection';
import { useSignal } from '../state/useSignal';
import {
  approvalQueueStatusKind,
  buildStatusBarDisplay,
  statusBarRunTarget,
  subscriptionUsageProviderForStatus,
} from './statusBarDisplay';
import type { ProcessRuntime, ProcessServices } from '@texra-ai/harness/host';
import type { SettingsStores } from '@texra-ai/harness/plugins';

// Polling re-reads what another process changed; an in-process change to
// model access is followed at once.
const ROUTE_REFRESH = '10 seconds';
const QUOTA_REFRESH = '30 seconds';

/** A change in this process to what routes a model: a provider key, or an
 *  access preference. */
const modelAccessChanges: Stream.Stream<void, never, ProcessServices> =
  Stream.merge(
    appSignalStream('credentialChanged').pipe(
      Stream.filter(({ key }) => {
        // An unknown provider's key routes no model.
        const provider = apiKeyEntry(key);
        return provider !== undefined && provider !== 'unknown';
      }),
    ),
    appSignalStream('modelAccessChanged'),
  ).pipe(Stream.as(undefined));
interface StatusBarProps {
  /** True when the focused stream has a composer for slash commands and text. */
  readonly chatInputAvailable: boolean;
  /** The three setting slots the subscription route probe reads. */
  readonly stores: SettingsStores;
  /**
   * The runtime that runs the quota and route programs (their credentials
   * come from its `Secrets`), threaded from the chat surface that opened it —
   * this component owns no runtime of its own.
   */
  readonly runtime: ProcessRuntime;
  readonly commandName?: string;
  readonly foregroundInputActive?: boolean;
  /** The active run's transcript holds a script's calls (Ctrl-O). */
  readonly scriptAvailable?: boolean;
}

/**
 * The latest exit of `read(key)`: read at once, again on every tick of
 * `every` and every model-access change, a newer read interrupting the one in
 * flight; a new key or unmount interrupts the reads. A run of failures is one
 * value, so its report is said once. An undefined key reads nothing.
 */
function useFollowedRead<K extends string, A, E>(
  runtime: ProcessRuntime,
  key: K | undefined,
  read: (key: K) => Effect.Effect<A, E, ProcessServices>,
  every: Duration.Input,
): Exit.Exit<A, E> | undefined {
  const [latest, setLatest] = useState<{
    readonly key: K;
    readonly exit: Exit.Exit<A, E>;
  }>();
  useEffect(() => {
    if (key === undefined) return;
    const reads = runtime.runFork(
      Stream.merge(Stream.tick(every), modelAccessChanges).pipe(
        Stream.switchMap(() => Stream.fromEffect(Effect.exit(read(key)))),
        Stream.changesWith((a, b) => Exit.isFailure(a) && Exit.isFailure(b)),
        Stream.runForEach((exit) =>
          Effect.sync(() => setLatest({ key, exit })),
        ),
      ),
    );
    return () => {
      runtime.runFork(Fiber.interrupt(reads));
    };
  }, [every, key, read, runtime]);
  return latest !== undefined && latest.key === key ? latest.exit : undefined;
}

export function StatusBar(props: StatusBarProps): React.JSX.Element {
  const subscriptionUsage = useMemo(
    () => new SubscriptionUsageService({ stores: props.stores }),
    [props.stores],
  );
  const { write: writeStderr } = useStderr();
  const activeRunId = useSignal(selectedRunIdSignal);
  const view = useSignal(sessionView());
  const sessionMeta = useSignal(sessionMetaSignal);
  const transientNotice = useSignal(transientNoticeSignal);
  const modelConnectionNeeded = useSignal(modelConnectionNeededSignal);
  const childListFocused = useSignal(childListFocusedSignal);
  const highlightedChild = runViewOf(view, useSignal(childListHighlight));
  const listedRuns = useSignal(sessionListRunIds);
  const { columns } = useWindowSize();
  // The Ctrl-C stop/exit hint derives from the run-claim signal, never from
  // impure session closures: memoized renders cache a closure's result on the
  // closure's identity, which froze the hint at its boot-time value for the
  // whole run (#8273).
  const runStopFacts = useSignal(runStopFactsSignal);
  const target = statusBarRunTarget({
    activeRunId,
    canStop: chatTuiCanStopVisibleRun(runStopFacts),
    view,
  });
  const displayRunId = target.displayRunId;
  const displayRun = runViewOf(view, displayRunId);
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
  // value in the display. A probe failure is reported once per run of
  // failures.
  const readRoute = useCallback(
    (model: string) =>
      readModelOptions(props.stores, [model]).pipe(
        Effect.map(([option]) => option?.usageRoute),
      ),
    [props.stores],
  );
  const routeRead = useFollowedRead(
    props.runtime,
    accessModel,
    readRoute,
    ROUTE_REFRESH,
  );
  useEffect(() => {
    if (routeRead === undefined || Exit.isSuccess(routeRead)) return;
    writeStderr(
      `[warn] [cli.tui] subscription route probe failed for ${accessModel}: ${toErrorMessage(Cause.squash(routeRead.cause))}\n`,
    );
  }, [routeRead, accessModel, writeStderr]);
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
  const readQuota = useCallback(
    (provider: NonNullable<typeof subscriptionUsageProvider>) =>
      subscriptionUsage.getUsage(provider),
    [subscriptionUsage],
  );
  const quotaRead = useFollowedRead(
    props.runtime,
    subscriptionUsageProvider,
    readQuota,
    QUOTA_REFRESH,
  );
  const subscriptionQuota =
    quotaRead !== undefined && Exit.isSuccess(quotaRead)
      ? quotaRead.value
      : undefined;

  const runStartedAt = displayRun?.runStartedAt ?? undefined;
  const now = useLiveNowMsSince([runStartedAt]);

  // Every request awaiting the user: the session view's pending approvals, the
  // same list the modal and the title read.
  const attention = useSignal(attentionRequestsSignal);

  // Nested-session location: the focused stream's label.
  const focusedRunId = target.isChildRun ? displayRunId : undefined;
  const focusedLabel =
    focusedRunId === undefined
      ? undefined
      : (runViewOf(view, focusedRunId)?.label ?? focusedRunId);

  const display = buildStatusBarDisplay(displayRun, view, {
    turn: {
      elapsedMs: runStartedAt !== undefined ? now - runStartedAt : undefined,
      runningFrame:
        runStartedAt !== undefined ? loadingFrameAt(now) : undefined,
    },
    // Until a model is connected, the notice slot keeps saying how to connect
    // one; a real notice still wins while it shows.
    transientNotice:
      transientNotice ??
      (modelConnectionNeeded
        ? { kind: 'message', text: 'No model connected · /login' }
        : undefined),
    commandName: props.commandName,
    runningSessions: runningChildCount(
      view,
      runViewOf(view, resolveChildListTarget(view, activeRunId)),
    ),
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
    location: focusedLabel === undefined ? undefined : { label: focusedLabel },
    foreground: {
      inputActive: props.foregroundInputActive,
    },
    childList: {
      focused: childListFocused,
      selectionKillable: killableRunId(highlightedChild) !== undefined,
      selectionResumable: resumableRunId(highlightedChild) !== undefined,
    },
    shortcuts: {
      chatInputAvailable: props.chatInputAvailable,
      holdAvailable:
        props.chatInputAvailable && displayRun != null && isWorking(displayRun),
      childNavigationAvailable: listedRuns.length > 0,
      parentNavigationAvailable: runViewOf(view, activeRunId)?.parentId != null,
      transcriptAvailable:
        (runViewOf(view, activeRunId)?.transcript.rows.length ?? 0) > 0,
      scriptAvailable: props.scriptAvailable,
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
                color={segment.color}
                dimColor={segment.dim === true}
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
