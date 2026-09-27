/** One step's tool resolution, as a run's step does it, for suites that
 *  check what a run is offered without running a loop. */
import { Effect } from 'effect';

import {
  resolveStepTools,
  type StepToolInputs,
} from '@agent/runtime/agentToolResolution';
import { LiveTools } from '@tools/liveTools';
import { switchedOffPlugins } from '@tools/plugins';
import { getDisabledToolIds } from '@utils/config/constants';

/**
 * Apply the switches `stores` holds, hold the loaded plugins the
 * declarations name and pin the catalog's current generation, all for the
 * caller's scope, then resolve what a step would offer from it.
 */
export const resolveTestStep = Effect.fn('resolveTestStep')(function* (
  input: Omit<
    StepToolInputs,
    'held' | 'runTools' | 'approvalPromptsUnavailable'
  > &
    Partial<Pick<StepToolInputs, 'runTools' | 'approvalPromptsUnavailable'>>,
) {
  const live = yield* LiveTools;
  yield* live.sync(
    switchedOffPlugins(yield* getDisabledToolIds(input.stores.globalState)),
  );
  const held = yield* live.hold(
    (Array.isArray(input.tools) ? input.tools : []).map((tool) =>
      typeof tool === 'string' ? tool : tool.name,
    ),
  );
  const pinned = yield* live.registry.pin;
  const resolved = yield* resolveStepTools(pinned.generation, {
    runTools: [],
    approvalPromptsUnavailable: false,
    ...input,
    held,
  });
  return { ...resolved, held, generation: pinned.generation };
});
