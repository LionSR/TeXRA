/**
 * A host-admitted model switch, recorded by the tool-use loop at its next
 * model boundary: the rows that record it are appended by the one fiber that
 * holds the run's state.
 */
import { MODEL_CONFIGS } from 'llm-zoo';
import { Effect, SynchronizedRef } from 'effect';

import {
  resolveModelRoute,
  routeCompatibilityKey,
} from '@agent/runtime/modelRoutes';
import { LanguageModel } from '@platform/languageModel';
import type { RunLedgerDraft, RunState } from '@shared/session/runStateFold';

import { AgentRun, type AgentRunShape } from '../run/AgentRun';
import { bindModel } from '../run/modelBinding';
import { rowAggregate, type SnapshotPatch } from './rows';
import type { HttpClient } from 'effect/unstable/http';
import type { RunCell } from './runProgram';

/** Record a host-admitted model switch: the compaction that drops the
 *  continuation and the snapshot naming the new model, committed inside the
 *  swap, so the new binding goes into force only once its rows have. The
 *  snapshot's `modelId` is the run's one model fact; the run's configuration
 *  row keeps the model it was launched with. */
export const applyPendingModelSwitch = Effect.fn('toolUse.applyModelSwitch')(
  function* (
    state: RunState,
    cell: RunCell,
    /** The loop's snapshot row, family state included. */
    snapshot: (
      state: RunState,
      patch: Omit<SnapshotPatch, 'state'>,
    ) => readonly RunLedgerDraft[],
  ): Effect.fn.Return<
    RunState,
    Error,
    AgentRun | LanguageModel | HttpClient.HttpClient
  > {
    const run = yield* AgentRun;
    const model = run.pendingModelSwitch.value;
    run.pendingModelSwitch.value = null;
    if (model === null) return state;
    const current = yield* SynchronizedRef.get(run.model);
    if (current.modelId === model) return state;
    const nextConfig = MODEL_CONFIGS[model];
    if (!nextConfig) {
      return yield* Effect.fail(new Error(`Model ${model} is not registered`));
    }
    let switched = state;
    yield* run.swapModel(() =>
      Effect.gen(function* () {
        const next = yield* bindModel({
          config: nextConfig,
          stores: run.stores,
          compatibilityKey: current.compatibilityKey,
          declinedRoutes: state.declinedRoutes,
          agentCategory: run.config.agentCategory,
          temperature: run.setting.temperature,
        });
        switched = yield* cell.append([
          {
            type: 'model.compaction',
            aggregateId: rowAggregate(run.runId),
            payload: {
              keepPrefix: state.messages.length,
              messages: [],
              cause: 'model-switch',
              continuation: null,
              continuationDropped:
                state.continuation === null ? null : 'history-replaced',
              usage: null,
            },
          },
          ...snapshot(state, {
            runtime: {
              modelId: next.modelId,
              modelCompatibilityKey: next.compatibilityKey,
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
  const modelSwitchDisabledReason = Effect.fn(
    'toolUse.modelSwitchDisabledReason',
  )(function* (model: string) {
    const current = SynchronizedRef.getUnsafe(run.model);
    if (current.modelId === model) return undefined;
    const nextConfig = MODEL_CONFIGS[model];
    if (!nextConfig) return `Model ${model} is not registered`;
    const route = yield* resolveModelRoute(run.stores, nextConfig).pipe(
      Effect.provideService(LanguageModel, languageModel),
    );
    const nextKey = yield* routeCompatibilityKey(nextConfig, route);
    if (!nextKey) return `Unsupported model provider: ${nextConfig.provider}`;
    return current.compatibilityKey === nextKey
      ? undefined
      : MODEL_SWITCH_DIFFERENT_FORMAT_REASON;
  });
  return {
    modelSwitchDisabledReason,
    switchModel: Effect.fn('toolUse.switchModel')(function* (model: string) {
      const disabledReason = yield* modelSwitchDisabledReason(model);
      if (disabledReason !== undefined) {
        return yield* Effect.fail(
          new Error(
            disabledReason === MODEL_SWITCH_DIFFERENT_FORMAT_REASON
              ? MODEL_SWITCH_DIFFERENT_FORMAT_ERROR
              : disabledReason,
          ),
        );
      }
      // Bound and recorded by the loop at its next model boundary: the rows
      // that record the switch belong to the fiber holding the run's state.
      run.pendingModelSwitch.value = model;
    }),
  };
}
