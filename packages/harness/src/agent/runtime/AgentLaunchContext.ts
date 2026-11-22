/**
 * What a launch checks before its run exists: the tools its configuration
 * declares against this build, and its model. A miss is refused here, so no
 * run is registered for a launch that cannot run: an unknown model is a
 * `LaunchRefused` with the notice its caller shows. The run program takes
 * the result (`executeAgent`).
 */
import { Effect } from 'effect';

import { selectModel } from '@texra-ai/llm';
import { AgentError, LaunchRefused } from '@common/errors/agentErrors';
import { HARNESS_INSTRUCTION_KEY, type AgentConfig } from '@shared/schemas';
import { mcpServerOfToolName } from '@shared/tools/toolDisplayName';
import { ToolRegistry } from '@tools/toolTable';

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
 * Check what a launch runs: its declared tools against this build's table,
 * and its model, each refused before any run is registered.
 */
export const prepareAgentDefinition = Effect.fn('prepareAgentDefinition')(
  function* (input: { config: AgentConfig }) {
    const { config } = input;
    // A declared tool nothing could serve is a configuration error: the run
    // is refused (a plugin switched off withholds its tools at the step).
    const table = yield* ToolRegistry;
    const unknown = config.tools.filter(
      (name) => !table.get(name) && mcpServerOfToolName(name) === undefined,
    );
    if (unknown.length > 0)
      return yield* new AgentError({
        message: `Run '${config.label}' declares ${unknown.length === 1 ? 'a tool' : 'tools'} this build does not have: ${unknown.join(', ')}.`,
      });

    // Validated before registration, so a typo'd model name registers no
    // FAILED execution, and its caller shows only the instruction it carries.
    const modelConfig = yield* validateModelExists(config.model);
    return { config, modelConfig };
  },
);

/** What {@link prepareAgentDefinition} checked: the run program's input. */
export type PreparedAgentDefinition = Effect.Success<
  ReturnType<typeof prepareAgentDefinition>
>;
