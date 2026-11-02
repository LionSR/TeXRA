// Third-party imports

import { Effect, Schema } from 'effect';

// Local imports
import { AgentConfigSchema, type RunId } from '@texra-ai/harness/schemas';
import type { RunLaunch } from '@agent/runtime/run/AgentRun';
import { PersonaSchema } from '@shared/schemas';
import { noopTrace } from '@test/support/noopTrace';

interface TestLaunchContextInit {
  runId: RunId;
  agent?: string;
  /** Trace the run publishes through; defaults to the silent trace. */
  logger?: RunLaunch['logger'];
}

/**
 * A minimal conversation `RunLaunch` for driving the run's terminal
 * (`endRun`) without a real model handler or flow.
 */
export function createTestLaunchContext({
  runId,
  agent = 'assistant',
  logger = noopTrace,
}: TestLaunchContextInit): RunLaunch {
  const config = Schema.decodeUnknownSync(AgentConfigSchema)({
    agent,
    model: 'test-model',
  });

  return {
    config,
    persona: Schema.decodeUnknownSync(PersonaSchema)({}),
    runId,
    logger,
    parentStage: logger.openStage(`Run: ${config.agent}`),
    opening: {
      inputs: {},
      activated: [],
      attachedMemories: null,
      attachedMemoryMisses: [],
    },
    entry: {
      parent: null,
      registration: null,
      opening: Effect.succeed([]),
      entered: () => Effect.void,
      initialUserMessage: undefined,
    },
    toolPolicy: {},
  };
}
