/**
 * A host-admitted model switch, recorded by the tool-use loop at its next
 * model boundary: the rows that record it are appended by the one fiber that
 * holds the run's state.
 */
import { Effect, SynchronizedRef } from 'effect';

import { selectModel } from '@texra-ai/llm';
import { resolveModelRoute, routeBackend } from '@agent/runtime/modelRoutes';
import { decideReasoning } from '@model/reasoningLevel';
import { LanguageModel } from '@platform/languageModel';
import type { QueuedFollowUp } from '@shared/session/runRows';
import type { RunHistoryDraft, RunState } from '@shared/session/runStateFold';

import { AgentRun, type AgentRunShape } from '../run/AgentRun';
import { bindModel, PROTOCOL_BY_BACKEND } from '../run/modelBinding';
import { consumedRows, rowAggregate, type SnapshotPatch } from './rows';
import type { HttpClient } from 'effect/http';
import type { RunCell } from './runProgram';

/** Apply the model switches the run's input queues (the latest wins): the
 *  edit that drops the continuation, the snapshot naming the new model and
 *  the requests' `followup.consumed`, committed inside the swap, so the new
 *  binding goes into force only once its rows have. The snapshot's `modelId`
 *  is the run's one model fact; the run's configuration row keeps the model
 *  it was launched with. */
export const applyPendingModelSwitch = Effect.fn('toolUse.applyModelSwitch')(
  function* (
    state: RunState,
    cell: RunCell,
    /** The loop's snapshot row, family state included. */
    snapshot: (
      state: RunState,
      patch: Omit<SnapshotPatch, 'state'>,
    ) => readonly RunHistoryDraft[],
    /** What must settle on the view before the switch's edit: a background
     *  compaction, which lands or stops. */
    beforeEdit: (state: RunState) => Effect.Effect<RunState, Error>,
    /** The run's pending requests; its model switches are applied. */
    controls: readonly QueuedFollowUp[],
  ): Effect.fn.Return<
    RunState,
    Error,
    AgentRun | LanguageModel | HttpClient.HttpClient
  > {
    const run = yield* AgentRun;
    const switches = controls.flatMap((f) =>
      f.control?.kind === 'model' ? [{ ...f, model: f.control.model }] : [],
    );
    const model = switches.at(-1)?.model;
    if (model === undefined) return state;
    const consumed = consumedRows(run.runId, controls, 'model');
    const current = yield* SynchronizedRef.get(run.model);
    if (current.modelId === model) return yield* cell.append(consumed);
    const selected = selectModel(model);
    // A switch that cannot apply fails the run: its `run.end` consumes the
    // request, so no resume meets it again.
    if (!selected) {
      return yield* Effect.fail(new Error(`Model ${model} is not registered`));
    }
    state = yield* cell.adopt(yield* beforeEdit(state));
    let switched = state;
    yield* run.swapModel(() =>
      Effect.gen(function* () {
        const next = yield* bindModel({
          modelId: model,
          config: selected.config,
          stores: run.stores,
          backend: current.backend,
          declinedRoutes: state.declinedRoutes,
          textOnly: current.textOnly,
          temperature: run.persona.temperature,
        });
        switched = yield* cell.append([
          ...consumed,
          {
            type: 'context.edit',
            aggregateId: rowAggregate(run.runId),
            payload: {
              cause: 'compaction',
              trigger: 'model-switch',
              base: state.lastEdit,
              range: {
                from: state.messages.length,
                to: state.messages.length,
              },
              messages: [],
              usage: null,
            },
          },
          ...snapshot(state, {
            runtime: {
              modelId: next.modelId,
              backend: next.backend,
            },
          }),
        ]);
        return next;
      }),
    );
    return switched;
  },
);

const MODEL_SWITCH_DIFFERENT_FORMAT_ERROR =
  'Cannot switch this conversation to a model with a different conversation format. Start a new chat to use that model.';
const MODEL_SWITCH_DIFFERENT_FORMAT_REASON =
  'different conversation format; start new chat';

/** The host port's switch methods: whether `model` can replace the run's,
 *  and the admission the loop applies at its next model boundary. */
export function modelSwitchPort(
  run: AgentRunShape,
  languageModel: LanguageModel['Service'],
) {
  /** The switch's route and backend, or why it cannot replace the run's. */
  const admission = Effect.fn('toolUse.modelSwitchAdmission')(function* (
    model: string,
  ) {
    const current = SynchronizedRef.getUnsafe(run.model);
    if (current.modelId === model)
      return { reason: undefined, admitted: undefined };
    const selected = selectModel(model);
    if (!selected) {
      return {
        reason: `Model ${model} is not registered`,
        admitted: undefined,
      };
    }
    const nextConfig = selected.config;
    // The run's backend and declined routes, so the preflight decides the
    // route the bind at the next model boundary will.
    const { route } = yield* resolveModelRoute(run.stores, nextConfig, {
      mode: selected.request.mode,
      backend: current.backend,
      declinedRoutes: run.declinedRoutes,
    }).pipe(Effect.provideService(LanguageModel, languageModel));
    const nextBackend = yield* routeBackend(nextConfig, route);
    if (!nextBackend) {
      return {
        reason: `Unsupported model provider: ${nextConfig.provider}`,
        admitted: undefined,
      };
    }
    if (current.backend !== nextBackend) {
      return {
        reason: MODEL_SWITCH_DIFFERENT_FORMAT_REASON,
        admitted: undefined,
      };
    }
    return { reason: undefined, admitted: { selected, route, nextBackend } };
  });
  const modelSwitchDisabledReason = (model: string) =>
    admission(model).pipe(Effect.map(({ reason }) => reason));
  return {
    modelSwitchDisabledReason,
    switchModel: Effect.fn('toolUse.switchModel')(function* (model: string) {
      const admitted = yield* admission(model);
      if (admitted.reason !== undefined) {
        return yield* Effect.fail(
          new Error(
            admitted.reason === MODEL_SWITCH_DIFFERENT_FORMAT_REASON
              ? MODEL_SWITCH_DIFFERENT_FORMAT_ERROR
              : admitted.reason,
          ),
        );
      }
      // A reasoning request the route cannot carry (`@none` on a model that
      // always thinks) is refused here, as the command's error, instead of
      // failing the bind inside the loop and ending the conversation.
      if (admitted.admitted !== undefined) {
        const { selected, route, nextBackend } = admitted.admitted;
        yield* decideReasoning(
          selected.config,
          selected.request,
          run.stores.globalState,
          {
            protocol: PROTOCOL_BY_BACKEND[nextBackend],
            codexSubscription: route.kind === 'chatgpt-subscription',
          },
        );
      }
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
