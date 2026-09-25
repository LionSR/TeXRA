import { Effect } from 'effect';

import { type SessionHandle } from '@agent/runtime';
import { notifyFollowUpSent } from '@agent/followUp';
import { defaultShortcutModifierLabel } from '@cli/runtime/shortcutLabels';
import { formatCliSessionStatus } from '@cli/chat/tui/sessionStatus';
import {
  selectedRunId as selectedRunIdSignal,
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
import { readProspectiveUsageRoute } from '@model/computeModelOptions';
import { AgentCategory, type RunId } from '@shared/schemas';

import { formatSlashCommandHelp } from '../helpText';
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

/** Open the focused run's work plan from the view it is rendered from. */
export function showCliWorkPlan(session: SessionHandle): void {
  const runId = selectedRunIdSignal.get();
  if (!runId) {
    cancelPendingWorkPlanReaderRequest();
    setTransientNotice('No focused session.');
    return;
  }
  clearTransientNotice();
  const request = beginWorkPlanReaderRequest(runId);
  const run = session.runView(runId);
  if (
    run?.category === AgentCategory.ToolUse &&
    (run.plan !== null || run.todos.length > 0)
  ) {
    finishWorkPlanReaderRequest(request);
  } else if (cancelWorkPlanReaderRequest(request)) {
    setTransientNotice('The focused session has no work plan.');
  }
}

/** The skills the run's newest `skills.snapshot` row names. Read from the
 *  run's committed rows: the snapshot is no listing row, so the view holds it
 *  only for a run whose transcript tier some port subscribes. */
function activeSkillNamesFor(session: SessionHandle, runId: RunId | undefined) {
  if (runId === undefined) return Effect.succeed([]);
  return session.transcripts
    .readEvents(runId)
    .pipe(
      Effect.map(
        (events) =>
          events
            .findLast((event) => event.type === 'skills.snapshot')
            ?.skills.map((skill) => skill.name) ?? [],
      ),
    );
}

export const showCliSessionStatus = Effect.fn('showCliSessionStatus')(
  function* (context: SlashCommandContext) {
    const meta = sessionMeta.get();
    const view = currentView();
    const activeRunId = selectedRunIdSignal.get();
    const run = runViewOf(view, activeRunId);
    // The children a status line counts: the active run's, else its
    // parent's (a focused leaf reports its siblings' activity).
    const countedParent =
      run && run.childIds.length === 0 && run.parentId
        ? runViewOf(view, run.parentId)
        : run;
    const activeChildSessions = runningChildCount(view, countedParent);
    const model = run?.model ?? (meta.model || context.initialModel);
    const activeSkills = yield* activeSkillNamesFor(
      context.runtimeSession,
      activeRunId,
    );
    const prospectiveRoute = yield* readProspectiveUsageRoute(
      { ...context.stores, secrets: context.secrets },
      model,
    );
    appendLocalAssistantTranscript(
      formatCliSessionStatus({
        agent: meta.agent || context.initialAgent,
        model,
        teamName: meta.teamName,
        // A completed request's route cannot change, so it outranks the
        // prospective one.
        modelAccess: run?.usage.usageRoute ?? prospectiveRoute,
        approvalBypasses:
          activeRunId === undefined
            ? undefined
            : view.policy.get(activeRunId)?.bypasses,
        statusLabel: run?.statusLabel,
        activeChildSessions,
        goal:
          run?.category === AgentCategory.ToolUse && run.goal.active
            ? run.goal
            : undefined,
        activeSkills,
        sessionId: run ? context.session.runId : undefined,
        commandName: context.cliContext.commandName,
        cwd: context.cliContext.cwd,
        processCwd: context.processCwd,
        approvalPolicy: context.getApprovalPolicy(),
        queuedFollowUpMessages: (activeRunId === undefined
          ? []
          : (view.queuedFollowUps.get(activeRunId) ?? [])
        ).map((followUp) => followUp.text),
      }),
    );
  },
);

/** `/compact`: one runtime request on the chat's session; the outcome or
 *  refusal becomes a notice. */
export function requestCliSessionCompaction(
  session: SessionHandle,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    const runId = selectedRunIdSignal.get();
    if (runId === undefined) {
      appendLocalAssistantTranscript(
        'No active tool-use session found for context compaction.',
      );
      return Effect.void;
    }
    return session.requests.request({ kind: 'run.compact', runId }).pipe(
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
    );
  });
}
