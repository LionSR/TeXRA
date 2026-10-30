/**
 * The definition a launch resolves before its run exists: the agent (a
 * persona the config carries, or a catalog entry, with its plugin's trust
 * checked), the tools it declares against this build, and its model. A
 * miss is refused here with its targeted host notice, so no run is
 * registered for a launch that cannot run. The run program takes the
 * result (`executeAgent`).
 */
import { Effect } from 'effect';

import { selectModel } from '@texra-ai/llm';
import { AgentCatalog } from '@agent/index/agentCatalog';
import { agentEntryOf } from '@agent/index/agentYamlScanner';
import { requirePluginAgentLoads } from '@agent/index/pluginAgents';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { AgentError } from '@common/errors/agentErrors';
import { readInstalledPluginLoad } from '@common/plugins/pluginTrust';
import { attachErrorPresentationClaimed } from '@common/errors/sdkError/errorMetadata';
import { INSTRUCTION_ACTION } from '@shared/schemas';
import { mcpServerOfToolName } from '@shared/tools/toolDisplayName';
import { ToolRegistry } from '@tools/toolTable';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { declaredToolNames } from './agentToolResolution';
import type { SessionHandle } from './SessionHandle';
import type { SessionHostInteractions } from './HostInteractions';
import type {
  RuntimePresentationEvent,
  RuntimePresentationEventPayloads,
} from './runtimePresentationEvents';

/**
 * Present a launch error through its targeted host notice (replayed if no
 * host is attached) and fail with it claimed, so no generic toast repeats
 * it; a host that throws on the notice shows that toast instead.
 */
function presentLaunchError<K extends RuntimePresentationEvent>(
  interactions: Pick<SessionHostInteractions, 'emit'>,
  err: AgentError,
  event: K,
  payload: RuntimePresentationEventPayloads[K],
): Effect.Effect<never, AgentError> {
  return interactions
    .emit(event, payload, {
      replayWhenAttached: true,
      fallbackMessage: toErrorMessage(err),
    })
    .pipe(
      Effect.andThen(
        Effect.suspend(() => {
          attachErrorPresentationClaimed(err);
          return Effect.fail(err);
        }),
      ),
    );
}

const validateModelExists = Effect.fn('AgentLaunchContext.validateModelExists')(
  function* (
    modelName: string,
    interactions: Pick<SessionHostInteractions, 'emit'>,
  ) {
    const selected = selectModel(modelName);
    if (selected) return selected.config;

    return yield* presentLaunchError(
      interactions,
      new AgentError({ message: `Model ${modelName} is not registered` }),
      'requestShowInstruction',
      {
        key: 'modelNotRecognized',
        message: `Model "${modelName}" is not recognized. Review the documentation for supported models.`,
        actions: [INSTRUCTION_ACTION.OPEN_MODELS_DOC],
        showSuppress: false,
      },
    );
  },
);

/**
 * Resolve what a launch runs: the agent entry (an inline persona, or the
 * catalog's over this session's roots), its declared tools against this
 * build's table, and its model, each refused with a targeted notice before
 * any run is registered. `stopAfterCycle` is decided once: a launch that
 * ends the run after one cycle, or a script that is its only turn.
 */
export const prepareAgentDefinition = Effect.fn('prepareAgentDefinition')(
  function* (input: {
    config: AgentConfig;
    session: SessionHandle;
    /** The launch ends the run after one cycle (an awaited child). */
    stopAfterCycle?: boolean;
  }) {
    const fullConfig = input.config;
    const interactions = input.session.interactions;
    // A persona the config carries (its schema admitted it) is the agent;
    // a named one resolves over a settled catalog, and a miss says why.
    const agentEntry =
      fullConfig.persona != null
        ? agentEntryOf(fullConfig.persona, { source: 'inline', path: '' })
        : yield* (yield* AgentCatalog)
            .forLaunch(
              input.session.roots,
              fullConfig.agent,
              fullConfig.agentSource,
            )
            .pipe(
              Effect.catchTag('AgentNotFound', (missed) =>
                presentLaunchError(
                  interactions,
                  new AgentError({ message: missed.message }),
                  'showAgentConfigBanner',
                  { agentName: fullConfig.agent },
                ),
              ),
            );
    if (agentEntry.source === 'plugin')
      yield* requirePluginAgentLoads(
        agentEntry,
        yield* readInstalledPluginLoad(input.session.roots),
      );
    const { persona } = agentEntry;

    // A declared tool nothing could serve is a configuration error: the run
    // is refused (a plugin switched off withholds its tools at the step).
    const table = yield* ToolRegistry;
    const unknown = declaredToolNames(persona.tools).filter(
      (name) => !table.get(name) && mcpServerOfToolName(name) === undefined,
    );
    if (unknown.length > 0)
      return yield* new AgentError({
        message: `Agent '${agentEntry.name}' declares ${unknown.length === 1 ? 'a tool' : 'tools'} this build does not have: ${unknown.join(', ')}. Edit ${agentEntry.path || 'the persona'} to remove or rename ${unknown.length === 1 ? 'it' : 'them'}; \`delegate_agent\` and \`delegate_workflow\` are now \`agent\`, and \`delegate_multi_agents\` is \`script\` with \`agent\`.`,
      });

    // Validated before registration, so a typo'd model name registers no
    // FAILED execution and surfaces only its targeted instruction.
    const modelConfig = yield* validateModelExists(
      fullConfig.model,
      interactions,
    );

    // The resolved source is stamped (`agent` stays as spelled); a task's
    // outputs are its plugin's, stamped by the launch that built it.
    const config: AgentConfig = {
      ...fullConfig,
      agentSource: agentEntry.source,
    };
    // Whether the run takes follow-ups, decided once: a run whose launch
    // ends it after one cycle, or whose script is its only turn, does not,
    // and registers as such.
    const stopAfterCycle =
      input.stopAfterCycle === true || config.script != null;
    return { config, persona, agentEntry, modelConfig, stopAfterCycle };
  },
);

/** What {@link prepareAgentDefinition} resolved: the run program's input. */
export type PreparedAgentDefinition = Effect.Success<
  ReturnType<typeof prepareAgentDefinition>
>;
