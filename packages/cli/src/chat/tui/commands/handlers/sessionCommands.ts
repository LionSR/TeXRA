import { Effect } from 'effect';

import { type SessionHandle } from '@agent/runtime';
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
import { runRelation } from '@shared/session/runRelation';
import type { RunView } from '@shared/session/sessionView';

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
  return session
    .readRunEvents(runId)
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
function requestCliSessionCompaction(
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
          appendLocalAssistantTranscript(
            'Context compaction requested. The agent will process it on the next model call.',
            runId,
          );
        },
      }),
    );
  });
}

/** `/ps`: every run in this session, most recent first, marked with where
 *  it stands relative to the focused run and how many messages it has not
 *  read. Any of them can be messaged with `/send`. */
function showCliRunList(): void {
  const view = currentView();
  const focused = selectedRunIdSignal.get();
  const runs = [...view.runs.values()].toSorted(
    (left, right) => right.launchedAt - left.launchedAt,
  );
  if (runs.length === 0) {
    openInfoPane('/ps', 'No runs in this session.');
    return;
  }
  const parentOf = (id: RunId) => view.runs.get(id)?.parentId;
  const relationTo = (run: RunView): string => {
    if (focused === undefined) return '';
    if (run.id === focused) return '  (focused)';
    const relation = runRelation(run.id, focused, parentOf);
    return relation === 'peer' ? '' : `  (${relation} of focused)`;
  };
  const lines = runs.map((run) => {
    const unread = view.queuedFollowUps.get(run.id)?.length ?? 0;
    return `${run.id}  ${run.label}  [${run.statusLabel}]${relationTo(run)}${unread > 0 ? `  unread=${unread}` : ''}`;
  });
  openInfoPane(
    '/ps',
    [...lines, '', 'Message a run with /send <run id> <message>.'].join('\n'),
  );
}

/** `/send <run id> <message>`: type into another run's input, as its
 *  composer would. A unique id prefix names the run. */
function sendCliRunMessage(
  session: SessionHandle,
  remainder: string,
): Effect.Effect<void> {
  return Effect.suspend(() => {
    const [target = '', ...words] = remainder.trim().split(/\s+/);
    const text = words.join(' ');
    if (!target || !text) {
      appendLocalAssistantTranscript('Usage: /send <run id> <message>');
      return Effect.void;
    }
    const ids = [...currentView().runs.keys()];
    const matches = ids.includes(target as RunId)
      ? [target as RunId]
      : ids.filter((id) => id.startsWith(target));
    if (matches.length !== 1) {
      appendLocalAssistantTranscript(
        matches.length === 0
          ? `No run matches '${target}'. Use /ps to list runs.`
          : `'${target}' matches ${matches.length} runs (${matches.join(', ')}). Type more of the id.`,
      );
      return Effect.void;
    }
    const runId = matches[0]!;
    return session.requests
      .request({ kind: 'followUp.send', runId, text })
      .pipe(
        Effect.match({
          onFailure: (error) => appendLocalRequestRefusal(error, runId),
          onSuccess: () =>
            appendLocalAssistantTranscript(`Message sent to ${runId}.`),
        }),
      );
  });
}

/** The session commands that act on runs: looking at them and messaging
 *  them (`/ps`, `/send`), compacting the focused one, and leaving. */
export function sessionContributions(
  session: SessionHandle,
): SlashCommandContribution[] {
  return [
    {
      pluginId: 'run-messaging',
      commands: [
        {
          name: 'ps',
          description: 'List the runs in this session',
          category: 'session',
          echo: 'never',
          handler: () => Effect.sync(showCliRunList),
        },
        {
          name: 'send',
          description: 'Send a message to another run: /send <id> <text>',
          category: 'session',
          echo: 'ifPersists',
          handler: (remainder) => sendCliRunMessage(session, remainder),
        },
      ],
    },
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
          description: 'Exit the CLI session',
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
