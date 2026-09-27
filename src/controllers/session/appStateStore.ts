/** Application state reads its root's SQLite authority on every operation. */
import { Effect, RcMap, Result } from 'effect';

import {
  StateReadFailed,
  StateWriteFailed,
  type AppStateStore,
} from '@platform/interfaces';
import {
  JsonValueSchema,
  aggregateId,
  type PersistedJsonValue,
} from '@shared/schemas';
import { ProjectDatabases, type Database } from '@shared/session/database';
import { withPerKeyLane, type PerKeyLane } from '@utils/core/perKeyQueue';
import { toErrorMessage } from '@utils/errors/errorMessage';

/** Preserve write admission order across stores of the same root and key. */
const writeLanes = new Map<string, PerKeyLane>();

/** Capture an owned database handle; the store neither opens nor closes it. */
export function appStateStoreFromDatabase(
  storage: string,
  database: Pick<
    Database['Service'],
    'readAppStateKey' | 'appendAll' | 'updateAppStateKey' | 'appStateChanges'
  >,
): AppStateStore {
  const refused = (key: string, cause: unknown) =>
    new StateWriteFailed({
      key,
      message: `The app-state store at ${storage} refused the write of "${key}": ${toErrorMessage(cause)}`,
      cause,
    });
  const encode = (
    key: string,
    value: unknown,
  ): Result.Result<PersistedJsonValue, StateWriteFailed> =>
    Result.try({
      try: (): PersistedJsonValue =>
        value === undefined
          ? { kind: 'undefined' }
          : { kind: 'json', value: JsonValueSchema.parse(value) },
      catch: (cause) =>
        refused(
          key,
          new Error(`State key ${key} was given a value that is not JSON`, {
            cause,
          }),
        ),
    });
  const lane = (key: string) =>
    withPerKeyLane(writeLanes, `${storage}\u0000${key}`);
  return {
    changes: database.appStateChanges,
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
      Effect.fromResult(encode(key, value)).pipe(
        Effect.flatMap((encoded) =>
          database
            .appendAll([
              {
                type: 'state.value.set',
                aggregateId: aggregateId('app-state', key),
                state: { key: 'app-state', value: encoded },
              },
            ])
            .pipe(Effect.mapError((cause) => refused(key, cause))),
        ),
        Effect.asVoid,
        lane(key),
      ),
    modify: <T, E>(
      key: string,
      change: (current: unknown) => Result.Result<T, E>,
    ) => {
      let next: T | undefined;
      return database
        .updateAppStateKey(key, (current) =>
          Result.flatMap(change(current), (value: T) => {
            next = value;
            return encode(key, value);
          }),
        )
        .pipe(
          Effect.mapError((cause) => refused(key, cause)),
          Effect.flatMap((result) =>
            Result.isSuccess(result)
              ? Effect.succeed(next as T)
              : Effect.fail(result.failure),
          ),
          lane(key),
        );
    },
  };
}

/** Retain the project's persistent database for the caller's project scope. */
export const openProjectStateStore = Effect.fn(
  'appStateStore.openProjectStateStore',
)(function* (storage: string) {
  const database = yield* RcMap.get(yield* ProjectDatabases, storage);
  return appStateStoreFromDatabase(storage, database);
});
