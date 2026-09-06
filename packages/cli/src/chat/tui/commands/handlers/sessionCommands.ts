import { Effect } from 'effect';

import { defaultSession } from '@agent/runtime';
import { notifyFollowUpSent } from '@agent/followUp';
import { resolveCliModelAccessRoute } from '@cli/runtime/modelAccessRoute';
import { defaultShortcutModifierLabel } from '@cli/runtime/shortcutLabels';
import { formatCliSessionStatus } from '@cli/chat/tui/sessionStatus';
import {
  activeStreamId as activeStreamIdSignal,
  beginWorkPlanReaderRequest,
  cancelPendingWorkPlanReaderRequest,
  cancelWorkPlanReaderRequest,
  clearTransientNotice,
  finishWorkPlanReaderRequest,
  openInfoPane,
  sessionMeta,
  setTransientNotice,
  workPlanReaderRequestIsCurrent,
} from '@cli/chat/tui/state/cliState';
import {
  cumulativeUsageOf,
  currentView,
  runningChildCount,
  streamViewOf,
} from '@cli/chat/tui/state/sessionView';
import { terminalCapabilities } from '@cli/chat/tui/state/terminalCapabilities';
import {
  appendLocalAssistantTranscript,
  appendLocalRequestRefusal,
} from '@cli/chat/tui/state/transcript';
import { activeSubscriptionUsageRoute } from '@model/codingPlanSubscriptions';
import { effectRuntime } from '@platform/processRuntime';
import { MESSAGE_TYPES, type StreamTabId } from '@shared/schemas';
import { GoalStore } from '@tools/goal';
import {
  StreamSnapshotPreloadError,
  type StreamSnapshotStore,
} from '@transcript';
import type { WorkPlanProvenance } from '@transcript';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { formatSlashCommandHelp, GOAL_MODE_HELP } from '../helpText';
import { listSlashCommands } from '../slashRegistry';
import { type SlashCommandContext } from './slashContext';

/** What the work-plan reader loads and reads from the snapshot store. */
export type StreamArtifactReader = Pick<
  StreamSnapshotStore,
  'preload' | 'getWorkPlan' | 'workPlanProvenance'
>;

export function showCliSlashCommandHelp(): void {
  openInfoPane(
    '/help',
    formatSlashCommandHelp(listSlashCommands(), {
      shortcutModifierLabel: defaultShortcutModifierLabel(),
      shiftEnterNewline: terminalCapabilities.get().kittyKeyboard,
    }),
  );
}

export function showCliGoalModeHelp(): void {
  openInfoPane('/goal', GOAL_MODE_HELP);
}

type StreamArtifactHydrationOutcome =
  | { readonly kind: 'complete' }
  | {
      readonly kind: 'partial';
      readonly workPlanProvenance: WorkPlanProvenance;
      readonly error: unknown;
    }
  | { readonly kind: 'failed'; readonly error: unknown };

/** Load a stream's artifact tier from disk so the reader can vouch for it. */
async function hydrateStreamArtifacts(
  store: StreamArtifactReader,
  streamId: StreamTabId,
): Promise<StreamArtifactHydrationOutcome> {
  try {
    await store.preload([streamId], { reportArtifactAuthority: true });
  } catch (error) {
    if (
      error instanceof StreamSnapshotPreloadError &&
      error.streamId === streamId
    ) {
      return {
        kind: 'partial',
        workPlanProvenance: error.workPlanProvenance,
        error,
      };
    }
    return { kind: 'failed', error };
  }
  return { kind: 'complete' };
}

export async function showCliWorkPlan(
  snapshots: StreamArtifactReader = defaultSession().snapshots,
): Promise<void> {
  const streamId = activeStreamIdSignal.get();
  if (!streamId) {
    cancelPendingWorkPlanReaderRequest();
    setTransientNotice('No focused session.');
    return;
  }
  clearTransientNotice();
  const request = beginWorkPlanReaderRequest(streamId);
  const outcome = await hydrateStreamArtifacts(snapshots, streamId);
  if (!workPlanReaderRequestIsCurrent(request)) return;
  if (outcome.kind === 'failed') {
    if (!cancelWorkPlanReaderRequest(request)) return;
    setTransientNotice(
      `Could not load workflow artifacts: ${toErrorMessage(outcome.error)}`,
    );
    return;
  }
  const workPlan = snapshots.getWorkPlan(streamId);
  const provenance =
    outcome.kind === 'complete'
      ? { plan: true, todos: true }
      : outcome.workPlanProvenance;
  const { plan: planIsAuthoritative, todos: todosAreAuthoritative } =
    provenance;
  if (
    (planIsAuthoritative && workPlan.plan !== null) ||
    (todosAreAuthoritative && workPlan.todos.length > 0)
  ) {
    finishWorkPlanReaderRequest(
      request,
      outcome.kind === 'partial' ? provenance : undefined,
    );
    return;
  }
  if (!cancelWorkPlanReaderRequest(request)) return;
  if (
    outcome.kind === 'complete' ||
    (planIsAuthoritative && todosAreAuthoritative)
  ) {
    setTransientNotice('The focused session has no work plan.');
    return;
  }
  setTransientNotice(
    `Could not load workflow artifacts: ${toErrorMessage(outcome.error)}`,
  );
}

function activeSkillNamesFor(streamId: string | undefined): readonly string[] {
  if (streamId === undefined) return [];
  const entries = defaultSession().transcripts.get(streamId)?.getRange(0) ?? [];
  const latest = entries.findLast(
    (entry) => entry.messageType === MESSAGE_TYPES.ACTIVE_SKILLS,
  );
  return latest?.data.skills.map((skill) => skill.name) ?? [];
}

export async function showCliSessionStatus(
  context: SlashCommandContext,
): Promise<void> {
  const meta = sessionMeta.get();
  const view = currentView();
  const activeStreamId = activeStreamIdSignal.get();
  const stream = streamViewOf(view, activeStreamId);
  // The children a status line counts: the active stream's, else its
  // parent's (a focused leaf reports its siblings' activity).
  const countedParent =
    stream && stream.childIds.length === 0 && stream.parentId
      ? streamViewOf(view, stream.parentId)
      : stream;
  const activeChildSessions = runningChildCount(view, countedParent);
  const model = stream?.model ?? (meta.model || context.initialModel);
  const prospectiveRoute = await activeSubscriptionUsageRoute(model);
  appendLocalAssistantTranscript(
    formatCliSessionStatus({
      agent: meta.agent || context.initialAgent,
      model,
      teamName: meta.teamName,
      modelAccess: resolveCliModelAccessRoute({
        usageRoute: cumulativeUsageOf(stream)?.usageRoute,
        prospectiveRoute,
      }),
      approvalBypasses:
        activeStreamId === undefined
          ? undefined
          : view.policy.get(activeStreamId)?.bypasses,
      statusLabel: stream?.statusLabel,
      activeChildSessions,
      goal: activeStreamId ? GoalStore.getForStream(activeStreamId) : undefined,
      activeSkills: activeSkillNamesFor(activeStreamId),
      sessionId: stream ? context.session.executionId : undefined,
      commandName: context.cliContext.commandName,
      cwd: context.cliContext.cwd,
      processCwd: context.processCwd,
      approvalPolicy: context.getApprovalPolicy(),
      queuedFollowUpMessages:
        activeStreamId === undefined
          ? []
          : (view.queuedFollowUps.get(activeStreamId) ?? []),
    }),
  );
}

/** `/compact`: one runtime request; the outcome or refusal becomes a notice. */
export function requestCliSessionCompaction(): void {
  const streamId = activeStreamIdSignal.get();
  if (streamId === undefined) {
    appendLocalAssistantTranscript(
      'No active tool-use session found for context compaction.',
    );
    return;
  }
  const session = defaultSession();
  void effectRuntime().runPromise(
    session.requests.request({ kind: 'stream.compact', streamId }).pipe(
      Effect.match({
        onFailure: (error) => appendLocalRequestRefusal(error, streamId),
        onSuccess: () => {
          notifyFollowUpSent(streamId, session);
          appendLocalAssistantTranscript(
            'Context compaction requested. The agent will process it on the next model call.',
            streamId,
          );
        },
      }),
    ),
  );
}
