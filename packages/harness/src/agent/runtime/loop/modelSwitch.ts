/**
 * A model switch queued on a run's input, applied or refused by the
 * tool-use loop at its next model boundary: the rows that record it are
 * appended by the one fiber that holds the run's state.
 */
import { Effect, ScopedRef } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import { ModelAccess } from '@agent/runtime/modelAccess/ModelAccess';
import type { QueuedFollowUp } from '@shared/session/runRows';
import type { RunState } from '@shared/session/runState';

import type { RunCell } from '@shared/session/runHistory';
import { AgentRun, type AgentRunShape } from '../run/AgentRun';
import { configRow, consumedRows } from './rows';

/** Apply the model switches the run's input queues (the latest wins): the
 *  `run.config` naming the new model and the requests' `followup.consumed`,
 *  committed inside the rebind, so the new binding goes into force only once
 *  its rows have. The newest `run.config` is the run's one model fact; the
 *  fold drops the old model's continuation with it. A switch the run cannot
 *  take (a model not registered, or one its routes cannot serve) is dropped
 *  and named in its trace: it may have been queued while no process held
 *  the run, so nothing checked it then. */
export const applyPendingModelSwitch = Effect.fn('toolUse.applyModelSwitch')(
  function* (
    cell: RunCell,
    /** The run's pending requests; its model switches are applied. */
    controls: readonly QueuedFollowUp[],
  ): Effect.fn.Return<RunState, Error, AgentRun | ModelAccess> {
    const run = yield* AgentRun;
    const access = yield* ModelAccess;
    const switches = controls.flatMap((f) =>
      f.control?.kind === 'model' ? [{ ...f, model: f.control.model }] : [],
    );
    const model = switches.at(-1)?.model;
    if (model === undefined) return yield* cell.current;
    const requests = consumedRows(run.runId, 'model');
    const dropped = requests(controls, { kind: 'dropped', reason: 'noop' });
    const state = yield* cell.current;
    // The run's model is its newest `run.config`, the fold's; the binding
    // is the resource bound for it. A switch to that model changes nothing.
    if (state.modelId === model) return yield* cell.append(dropped);
    const consumed = requests(controls, { kind: 'applied' });
    const current = yield* ScopedRef.get(run.model);
    const refused = yield* access.switchRejection(
      model,
      current,
      state.declinedRoutes,
    );
    if (refused !== null) {
      const message = `The switch to ${model} was not applied: ${refused}`;
      yield* Effect.logWarning(message).pipe(withLogChannel('ModelSwitch'));
      run.logger.warn(message);
      return yield* cell.append(dropped);
    }
    let switched = state;
    // The ref masks its acquisition; a stop must still cut a bind in
    // progress. The rows commit inside it, so the new binding goes into
    // force only once they have.
    yield* ScopedRef.set(
      run.model,
      Effect.gen(function* () {
        const next = yield* access.bind({
          modelId: model,
          backend: current.backend,
          declinedRoutes: state.declinedRoutes,
          textOnly: current.textOnly,
          temperature: run.persona.temperature,
        });
        switched = yield* cell.append([
          ...consumed,
          configRow(run.runId, run.config, next.modelId, {
            backend: next.backend,
            declinedRoutes: next.declinedRoutes,
          }),
        ]);
        return next;
      }).pipe(Effect.interruptible),
    );
    return switched;
  },
);

/** The host port's model check: why `model` cannot replace the run's,
 *  decided as the next bind will, over the routes the run's cell holds. */
export function modelSwitchPort(
  run: AgentRunShape,
  access: ModelAccess['Service'],
  cell: RunCell,
) {
  return {
    modelSwitchDisabledReason: (model: string) =>
      Effect.flatMap(cell.current, (state) =>
        Effect.map(
          access.switchRejection(
            model,
            ScopedRef.getUnsafe(run.model),
            state.declinedRoutes,
          ),
          (refused) => refused ?? undefined,
        ),
      ),
  };
}
