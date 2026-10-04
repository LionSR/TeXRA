import { Effect, Result, Stream, SubscriptionRef } from 'effect';

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
import type { SessionBackend } from '@controllers/session/sessionBackend';
import { readProspectiveUsageRoute } from '@model/computeModelOptions';
import { goalStateOf } from '@shared/plugins/goal';
import { isLiveRun } from '@shared/session/sessionView';
import { AgentCategory, type RunId } from '@shared/schemas';
import { interruptedTasks } from '@ui/copy/interruptedTasks';
import { TASK_ACTIONS } from '@ui/copy/nestedRuns';
import { formatResultCount } from '@utils/text/stringUtils';

import { formatSlashCommandHelp } from '../helpText';
import {
  listSlashCommands,
  type SlashCommandContribution,
} from '../slashRegistry';
import {
  type SlashCommandContext,
  type SlashCommandEffect,
} from './slashContext';

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
  if (run?.category === AgentCategory.ToolUse && run.plan !== null) {
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
  backend: SessionBackend,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    const runId = selectedRunIdSignal.get();
    if (runId === undefined) {
      setTransientNotice('No agent to compact.');
      return Effect.void;
    }
    return backend.request({ kind: 'run.compact', runId }).pipe(
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

/**
 * `/resume all`: the open-time notice's bulk answer. Each interrupted task
 * resumes on the session beside this chat, as `texra.resumeOnOpen: auto`
 * resumes them, and joins the agent list (Tab); one a resume finds blocked
 * continues once what it needs is back.
 */
export function resumeInterruptedTasks(
  backend: SessionBackend,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    const tasks = interruptedTasks(currentView());
    if (tasks.length === 0) {
      setTransientNotice('No interrupted tasks to resume.');
      return Effect.void;
    }
    appendLocalNotice(
      `Resuming ${formatResultCount(tasks.length, 'task')}: ${tasks
        .map((task) => task.title)
        .join(', ')}. Tab lists them.`,
    );
    return Effect.forEach(
      tasks,
      // A refusal is the task's own line; the rest still resume.
      (task) =>
        backend
          .resume(task.runId)
          .pipe(
            Effect.ignore({ log: 'Warn', message: `Resuming ${task.runId}` }),
          ),
      { concurrency: 'unbounded', discard: true },
    ).pipe(Effect.forkDetach, Effect.asVoid);
  });
}

/** `/rename <title>`: the focused task's own title, which a later model
 *  title does not replace. */
function renameCliTask(
  backend: SessionBackend,
  title: string,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    const runId = selectedRunIdSignal.get();
    if (runId === undefined) {
      setTransientNotice('No task to rename.');
      return Effect.void;
    }
    if (title.trim() === '') {
      setTransientNotice('Usage: /rename <title>');
      return Effect.void;
    }
    return backend
      .request({ kind: 'run.rename', runId, title: title.trim() })
      .pipe(
        Effect.match({
          onFailure: (error) => appendLocalRequestRefusal(error, runId),
          onSuccess: () => setTransientNotice(`Renamed to ${title.trim()}.`),
        }),
      );
  });
}

/**
 * `/fork`: a new task holding the focused conversation up to its latest
 * settled point, which this chat then continues; the original keeps its
 * history and stays in `/resume`. Its transcript starts empty, so a line
 * says where it came from.
 */
function forkCliTask(context: SlashCommandContext): SlashCommandEffect {
  return Effect.gen(function* () {
    const runId = selectedRunIdSignal.get() ?? context.session.runId;
    if (runId === undefined) {
      setTransientNotice('No conversation to fork yet.');
      return;
    }
    const source = runViewOf(currentView(), runId);
    // Cut before this chat lets go of the source, so the fork reads it as
    // it stands now.
    const forked = yield* Effect.result(
      context.backend.request({ kind: 'run.fork', runId }),
    );
    if (Result.isFailure(forked)) {
      appendLocalRequestRefusal(forked.failure, runId);
      return;
    }
    if (forked.success.kind !== 'forked')
      return yield* Effect.die(
        new Error(`run.fork answered ${forked.success.kind}`),
      );
    const fork = forked.success.runId;
    // The chat holds one task: the conversation it shows gives way to the
    // fork, as `/clear` gives way to a new task (refused mid-response). The
    // fork is taken up once the source has ended, so the source's end cannot
    // land on the chat's new task.
    if (!context.resetSession()) {
      appendLocalNotice(
        'The fork is ready in /resume; it opens there once this response is done.',
        runId,
      );
      return;
    }
    const ended = yield* SubscriptionRef.changes(context.backend.view).pipe(
      Stream.takeUntil((view) => {
        const run = view.runs.get(runId);
        return run === undefined || !isLiveRun(run);
      }),
      Stream.runDrain,
      Effect.timeout('10 seconds'),
      Effect.result,
    );
    if (Result.isFailure(ended)) {
      appendLocalNotice(
        'The fork is ready in /resume; the task it came from has not finished stopping.',
      );
      return;
    }
    yield* context.resumeRun(fork);
    const title = source ? source.description || source.label : runId;
    appendLocalNotice(
      `${TASK_ACTIONS.forkedFrom(title)}. The model holds that conversation; the original is in /resume.`,
      fork,
    );
  });
}

/** `/handoff <text>` and `/reset`: the focused task continues in a fresh
 *  context, from the text, or from the next message. */
function resetCliTask(
  backend: SessionBackend,
  handoff: string | null,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    const runId = selectedRunIdSignal.get();
    if (runId === undefined) {
      setTransientNotice('No task to hand off.');
      return Effect.void;
    }
    return backend.request({ kind: 'run.reset', runId, handoff }).pipe(
      Effect.match({
        onFailure: (error) => appendLocalRequestRefusal(error, runId),
        onSuccess: () =>
          appendLocalNotice(
            handoff === null
              ? 'Reset: the model no longer sees the conversation before this point and answers your next message from it alone.'
              : 'Handed off: the model no longer sees the conversation before this point and continues from your text.',
            runId,
          ),
      }),
    );
  });
}

/** The task commands: compacting the focused agent's context, and leaving.
 *  The agent list (Tab) lists and focuses the task's agents; typing to a
 *  focused agent messages it. */
export function sessionContributions(
  backend: SessionBackend,
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
          handler: () => requestCliSessionCompaction(backend),
        },
        {
          name: 'fork',
          description:
            'Continue a new task holding this conversation; the original stays as it is',
          category: 'session',
          echo: 'ifPersists',
          handler: (_remainder, context) => forkCliTask(context),
        },
        {
          name: 'handoff',
          description:
            'Continue in a fresh context that starts from your text: /handoff <text>',
          category: 'session',
          echo: 'ifPersists',
          handler: (remainder) => {
            const text = remainder.trim();
            if (text !== '') return resetCliTask(backend, text);
            setTransientNotice(
              'Usage: /handoff <text the task continues from>',
            );
            return Effect.void;
          },
        },
        {
          name: 'reset',
          description:
            'Clear what the model sees of this task; it answers your next message alone',
          category: 'session',
          echo: 'ifPersists',
          handler: () => resetCliTask(backend, null),
        },
        {
          name: 'rename',
          description: 'Give the focused task a title of your own',
          category: 'session',
          echo: 'ifPersists',
          handler: (remainder) => renameCliTask(backend, remainder),
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
