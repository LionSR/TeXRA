/**
 * A host-admitted model switch, recorded by the tool-use loop at its next
 * model boundary: the rows that record it are appended by the one fiber that
 * holds the run's state.
 */
import { Effect, SynchronizedRef } from 'effect';

import { selectModel } from '@texra-ai/llm';
import { ModelAccess } from '@agent/runtime/modelAccess/ModelAccess';
import type { QueuedFollowUp } from '@shared/session/runRows';
import type { RunState } from '@shared/session/runStateFold';

import { AgentRun, type AgentRunShape } from '../run/AgentRun';
import { configRow, consumedRows } from './rows';
import type { RunCell } from './runProgram';

/** Apply the model switches the run's input queues (the latest wins): the
 *  `run.config` naming the new model and the requests' `followup.consumed`,
 *  committed inside the swap, so the new binding goes into force only once
 *  its rows have. The newest `run.config` is the run's one model fact; the
 *  fold drops the old model's continuation with it. */
export const applyPendingModelSwitch = Effect.fn('toolUse.applyModelSwitch')(
  function* (
    cell: RunCell,
    /** What must settle before the old binding closes: a background
     *  compaction on it, which lands or stops. */
    beforeSwap: (cell: RunCell) => Effect.Effect<RunState, Error>,
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
    const consumed = consumedRows(run.runId, controls, 'model');
    const current = yield* SynchronizedRef.get(run.model);
    if (current.modelId === model) return yield* cell.append(consumed);
    const selected = selectModel(model);
    // A switch that cannot apply fails the run: its `run.end` consumes the
    // request, so no resume meets it again.
    if (!selected) {
      return yield* Effect.fail(new Error(`Model ${model} is not registered`));
    }
    const state = yield* beforeSwap(cell);
    let switched = state;
    yield* run.swapModel(() =>
      Effect.gen(function* () {
        const next = yield* access.bind({
          modelId: model,
          config: selected.config,
          backend: current.backend,
          declinedRoutes: state.declinedRoutes,
          textOnly: current.textOnly,
          temperature: run.persona.temperature,
        });
        switched = yield* cell.append([
          ...consumed,
          configRow(run.runId, run.config, next.modelId, {
            backend: next.backend,
            declinedRoutes: run.declinedRoutes,
          }),
        ]);
        return next;
      }),
    );
    return switched;
  },
);

/** The host port's switch methods: whether `model` can replace the run's,
 *  and the admission the loop applies at its next model boundary. */
export function modelSwitchPort(
  run: AgentRunShape,
  access: ModelAccess['Service'],
) {
  /** Why `model` cannot replace the run's, decided as the next bind will. */
  const admission = (model: string) =>
    access.admit(
      model,
      SynchronizedRef.getUnsafe(run.model),
      run.declinedRoutes,
    );
  return {
    modelSwitchDisabledReason: (model: string) =>
      Effect.map(admission(model), (refused) => refused?.reason),
    switchModel: Effect.fn('toolUse.switchModel')(function* (model: string) {
      const refused = yield* admission(model);
      if (refused !== null)
        return yield* Effect.fail(new Error(refused.message));
      // Queued on the run's input, durable at once; the loop binds and
      // records it at its next model boundary, which consumes it. A switch
      // back to the current model is queued too: the latest request wins.
      yield* run.session.followUps.send(run.runId, {
        text: `/model ${model}`,
        from: { kind: 'user' },
        control: { kind: 'model', model },
      });
    }),
  };
}
