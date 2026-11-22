/**
 * The definition a launch resolves before its run exists: the agent (a
 * persona the config carries, or a catalog entry, with its plugin's trust
 * checked), the tools it declares against this build, and its model. A
 * miss is refused here, so no run is registered for a launch that cannot
 * run: an agent this process cannot run is `AgentUnavailable` (a launch
 * reports it as its refusal, a resume refuses with it), and an unknown model
 * is a `LaunchRefused` with the notice its caller shows. The run program takes the result (`executeAgent`).
 */
import { Effect, Schema } from 'effect';

import { selectModel } from '@texra-ai/llm';
import { AgentCatalog } from '@agent/index/agentCatalog';
import { requirePluginLoads } from '@agent/index/pluginAgents';
import {
  AgentError,
  AgentUnavailable,
  LaunchRefused,
} from '@common/errors/agentErrors';
import { SessionRoots } from '@platform/rootedFs';
import {
  AGENT_SOURCE,
  agentName,
  HARNESS_INSTRUCTION_KEY,
  PersonaSchema,
  type AgentConfig,
} from '@shared/schemas';
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
    return yield* new LaunchRefused({
      message,
      notice: {
        event: 'requestShowInstruction',
        payload: {
          key: HARNESS_INSTRUCTION_KEY.MODEL_NOT_RECOGNIZED,
          message,
        },
      },
    });
  },
);

/**
 * Resolve what a launch runs: the agent entry (an inline persona, or the
 * catalog's over this session's roots), its declared tools against this
 * build's table, and its model, each refused before any run is registered.
 */
export const prepareAgentDefinition = Effect.fn('prepareAgentDefinition')(
  function* (input: { config: AgentConfig }) {
    const fullConfig = input.config;
    const { agentSource } = fullConfig;
    const roots = yield* SessionRoots;
    // A persona the config carries (its schema accepted it) is the agent,
    // with its defaults applied as a file's are; a named one resolves over
    // a finished catalog, which stamps the entry's source, and a miss says
    // why: a plugin agent's by its plugin's install record (a launch may
    // record the source-qualified spelling, `plugin:acme:x`).
    const agent =
      agentSource?.kind === AGENT_SOURCE.INLINE
        ? {
            name: fullConfig.agent,
            path: '',
            description: agentSource.persona.description,
            persona: Schema.decodeUnknownSync(PersonaSchema)(
              agentSource.persona,
            ),
            agentSource,
          }
        : yield* (yield* AgentCatalog)
            .forLaunch(fullConfig.agent, agentSource?.kind)
            .pipe(
              Effect.map((entry) => ({
                ...entry,
                agentSource: { kind: entry.source },
              })),
              Effect.catchTag('AgentNotFound', (miss) =>
                Effect.gen(function* () {
                  if (agentSource?.kind === AGENT_SOURCE.PLUGIN)
                    yield* requirePluginLoads(
                      agentName(fullConfig.agent),
                      roots,
                    );
                  return yield* new AgentUnavailable({
                    blocked: {
                      kind: 'blocked',
                      blocker: 'agentMissing',
                      name: miss.agent,
                    },
                    message: miss.message,
                  });
                }),
              ),
            );
    if (agent.agentSource.kind === AGENT_SOURCE.PLUGIN)
      yield* requirePluginLoads(agent.name, roots);
    const { persona } = agent;

    // A declared tool nothing could serve is a configuration error: the run
    // is refused (a plugin switched off withholds its tools at the step).
    const table = yield* ToolRegistry;
    const unknown = declaredToolNames(persona.tools).filter(
      (name) => !table.get(name) && mcpServerOfToolName(name) === undefined,
    );
    if (unknown.length > 0)
      return yield* new AgentError({
        message: `Agent '${agent.name}' declares ${unknown.length === 1 ? 'a tool' : 'tools'} this build does not have: ${unknown.join(', ')}. Edit ${agent.path || 'the persona'} to remove or rename ${unknown.length === 1 ? 'it' : 'them'}; \`delegate_agent\` and \`delegate_workflow\` are now \`agent\`, and \`delegate_multi_agents\` is \`script\` with \`agent\`.`,
      });

    // Validated before registration, so a typo'd model name registers no
    // FAILED execution, and its caller shows only the instruction it carries.
    const modelConfig = yield* validateModelExists(fullConfig.model);

    // The resolved source is stamped (`agent` stays as spelled); a program's
    // outputs are its registration's, stamped by its launch (`programLaunch`).
    const config: AgentConfig = {
      ...fullConfig,
      agentSource: agent.agentSource,
    };
    return { config, persona, description: agent.description, modelConfig };
  },
);

/** What {@link prepareAgentDefinition} resolved: the run program's input. */
export type PreparedAgentDefinition = Effect.Success<
  ReturnType<typeof prepareAgentDefinition>
>;
