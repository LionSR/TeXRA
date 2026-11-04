/**
 * The definition a launch resolves before its run exists: the agent (a
 * persona the config carries, or a catalog entry, with its plugin's trust
 * checked), the tools it declares against this build, and its model. A
 * miss is refused here, so no run is registered for a launch that cannot
 * run; an unknown agent or model carries the notice its caller shows
 * (`AgentError.notice`). The run program takes the result (`executeAgent`).
 */
import { Deferred, Effect } from 'effect';

import { selectModel } from '@texra-ai/llm';
import { AgentCatalog } from '@agent/index/agentCatalog';
import { agentEntryOf } from '@agent/index/agentYamlScanner';
import { requirePluginAgentLoads } from '@agent/index/pluginAgents';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { AgentError } from '@common/errors/agentErrors';
import { readInstalledPluginLoad } from '@common/plugins/pluginTrust';
import { SessionRoots } from '@platform/rootedFs';
import { HARNESS_INSTRUCTION_KEY, type CommitOrdinal } from '@shared/schemas';
import { mcpServerOfToolName } from '@shared/tools/toolDisplayName';
import { ToolRegistry } from '@tools/toolTable';

import { declaredToolNames } from './agentToolResolution';

const validateModelExists = Effect.fn('AgentLaunchContext.validateModelExists')(
  function* (modelName: string) {
    const selected = selectModel(modelName);
    if (selected) return selected.config;

    // One wording, so a surface that shows only text says what the notice
    // says.
    const message = `Model "${modelName}" is not recognized. Review the documentation for supported models.`;
    return yield* new AgentError({
      message,
      notice: {
        event: 'requestShowInstruction',
        payload: {
          key: HARNESS_INSTRUCTION_KEY.MODEL_NOT_RECOGNIZED,
          message,
          showSuppress: false,
        },
      },
    });
  },
);

/** The commit `opened` holds, once a launch's or resume's program is over:
 *  with none, its run's activation never committed and nothing entered the
 *  session. What a launch that waits for its run's opening answers with
 *  when the program ends first (`rootRun`, `launchDetachedSubagent`). */
export const activationIfOpened = (
  opened: Deferred.Deferred<CommitOrdinal>,
): Effect.Effect<CommitOrdinal, Error> =>
  Effect.suspend(() =>
    Deferred.isDoneUnsafe(opened)
      ? Deferred.await(opened)
      : Effect.fail(new Error('The run ended without entering the session.')),
  );

/**
 * Resolve what a launch runs: the agent entry (an inline persona, or the
 * catalog's over this session's roots), its declared tools against this
 * build's table, and its model, each refused before any run is registered.
 * `stopAfterCycle` is decided once: a launch that ends the run after one
 * cycle, or a script that is its only turn.
 */
export const prepareAgentDefinition = Effect.fn('prepareAgentDefinition')(
  function* (input: {
    config: AgentConfig;
    /** The launch ends the run after one cycle (an awaited child). */
    stopAfterCycle?: boolean;
  }) {
    const fullConfig = input.config;
    const roots = yield* SessionRoots;
    // A persona the config carries (its schema admitted it) is the agent;
    // a named one resolves over a settled catalog, and a miss says why.
    const agentEntry =
      fullConfig.persona != null
        ? agentEntryOf(fullConfig.persona, { source: 'inline', path: '' })
        : yield* (yield* AgentCatalog)
            .forLaunch(roots, fullConfig.agent, fullConfig.agentSource)
            .pipe(
              Effect.catchTag('AgentNotFound', (missed) =>
                Effect.fail(
                  new AgentError({
                    message: missed.message,
                    notice: {
                      event: 'agentNotFound',
                      payload: { agentName: fullConfig.agent },
                    },
                  }),
                ),
              ),
            );
    if (agentEntry.source === 'plugin')
      yield* requirePluginAgentLoads(
        agentEntry,
        yield* readInstalledPluginLoad(roots),
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
    // FAILED execution, and its caller shows only the instruction it carries.
    const modelConfig = yield* validateModelExists(fullConfig.model);

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
