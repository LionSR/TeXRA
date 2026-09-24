import { Cause, Effect } from 'effect';

import type { AgentRosterStores } from '@agent/index';
import {
  checkCliAgentLaunch,
  resolveCliAgentInCategory,
} from '@cli/runtime/agents';
import { CliUsageError } from '@cli/runtime/cliContext';
import { setCliHelperModel } from '@cli/runtime/initPlatform';
import {
  formatCliNoAvailableModelsRecovery,
  selectCliRunnableModel,
} from '@cli/runtime/modelAccess';

import {
  patchSessionMeta,
  setTransientNotice,
  setCliSessionModelOverride,
} from '@cli/chat/tui/state/cliState';
import { chatTuiCanStartRootRun } from '@cli/chat/tui/state/sessionRunState';
import { appendLocalAssistantTranscript } from '@cli/chat/tui/state/transcript';
import { AgentCategory } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';
import {
  CHAT_API_MODE_MODEL_RECOVERY,
  type SlashCommandContext,
} from './slashContext';

/** Resolve the chat root agent once: the entry the run pins, or the refusal. */
export function resolveChatToolUseAgent(
  stores: AgentRosterStores,
  agentName: string,
) {
  return Effect.gen(function* () {
    return yield* checkCliAgentLaunch(
      stores,
      agentName,
      yield* resolveCliAgentInCategory(
        stores,
        agentName,
        AgentCategory.ToolUse,
      ),
      'chat',
    );
  });
}

export function applyInitialCliAgentSelection(
  agentName: string,
  context: SlashCommandContext,
) {
  return Effect.gen(function* () {
    const fixedAgentNotice =
      'The agent is fixed for this chat session. Start a new chat to use a different agent.';
    if (!chatTuiCanStartRootRun(context.session)) {
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
    if (!chatTuiCanStartRootRun(context.session)) {
      setTransientNotice(fixedAgentNotice);
      return;
    }
    patchSessionMeta({
      agent: nextAgent,
      agentSource: entry.source,
      teamName: undefined,
      cliMultiAgentPresetId: undefined,
      delegationAgentScope: undefined,
    });
    appendLocalAssistantTranscript(`Root agent set to ${nextAgent}.`);
  });
}

export const applyCliModelSelection = Effect.fn('applyCliModelSelection')(
  function* (model: string, context: SlashCommandContext) {
    const nextModel = model.trim();
    if (chatTuiCanStartRootRun(context.session)) {
      const selection = yield* selectCliRunnableModel(nextModel, {
        stores: {
          ...context.stores,
          secrets: context.secrets,
          runtime: context.runtime,
        },
        fallbackReason: 'explicit-override',
        noAvailableModelsMessage: formatCliNoAvailableModelsRecovery(
          CHAT_API_MODE_MODEL_RECOVERY,
        ),
      });
      yield* setCliHelperModel(context.stores.globalState, selection.model);
      setCliSessionModelOverride(selection.model);
      appendLocalAssistantTranscript(`Root model set to ${selection.model}.`);
      return;
    }

    if (!context.canSelectModel()) {
      appendLocalAssistantTranscript(
        'Finish the active response before switching models.',
      );
      return;
    }

    const activeFlow = context.session.runId
      ? context.runtimeSession.runs.getToolUseFlowContext(context.session.runId)
      : undefined;
    if (!activeFlow) {
      appendLocalAssistantTranscript(
        'Model switching is only available for an active tool-use chat. Start a new chat with texra chat --model=<name> to choose a different root model.',
      );
      return;
    }

    yield* activeFlow.switchModel(nextModel);
    setCliSessionModelOverride(nextModel);
    // The switch already reached the live run; only the persisted default is
    // at stake here, so a write failure is reported beside the switch rather
    // than failing the command.
    yield* setCliHelperModel(context.stores.globalState, nextModel).pipe(
      Effect.matchCause({
        onSuccess: () =>
          appendLocalAssistantTranscript(
            `Model switched to ${nextModel}. Future turns will use it.`,
          ),
        onFailure: (cause) =>
          appendLocalAssistantTranscript(
            `Model switched to ${nextModel}. Could not persist it as the default helper model: ${toErrorMessage(Cause.squash(cause))}`,
          ),
      }),
    );
  },
);
