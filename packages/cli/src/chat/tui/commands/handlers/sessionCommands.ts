import { Effect } from 'effect';

import type { SessionHandle } from '@agent/runtime';
import { defaultShortcutModifierLabel } from '@cli/runtime/shortcutLabels';
import {
  formatCliSessionStatus,
  taskCostStatus,
} from '@cli/chat/tui/sessionStatus';
import {
  selectedRunId as selectedRunIdSignal,
  clearTransientNotice,
  closeForegroundReader,
  openInfoPane,
  openWorkPlanReader,
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
  appendLocalNotice,
  appendLocalRequestRefusal,
} from '@cli/chat/tui/state/transcript';
import { readProspectiveUsageRoute } from '@model/computeModelOptions';
import { goalStateOf } from '@shared/plugins/goal';
import { AgentCategory, type RunId } from '@shared/schemas';

import { formatSlashCommandHelp } from '../helpText';
import {
  listSlashCommands,
  type SlashCommandContribution,
} from '../slashRegistry';
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
    setTransientNotice('No focused agent.');
    return;
  }
  clearTransientNotice();
  const run = session.runView(runId);
  if (
    run?.category === AgentCategory.ToolUse &&
    (run.plan !== null || run.todos.length > 0)
  ) {
    openWorkPlanReader(runId);
  } else {
    closeForegroundReader();
    setTransientNotice('The focused agent has no work plan.');
  }
}

/** The skills the run's latest step lists, read from its rows. */
const activeSkillNamesFor = Effect.fn('activeSkillNamesFor')(function* (
  session: SessionHandle,
  runId: RunId | undefined,
) {
  const state =
    runId === undefined ? null : yield* session.runHistory.load(runId);
  return state?.offeredSkills ?? [];
});

export const showCliSessionStatus = Effect.fn('showCliSessionStatus')(
  function* (context: SlashCommandContext) {
    const meta = sessionMeta.get();
    const view = currentView();
    const activeRunId = selectedRunIdSignal.get();
    const run = runViewOf(view, activeRunId);
    const goal = run === undefined ? undefined : goalStateOf(run);
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
    appendLocalNotice(
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
        goal: goal?.active ? goal : undefined,
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
        cost: taskCostStatus(view, run),
      }),
    );
  },
);

/** `/compact`: one runtime request on the chat's session; the outcome or
 *  refusal becomes a notice. */
function requestCliSessionCompaction(
  session: SessionHandle,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    const runId = selectedRunIdSignal.get();
    if (runId === undefined) {
      setTransientNotice('No agent to compact.');
      return Effect.void;
    }
    return session.requests.request({ kind: 'run.compact', runId }).pipe(
      Effect.match({
        onFailure: (error) => appendLocalRequestRefusal(error, runId),
        onSuccess: () => {
          appendLocalNotice(
            'Context compaction requested. The agent will process it on the next model call.',
            runId,
          );
        },
      }),
    );
  });
}

/** The task commands: compacting the focused agent's context, and leaving.
 *  The agent list (Tab) lists and focuses the task's agents; typing to a
 *  focused agent messages it. */
export function sessionContributions(
  session: SessionHandle,
): SlashCommandContribution[] {
  return [
    {
      pluginId: 'session-lifecycle',
      commands: [
        {
          name: 'compact',
          description: 'Request context compaction',
          category: 'session',
          echo: 'ifPersists',
          handler: () => requestCliSessionCompaction(session),
        },
        {
          name: 'exit',
          description: 'Exit texra',
          aliases: ['quit'],
          category: 'session',
          echo: 'never',
          handler: (_remainder, context) =>
            Effect.sync(() => {
              // Deliberately does NOT interrupt: the graceful teardown owns
              // that policy and skips the interrupt for a resumable-idle root,
              // so `/exit` agrees with Ctrl-C by construction instead of
              // pre-empting it.
              //
              // `stopRequested` stays and is the sole writer on this path. The
              // teardown awaits the follow-up queue's `idle` BEFORE setting the
              // flag itself, and the queued task polls this flag — dropping it
              // would hang `/exit` forever with a follow-up queued and no
              // stream id yet.
              context.session.stopRequested = true;
              context.requestInputExit();
            }),
        },
      ],
    },
  ];
}
