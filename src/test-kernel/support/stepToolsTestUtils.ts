/** One step's tool resolution, as a run's step does it, for suites that
 *  check what a run is offered without running a loop. */
import { Effect } from 'effect';

import {
  declaredToolNames,
  resolveStepTools,
  type StepToolInputs,
} from '@agent/runtime/agentToolResolution';
import { LiveTools } from '@tools/liveTools';
import { readDisabledTools } from '@tools/plugins';

import { unprobedToolAvailability } from './toolAvailabilityTestLayer';

/**
 * Hold the loaded plugins the declarations name, apply the switches
 * `stores` holds and pin the generation that produces, all for the
 * caller's scope, then resolve what a step would offer from it.
 */
export const resolveTestStep = Effect.fn('resolveTestStep')(function* (
  input: Omit<
    StepToolInputs,
    'held' | 'runTools' | 'approvalPromptsUnavailable' | 'injectInstalled'
  > &
    Partial<
      Pick<
        StepToolInputs,
        'runTools' | 'approvalPromptsUnavailable' | 'injectInstalled'
      >
    >,
) {
  const live = yield* LiveTools;
  const held = yield* live.hold(declaredToolNames(input.tools));
  const pinned = yield* live.pinSwitched(
    readDisabledTools(input.stores.globalState),
  );
  const resolved = yield* resolveStepTools(pinned.generation, {
    runTools: [],
    approvalPromptsUnavailable: false,
    injectInstalled: false,
    ...input,
    held,
  }).pipe(
    // No probe has answered: the gate withholds nothing on its account.
    Effect.provide(unprobedToolAvailability),
  );
  return { ...resolved, held, generation: pinned.generation };
});
