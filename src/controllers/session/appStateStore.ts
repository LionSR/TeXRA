/** Application state reads its root's SQLite authority on every operation. */
import { Context, Effect, Layer, RcMap } from 'effect';

import {
  StateReadFailed,
  StateWriteFailed,
  type StateStore,
} from '@platform/interfaces';
import {
  JsonValueSchema,
  aggregateId,
  type PersistedJsonValue,
} from '@shared/schemas';
import { Database, ProjectDatabases } from '@shared/session/database';
import { withPerKeyLane, type PerKeyLane } from '@utils/core/perKeyQueue';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { databaseLayer } from './Database';
import { WorkspaceRoots } from './WorkspaceRoots';

/** Preserve write admission order across stores of the same root and key. */
const writeLanes = new Map<string, PerKeyLane>();

/** Capture an owned database handle; the store neither opens nor closes it. */
export function appStateStoreFromDatabase(
  storage: string,
  database: Pick<Database['Service'], 'readAppStateKey' | 'appendAll'>,
): StateStore {
  return {
    get: <T>(key: string, defaultValue?: T) =>
      database.readAppStateKey(key).pipe(
        Effect.map((value) =>
          value === undefined ? (defaultValue as T) : (value as T),
        ),
        Effect.mapError(
          (cause) =>
            new StateReadFailed({
              key,
              message: `The app-state store at ${storage} could not read "${key}": ${toErrorMessage(cause)}`,
              cause,
            }),
        ),
      ),
    update: (key, value) =>
      Effect.try({
        try: (): PersistedJsonValue =>
          value === undefined
            ? { kind: 'undefined' }
            : { kind: 'json', value: JsonValueSchema.parse(value) },
        catch: (cause) =>
          new Error(`State key ${key} was given a value that is not JSON`, {
            cause,
          }),
      }).pipe(
        Effect.flatMap((encoded) =>
          database.appendAll([
            {
              type: 'state.value.set',
              aggregateId: aggregateId('app-state', key),
              state: { key: 'app-state', value: encoded },
            },
          ]),
        ),
        Effect.asVoid,
        withPerKeyLane(writeLanes, `${storage}\u0000${key}`),
        Effect.mapError(
          (cause) =>
            new StateWriteFailed({
              key,
              message: `The app-state store at ${storage} refused the write of "${key}": ${toErrorMessage(cause)}`,
              cause,
            }),
        ),
      ),
  };
}

/** Acquire independent profile state in the caller's scope. Project state
 *  instead borrows the connection its session graph shares below. */
export const openAppStateStore = Effect.fn('appStateStore.openAppStateStore')(
  function* (storage: string) {
    const context = yield* Layer.build(
      databaseLayer('persistent').pipe(
        Layer.provide(Layer.succeed(WorkspaceRoots)({ storage })),
      ),
    );
    return appStateStoreFromDatabase(storage, Context.get(context, Database));
  },
);

/** Retain the project's persistent database for the caller's project scope. */
export const openProjectStateStore = Effect.fn(
  'appStateStore.openProjectStateStore',
)(function* (storage: string) {
  const database = yield* RcMap.get(yield* ProjectDatabases, storage);
  return appStateStoreFromDatabase(storage, database);
});
