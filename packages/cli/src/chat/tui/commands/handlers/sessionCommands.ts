import { Effect } from 'effect';

import { defaultSession } from '@agent/runtime';
import { notifyFollowUpSent } from '@agent/followUp';
import { resolveCliModelAccessRoute } from '@cli/runtime/modelAccessRoute';
import { defaultShortcutModifierLabel } from '@cli/runtime/shortcutLabels';
import { formatCliSessionStatus } from '@cli/chat/tui/sessionStatus';
import {
  activeRunId as activeRunIdSignal,
  beginWorkPlanReaderRequest,
  cancelPendingWorkPlanReaderRequest,
  cancelWorkPlanReaderRequest,
  clearTransientNotice,
  finishWorkPlanReaderRequest,
  openInfoPane,
  sessionMeta,
  setTransientNotice,
} from '@cli/chat/tui/state/cliState';
import {
  currentView,
  runningChildCount,
  runViewOf,
} from '@cli/chat/tui/state/sessionView';
import { terminalCapabilities } from '@cli/chat/tui/state/terminalCapabilities';
import {
  appendLocalAssistantTranscript,
  appendLocalRequestRefusal,
} from '@cli/chat/tui/state/transcript';
import { activeSubscriptionUsageRoute } from '@model/codingPlanSubscriptions';
import { effectRuntime } from '@platform/processRuntime';
import { AgentCategory, MESSAGE_TYPES, type RunId } from '@shared/schemas';
import { GoalStore } from '@tools/goal';

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

/** Open the focused run's work plan from the view it is rendered from. */
export function showCliWorkPlan(): void {
  const runId = activeRunIdSignal.get();
  if (!runId) {
    cancelPendingWorkPlanReaderRequest();
    setTransientNotice('No focused session.');
    return;
  }
  clearTransientNotice();
  const request = beginWorkPlanReaderRequest(runId);
  const run = defaultSession().runView(runId);
  if (
    run?.category === AgentCategory.ToolUse &&
    (run.plan !== null || run.todos.length > 0)
  ) {
    finishWorkPlanReaderRequest(request);
  } else if (cancelWorkPlanReaderRequest(request)) {
    setTransientNotice('The focused session has no work plan.');
  }
}

function activeSkillNamesFor(runId: RunId | undefined): readonly string[] {
  if (runId === undefined) return [];
  const entries = defaultSession().transcripts.get(runId)?.getRange(0) ?? [];
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
  const activeRunId = activeRunIdSignal.get();
  const run = runViewOf(view, activeRunId);
  // The children a status line counts: the active run's, else its
  // parent's (a focused leaf reports its siblings' activity).
  const countedParent =
    run && run.childIds.length === 0 && run.parentId
      ? runViewOf(view, run.parentId)
      : run;
  const activeChildSessions = runningChildCount(view, countedParent);
  const model = run?.model ?? (meta.model || context.initialModel);
  const prospectiveRoute = await activeSubscriptionUsageRoute(
    model,
    context.secrets,
  );
  appendLocalAssistantTranscript(
    formatCliSessionStatus({
      agent: meta.agent || context.initialAgent,
      model,
      teamName: meta.teamName,
      modelAccess: resolveCliModelAccessRoute({
        usageRoute: run?.usage.usageRoute,
        prospectiveRoute,
      }),
      approvalBypasses:
        activeRunId === undefined
          ? undefined
          : view.policy.get(activeRunId)?.bypasses,
      statusLabel: run?.statusLabel,
      activeChildSessions,
      goal: activeRunId ? GoalStore.getForRun(activeRunId) : undefined,
      activeSkills: activeSkillNamesFor(activeRunId),
      sessionId: run ? context.session.runId : undefined,
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
  const runId = activeRunIdSignal.get();
  if (runId === undefined) {
    appendLocalAssistantTranscript(
      'No active tool-use session found for context compaction.',
    );
    return;
  }
  const session = defaultSession();
  void effectRuntime().runPromise(
    session.requests.request({ kind: 'run.compact', runId }).pipe(
      Effect.match({
        onFailure: (error) => appendLocalRequestRefusal(error, runId),
        onSuccess: () => {
          notifyFollowUpSent(runId, session);
          appendLocalAssistantTranscript(
            'Context compaction requested. The agent will process it on the next model call.',
            runId,
          );
        },
      }),
    ),
  );
}
