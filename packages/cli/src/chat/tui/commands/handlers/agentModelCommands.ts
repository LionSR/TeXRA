import { Effect, Predicate } from 'effect';

import { agentName as bareAgentName } from '@texra-ai/harness/schemas';
import { resolveCliRunAgent } from '@cli/runtime/agents';
import { CliUsageError } from '@cli/runtime/platform/cliContext';
import { readCliTeam } from '@cli/runtime/cliTeams';

import {
  patchSessionMeta,
  rootRunId,
  setTransientNotice,
  setCliSessionModelOverride,
} from '@cli/chat/tui/state/cliState';
import {
  appendLocalNotice,
  appendLocalRequestRefusal,
} from '@cli/chat/tui/state/transcript';
import { resolveTeamLaunch } from '@texra/agent/teams/teamLaunch';
import { createTeamCatalogPorts } from '@texra/controllers/mainView/teamCatalogPorts';
import { selectChatModel, type SlashCommandContext } from './slashContext';
import type { WorkspaceAgentsStores } from '@texra-ai/harness/host';

/** Resolve the chat root agent once: the entry the run pins, or the refusal. */
export function resolveChatToolUseAgent(
  stores: WorkspaceAgentsStores,
  agentName: string,
) {
  return resolveCliRunAgent(stores, agentName).pipe(
    Effect.catchIf(
      (error): error is CliUsageError => error instanceof CliUsageError,
      (refusal) => Effect.succeed(refusal),
    ),
  );
}

export const applyInitialCliAgentSelection = Effect.fn(
  'applyInitialCliAgentSelection',
)(function* (agentName: string, context: SlashCommandContext) {
  const fixedAgentNotice =
    'The agent is fixed for this task. Start a new task to use a different agent.';
  if (!context.session.canStartRootRun()) {
    setTransientNotice(fixedAgentNotice);
    return;
  }

  const nextAgent = agentName.trim();
  const entry = yield* resolveChatToolUseAgent(context.stores, nextAgent);
  if (entry instanceof CliUsageError) {
    setTransientNotice(entry.message);
    return;
  }
  // State validation can yield while another input claims the root run.
  if (!context.session.canStartRootRun()) {
    setTransientNotice(fixedAgentNotice);
    return;
  }
  patchSessionMeta({
    agent: nextAgent,
    agentSource: entry.source,
    team: undefined,
    delegationAgentScope: undefined,
  });
  appendLocalNotice(`Root agent set to ${nextAgent}.`);
});

/**
 * `/agent` → a team: the same launch resolution the extension and desktop
 * launchers use, so a team started here pins the same root agent and
 * delegation scope as one started there. The picker row already names any
 * unavailable members, so choosing it means continuing without them.
 */
export const applyCliTeamSelection = Effect.fn('applyCliTeamSelection')(
  function* (teamId: string, context: SlashCommandContext) {
    const fixedTeamNotice =
      'The agent is fixed for this task. Start a new task to use a team.';
    if (!context.session.canStartRootRun()) {
      setTransientNotice(fixedTeamNotice);
      return;
    }
    const resolution = resolveTeamLaunch({
      teamId,
      ...(yield* createTeamCatalogPorts(context.runSession.roots.repoState)),
    });
    if (resolution.status === 'refused') {
      setTransientNotice(resolution.message);
      return;
    }
    const { fields } = resolution;
    const entry = yield* resolveChatToolUseAgent(context.stores, fields.agent);
    if (entry instanceof CliUsageError) {
      setTransientNotice(entry.message);
      return;
    }
    // Validation yields; another input may have claimed the root run.
    if (!context.session.canStartRootRun()) {
      setTransientNotice(fixedTeamNotice);
      return;
    }
    const team = yield* readCliTeam(
      context.runSession.roots.repoState,
      fields.launch.teamId,
    );
    patchSessionMeta({
      agent: fields.agent,
      agentSource: entry.source,
      team,
      delegationAgentScope: fields.delegationAgentScope,
    });
    appendLocalNotice(
      [
        `Team set to ${team?.name ?? teamId}; ${bareAgentName(fields.agent)} leads it.`,
        resolution.missingNames.length > 0
          ? `Unavailable members: ${resolution.missingNames.join(', ')}.`
          : undefined,
      ]
        .filter(Predicate.isNotUndefined)
        .join(' '),
    );
  },
);

export const applyCliModelSelection = Effect.fn('applyCliModelSelection')(
  function* (model: string, context: SlashCommandContext) {
    const nextModel = model.trim();
    if (context.session.canStartRootRun()) {
      const selection = yield* selectChatModel(context.stores, {
        model: nextModel,
        reason: 'explicit-override',
      });
      setCliSessionModelOverride(selection.model);
      appendLocalNotice(`Root model set to ${selection.model}.`);
      return;
    }

    if (!context.session.canSelectModel()) {
      setTransientNotice('Finish the active response before switching models.');
      return;
    }

    const runId = rootRunId.get();
    if (runId === undefined) {
      setTransientNotice(
        'Model switching is only available for an active tool-use chat. Start a new chat with texra chat --model=<name> to choose a different root model.',
      );
      return;
    }

    const switched = yield* context.runSession
      .request({ kind: 'run.model', runId, model: nextModel })
      .pipe(
        Effect.match({
          onFailure: (error) => {
            appendLocalRequestRefusal(error, runId);
            return false;
          },
          onSuccess: () => true,
        }),
      );
    if (!switched) return;
    setCliSessionModelOverride(nextModel);
    appendLocalNotice(
      `Model switched to ${nextModel}. Future turns will use it.`,
    );
  },
);
