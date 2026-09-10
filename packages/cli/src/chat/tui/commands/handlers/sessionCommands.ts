import { Effect } from 'effect';

import { defaultSession } from '@agent/runtime';
import { notifyFollowUpSent } from '@agent/followUp';
import { resolveCliModelAccessRoute } from '@cli/runtime/modelAccessRoute';
import { defaultShortcutModifierLabel } from '@cli/runtime/shortcutLabels';
import { formatCliSessionStatus } from '@cli/chat/tui/sessionStatus';
import {
  activeRunId as activeStreamIdSignal,
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
import { MESSAGE_TYPES } from '@shared/schemas';
import { GoalStore } from '@tools/goal';
import type { RunSnapshotStore } from '@transcript';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { formatSlashCommandHelp, GOAL_MODE_HELP } from '../helpText';
import { listSlashCommands } from '../slashRegistry';
import { type SlashCommandContext } from './slashContext';

/** What the work-plan reader loads and reads from the snapshot store. */
export type RunArtifactReader = Pick<
  RunSnapshotStore,
  'preload' | 'getWorkPlan'
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

export async function showCliWorkPlan(
  snapshots: RunArtifactReader = defaultSession().snapshots,
): Promise<void> {
  const streamId = activeStreamIdSignal.get();
  if (!streamId) {
    cancelPendingWorkPlanReaderRequest();
    setTransientNotice('No focused session.');
    return;
  }
  clearTransientNotice();
  const request = beginWorkPlanReaderRequest(streamId);
  await effectRuntime().runPromise(
    snapshots.preload([streamId]).pipe(
      Effect.match({
        onFailure: (error) => {
          if (!cancelWorkPlanReaderRequest(request)) return;
          setTransientNotice(
            `Could not load workflow artifacts: ${toErrorMessage(error)}`,
          );
        },
        onSuccess: () => {
          if (!workPlanReaderRequestIsCurrent(request)) return;
          const workPlan = snapshots.getWorkPlan(streamId);
          if (workPlan.plan !== null || workPlan.todos.length > 0) {
            finishWorkPlanReaderRequest(request);
          } else if (cancelWorkPlanReaderRequest(request)) {
            setTransientNotice('The focused session has no work plan.');
          }
        },
      }),
    ),
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
  const activeRunId = activeStreamIdSignal.get();
  const stream = streamViewOf(view, activeRunId);
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
        activeRunId === undefined
          ? undefined
          : view.policy.get(activeRunId)?.bypasses,
      statusLabel: stream?.statusLabel,
      activeChildSessions,
      goal: activeRunId ? GoalStore.getForStream(activeRunId) : undefined,
      activeSkills: activeSkillNamesFor(activeRunId),
      sessionId: stream ? context.session.executionId : undefined,
      commandName: context.cliContext.commandName,
      cwd: context.cliContext.cwd,
      processCwd: context.processCwd,
      approvalPolicy: context.getApprovalPolicy(),
      queuedFollowUpMessages:
        activeRunId === undefined
          ? []
          : (view.queuedFollowUps.get(activeRunId) ?? []),
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
