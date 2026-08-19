import { Box, Text, useWindowSize } from 'ink';
import { Badge } from '@inkjs/ui';
import { useMemo, useRef, useState } from 'react';

import { resolveCliModelAccessRoute } from '@cli/runtime/modelAccessRoute';
import { loadingFrameAt } from '@cli/tui/ui/LoadingIndicator';
import { COLOR_ERROR } from '@cli/tui/ui/colors';
import { useLiveNowMsSince } from '@cli/tui/useLiveNowMs';
import { usePollingInterval } from '@cli/tui/usePollingInterval';
import { SubscriptionUsageService } from '@controllers/modelAccess/subscriptionUsage/SubscriptionUsageService';
import { activeCodingPlanForModel } from '@model/codingPlanSubscriptions';
import {
  isCodexSubscriptionActive,
  isXaiSubscriptionActive,
} from '@model/providerCapabilities';
import type {
  SubscriptionUsageProvider,
  SubscriptionUsageSnapshot,
} from '@shared/schemas';
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
  childRosters as childRostersSignal,
  parentStream as parentStreamSignal,
  queuedFollowUpsFor,
  sessionStateRevision,
  streamMetadataFor,
  streamStateFor,
  visibleSubagentRows,
} from '../state/childExecutions';
import { streamDisplayLabel } from '../state/streamViews';
import {
  ancestorWorkflowPhaseHeading,
  focusedSessionLocationText,
} from '../state/workflowPhase';
import { useSignal } from '../state/useSignal';
import {
  buildStatusBarDisplay,
  statusBarStreamTarget,
  subscriptionUsageProviderForStatus,
} from './statusBarDisplay';

const CODEX_SUBSCRIPTION_REFRESH_MS = 10_000;
const SUBSCRIPTION_QUOTA_REFRESH_MS = 30_000;
interface StatusBarProps {
  readonly agentSelectionAvailable?: boolean;
  /** True when the focused stream has a composer for slash commands and text. */
  readonly chatInputAvailable: boolean;
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
  const subscriptionUsage = useMemo(() => new SubscriptionUsageService(), []);
  const activeStreamId = useSignal(activeStreamIdSignal);
  const streams = useSignal(streamsSignal);
  const parentStream = useSignal(parentStreamSignal);
  const childRosters = useSignal(childRostersSignal);
  const sessionMeta = useSignal(sessionMetaSignal);
  // Subscribe to the shared SessionState: the model/stage/queued-follow-up
  // reads below go through its helpers rather than the streams map.
  useSignal(sessionStateRevision);
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
  const displayStreamId = target.displayStreamId;
  // Use root-session access facts only before any stream exists.
  const accessModel =
    (displayStreamId === undefined
      ? undefined
      : streamMetadataFor(displayStreamId)?.config?.model) ?? sessionMeta.model;

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
    readonly glmCodingPlanActive: boolean;
    readonly codingPlanUsageProvider?: SubscriptionUsageProvider;
  }>();
  const resolutionCurrent =
    subscriptionResolution?.model === accessModel &&
    subscriptionResolution.preferenceVersion === codexPreferenceVersion;
  const resolution = resolutionCurrent ? subscriptionResolution : undefined;
  const subscriptionActive = resolution?.active ?? false;
  const grokSubscriptionActive = resolution?.grokActive ?? false;
  const kimiCodeActive = resolution?.kimiCodeActive ?? false;
  const glmCodingPlanActive = resolution?.glmCodingPlanActive ?? false;
  const modelAccess = resolveCliModelAccessRoute({
    subscriptionActive,
    grokSubscriptionActive,
    kimiCodeActive,
    glmCodingPlanActive,
    usageRoute: statusSlice?.usage?.usageRoute,
  });

  // Both periodic reads run on the shared poll registry (`usePollingInterval`)
  // so cadence and cleanup live in one place; the `resetKey` re-fires
  // immediately when the read's inputs change, matching the old effect deps.
  // Scope the in-flight guard by read key so a pending lookup for the old
  // model/preference cannot suppress the reset-triggered re-fire. Completions
  // also check the latest desired key so a superseded promise cannot overwrite
  // a newer resolution (resolutionCurrent would then hide the current route).
  const subscriptionInFlightKeyRef = useRef<string | null>(null);
  const subscriptionDesiredKeyRef = useRef(
    `${accessModel}:${codexPreferenceVersion}`,
  );
  subscriptionDesiredKeyRef.current = `${accessModel}:${codexPreferenceVersion}`;
  usePollingInterval(
    () => {
      const readKey = `${accessModel}:${codexPreferenceVersion}`;
      if (subscriptionInFlightKeyRef.current === readKey) return;
      subscriptionInFlightKeyRef.current = readKey;
      void Promise.all([
        isCodexSubscriptionActive(accessModel),
        isXaiSubscriptionActive(accessModel),
        activeCodingPlanForModel(accessModel),
      ])
        .then(([active, grokActive, codingPlan]) => {
          if (subscriptionDesiredKeyRef.current !== readKey) return;
          setSubscriptionResolution({
            model: accessModel,
            preferenceVersion: codexPreferenceVersion,
            active,
            grokActive,
            kimiCodeActive: codingPlan?.descriptor.id === 'kimiCode',
            glmCodingPlanActive: codingPlan?.descriptor.id === 'glmCodingPlan',
            codingPlanUsageProvider: codingPlan?.descriptor.usageProvider,
          });
        })
        .catch(() => {
          if (subscriptionDesiredKeyRef.current !== readKey) return;
          setSubscriptionResolution({
            model: accessModel,
            preferenceVersion: codexPreferenceVersion,
            active: false,
            grokActive: false,
            kimiCodeActive: false,
            glmCodingPlanActive: false,
          });
        })
        .finally(() => {
          if (subscriptionInFlightKeyRef.current === readKey) {
            subscriptionInFlightKeyRef.current = null;
          }
        });
    },
    CODEX_SUBSCRIPTION_REFRESH_MS,
    `${accessModel}:${codexPreferenceVersion}`,
  );

  const subscriptionUsageProvider = subscriptionUsageProviderForStatus({
    usageRoute: statusSlice?.usage?.usageRoute,
    modelAccess,
    prospectiveCodingPlan: resolution?.codingPlanUsageProvider,
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
      void subscriptionUsage
        .getUsage(provider)
        .then((snapshot) => {
          if (desiredUsageProviderRef.current !== provider) return;
          setSubscriptionQuotaRead({
            provider,
            snapshot,
          });
        })
        .catch(() => {
          if (desiredUsageProviderRef.current === provider) {
            setSubscriptionQuotaRead(undefined);
          }
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

  // Shared execution record for the displayed stream: stage and the model
  // handler's context-occupancy snapshot both come from it.
  const displayStreamState =
    displayStreamId === undefined ? undefined : streamStateFor(displayStreamId);

  const runStartedAt = isActivePhase(statusSlice?.status)
    ? statusSlice?.runStartedAt
    : undefined;
  const now = useLiveNowMsSince([runStartedAt]);

  // Reads the retained + active child roster, so keep it off the 1 Hz
  // elapsed-time re-render path.
  const subagentCount = useMemo(
    () =>
      displayStreamId === undefined
        ? 0
        : visibleSubagentRows(displayStreamId, childRosters).length,
    [childRosters, displayStreamId],
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
    queuedFollowUpMessages:
      displayStreamId === undefined ? [] : queuedFollowUpsFor(displayStreamId),
    usage: statusSlice?.usage,
    contextState: displayStreamState?.contextState,
    stage: displayStreamState?.stage,
    subagents: subagentCount,
    runningSessions: props.runningSessions ?? 0,
    approvalDepth: approvals.depth,
    approvalKind: approvals.kind,
    modelAccess,
    subscriptionQuota,
    transcriptMode: sessionMeta.transcriptMode,
    approvalPolicy: sessionMeta.approvalPolicy,
    width: columns,
    ctrlCAction: target.ctrlCAction,
    isChildStream: target.isChildStream,
    location: focusedSessionLocationText({
      isChildStream: target.isChildStream,
      label:
        target.displayStreamId === undefined
          ? ''
          : streamDisplayLabel({
              childRosters,
              parentStream,
              streamId: target.displayStreamId,
            }),
      phaseHeading:
        target.displayStreamId === undefined
          ? undefined
          : ancestorWorkflowPhaseHeading({
              categoryOf: (id) => streamMetadataFor(id)?.agentCategory,
              parentStream,
              streamId: target.displayStreamId,
              streams,
            }),
    }),
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
      chatInputAvailable: props.chatInputAvailable,
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
