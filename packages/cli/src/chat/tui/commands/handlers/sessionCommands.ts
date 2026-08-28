// Session-scoped slash commands (`/help`, `/goal`, `/status`, `/compact`),
// wired to their command names in `registerBuiltins`.

import { defaultSession } from '@agent/runtime';
import { notifyFollowUpSent } from '@agent/followUp';
import { resolveCliModelAccessRoute } from '@cli/runtime/modelAccessRoute';
import { defaultShortcutModifierLabel } from '@cli/runtime/shortcutLabels';
import { formatCliSessionStatus } from '@cli/chat/tui/sessionStatus';
import {
  activeSubagentsFor,
  childRosters,
  parentStream,
  streamMetadataFor,
} from '@cli/chat/tui/state/childExecutions';
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
  streamPhaseFor,
  streams,
  workPlanReaderRequestIsCurrent,
} from '@cli/chat/tui/state/cliState';
import {
  hydrateStreamArtifacts,
  readStreamArtifacts,
} from '@cli/chat/tui/state/subscribeStreamArtifacts';
import { terminalCapabilities } from '@cli/chat/tui/state/terminalCapabilities';
import { appendLocalAssistantTranscript } from '@cli/chat/tui/state/transcript';
import { activeStreamParentOrSelfId } from '@cli/chat/tui/state/streamViews';
import type { StreamArtifactReader } from '@cli/chat/tui/state/streamArtifactProjection';
import { activeSubscriptionUsageRoute } from '@model/codingPlanSubscriptions';
import { formatTexraApprovalPolicy } from '@shared/approvalPolicy';
import { MESSAGE_TYPES } from '@shared/schemas';
import { isActivePhase } from '@shared/streams/streamStatus';
import { GoalStore } from '@tools/goal';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { formatSlashCommandHelp, GOAL_MODE_HELP } from '../helpText';
import { listSlashCommands } from '../slashRegistry';
import { type SlashCommandContext } from './slashContext';

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
  const outcome = await hydrateStreamArtifacts(snapshots, streamId, () =>
    workPlanReaderRequestIsCurrent(request),
  );
  if (!outcome || !workPlanReaderRequestIsCurrent(request)) return;
  if (outcome.kind === 'failed') {
    if (!cancelWorkPlanReaderRequest(request)) return;
    setTransientNotice(
      `Could not load workflow artifacts: ${toErrorMessage(outcome.error)}`,
    );
    return;
  }
  const workPlan = snapshots.getWorkPlan(streamId);
  const authority = {
    plan: outcome.kind === 'complete' || outcome.authoritativeFields.plan,
    todos: outcome.kind === 'complete' || outcome.authoritativeFields.todos,
  };
  const { plan: planIsAuthoritative, todos: todosAreAuthoritative } = authority;
  if (
    (planIsAuthoritative && workPlan.plan !== null) ||
    (todosAreAuthoritative && workPlan.todos.length > 0)
  ) {
    finishWorkPlanReaderRequest(
      request,
      outcome.kind === 'partial' ? authority : undefined,
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

/**
 * Skill names in effect for `streamId`, read straight from the stream log.
 *
 * A tool-use run emits one ACTIVE_SKILLS snapshot at prompt-build time, so the
 * newest entry is the answer; older ones only exist across resumed lifetimes.
 * Read on demand rather than folded per delta — `/status` is a one-shot
 * command, and the transcript projection (`projectTranscriptRow`) deliberately
 * carries no row for this message type, so the raw log is the source.
 */
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
  const activeStreamId = activeStreamIdSignal.get();
  const streamSlices = streams.get();
  const slice = activeStreamId ? streamSlices.get(activeStreamId) : undefined;
  const activePhase = slice ? streamPhaseFor(activeStreamId) : undefined;
  const rosters = childRosters.get();
  const directActiveChildren = activeStreamId
    ? activeSubagentsFor(activeStreamId, rosters)
    : [];
  let workflowChildren = directActiveChildren;
  if (activeStreamId && directActiveChildren.length === 0) {
    const parentOrSelfStreamId = activeStreamParentOrSelfId({
      activeStreamId,
      parentStream: parentStream.get(),
    });
    workflowChildren = activeSubagentsFor(parentOrSelfStreamId, rosters);
  }
  const activeChildSessions = workflowChildren.filter((child) =>
    isActivePhase(child.status),
  ).length;
  // Use root-session access facts only before any stream exists.
  const model =
    (activeStreamId
      ? streamMetadataFor(activeStreamId)?.config?.model
      : undefined) ??
    (meta.model || context.initialModel);
  const prospectiveRoute = await activeSubscriptionUsageRoute(model);
  appendLocalAssistantTranscript(
    formatCliSessionStatus({
      agent: meta.agent || context.initialAgent,
      model,
      teamName: meta.teamName,
      modelAccess: resolveCliModelAccessRoute({
        usageRoute: activeStreamId
          ? readStreamArtifacts(activeStreamId)?.cumulativeUsage?.usageRoute
          : undefined,
        prospectiveRoute,
      }),
      approval: formatTexraApprovalPolicy(context.getApprovalPolicy()),
      approvalBypasses: slice?.bypass,
      status: activePhase?.phase,
      substate: activePhase?.substate,
      activeChildSessions,
      goal: activeStreamId ? GoalStore.getForStream(activeStreamId) : undefined,
      activeSkills: activeSkillNamesFor(activeStreamId),
      // Only surface the resume id once a stream exists — never next to
      // a "not started" status.
      sessionId:
        slice && meta.transcriptMode === 'persistent'
          ? context.session.executionId
          : undefined,
      commandName: context.commandName,
      cwd: context.cwd,
      processCwd: context.processCwd,
      approvalPolicy: context.getApprovalPolicy(),
      queuedFollowUpMessages:
        activeStreamId === undefined
          ? []
          : defaultSession().followUps.getAll(activeStreamId),
    }),
  );
}

export function requestCliSessionCompaction(): void {
  const result = defaultSession().executions.requestManualCompaction(
    activeStreamIdSignal.get(),
  );
  switch (result.kind) {
    case 'no_active_tool_use':
      appendLocalAssistantTranscript(
        'No active tool-use session found for context compaction.',
        result.streamId,
      );
      return;
    case 'unsupported':
      appendLocalAssistantTranscript(
        'Manual context compaction is not available for this model.',
        result.streamId,
      );
      return;
    case 'requested':
      notifyFollowUpSent(result.streamId, result.session);
      appendLocalAssistantTranscript(
        'Context compaction requested. The agent will process it on the next model call.',
        result.streamId,
      );
      return;
  }
}
