/** One step's tool resolution, as a run's step does it, for suites that
 *  check what a run is offered without running a loop. */
import { Effect } from 'effect';

import {
  declaredToolNames,
  resolveStepTools,
  type StepToolInputs,
} from '@agent/runtime/agentToolResolution';
import { LiveTools } from '@tools/liveTools';
import { switchedOffPlugins } from '@tools/plugins';
import { getDisabledToolIds } from '@utils/config/constants';

/**
 * Hold the loaded plugins the declarations name, apply the switches
 * `stores` holds and pin the generation that produces, all for the
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
  const held = yield* live.hold(declaredToolNames(input.tools));
  const pinned = yield* live.pinSwitched(
    Effect.map(
      getDisabledToolIds(input.stores.globalState),
      switchedOffPlugins,
    ),
  );
  const resolved = yield* resolveStepTools(pinned.generation, {
    runTools: [],
    approvalPromptsUnavailable: false,
    ...input,
    held,
  });
  return { ...resolved, held, generation: pinned.generation };
});
