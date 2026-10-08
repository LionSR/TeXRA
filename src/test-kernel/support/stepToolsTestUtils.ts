/** One step's tool resolution, as a run's step does it, for suites that
 *  check what a run is offered without running a loop. */
import { Effect } from 'effect';

import {
  declaredToolNames,
  resolveStepTools,
  type StepToolInputs,
} from '@agent/runtime/agentToolResolution';
import { ToolCatalog } from '@tools/liveTools';
import { readDisabledTools } from '@tools/plugins';

import { testRunRegistry } from './runHandleFixtures';
import { unprobedToolAvailability } from './toolAvailabilityTestLayer';

/**
 * Hold the loaded plugins the declarations name in a session catalog of
 * the caller's scope, read the switches `stores` holds and pin the tools
 * they give, then resolve what a step would offer from them and pin the
 * services of the plugins it offers.
 */
export const resolveTestStep = Effect.fn('resolveTestStep')(function* (
  input: Omit<
    StepToolInputs,
    | 'held'
    | 'runTools'
    | 'approvalPromptsUnavailable'
    | 'hostCapabilities'
    | 'injectInstalled'
  > &
    Partial<
      Pick<
        StepToolInputs,
        | 'runTools'
        | 'approvalPromptsUnavailable'
        | 'hostCapabilities'
        | 'injectInstalled'
      >
    >,
) {
  const tools = yield* (yield* ToolCatalog).session(testRunRegistry);
  const held = yield* tools.hold(declaredToolNames(input.tools));
  const pinned = yield* tools.pin(readDisabledTools(input.stores.globalState), {
    held,
  });
  const resolved = yield* resolveStepTools(pinned.entries, {
    runTools: [],
    approvalPromptsUnavailable: false,
    // The extension's own session reads its editor's diagnostics.
    hostCapabilities: new Set(input.host === 'vscode' ? ['diagnostics'] : []),
    injectInstalled: false,
    ...input,
    held,
  }).pipe(
    // No probe has answered: the gate withholds nothing on its account.
    Effect.provide(unprobedToolAvailability),
  );
  // The services of the plugins it offers, as a step pins them.
  yield* pinned.services(new Set(resolved.offered.map(({ plugin }) => plugin)));
  return { ...resolved, held, entries: pinned.entries };
});
