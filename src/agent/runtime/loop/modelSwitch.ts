/**
 * A host-admitted model switch, recorded by the tool-use loop at its next
 * model boundary: the rows that record it are appended by the one fiber that
 * holds the run's state.
 */
import { MODEL_CONFIGS } from 'llm-zoo';
import { Effect, Scope, SynchronizedRef } from 'effect';

import { USER_VAR_MODEL } from '@agent/prompt/userVars';
import type { LanguageModel } from '@platform/languageModel';
import type { RunLedgerDraft, RunState } from '@shared/session/runStateFold';

import { AgentRun } from '../run/AgentRun';
import { bindModel, releaseBindingUploads } from '../run/modelBinding';
import { rowAggregate, type SnapshotPatch } from './rows';
import type { HttpClient } from 'effect/unstable/http';
import type { RunCell } from './runProgram';

/** Record a host-admitted model switch: the compaction that drops the
 *  continuation, the snapshot naming the new model, then the live swap. */
export const applyPendingModelSwitch = Effect.fn('toolUse.applyModelSwitch')(
  function* (
    state: RunState,
    cell: RunCell,
    /** The loop's user channels, which name the model the run is on. */
    userChannels: Record<string, unknown>,
    /** The loop's snapshot row, family state included. */
    snapshot: (
      state: RunState,
      patch: Omit<SnapshotPatch, 'state'>,
    ) => RunLedgerDraft,
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
    const next = yield* bindModel({
      config: nextConfig,
      stores: run.stores,
      compatibilityKey: current.compatibilityKey,
      declinedRoutes: state.declinedRoutes,
      agentCategory: run.config.agentCategory,
      temperature: run.setting.temperature,
    }).pipe(Scope.provide(run.scope));
    userChannels[USER_VAR_MODEL] = next.modelId;
    // The snapshot's model id is the run's one model fact. The record a
    // listing or a resume reads and the display row both restate it in
    // the same batch, so no reader sees one without the other.
    const config = { ...run.config, model: next.modelId };
    const switched = yield* cell.append([
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
        },
      },
      {
        type: 'run.record',
        aggregateId: rowAggregate(run.runId),
        record: config,
      },
      { type: 'run.config', aggregateId: rowAggregate(run.runId), config },
      snapshot(state, {
        phase: state.phase ?? 'model.ready',
        runtime: {
          modelId: next.modelId,
          modelCompatibilityKey: next.compatibilityKey,
        },
      }),
    ]);
    yield* SynchronizedRef.set(run.model, next);
    yield* releaseBindingUploads(current.model, current.modelId);
    return switched;
  },
);
