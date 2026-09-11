import { Effect } from 'effect';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { runInSession } from '@agent/runtime/RunContext';
import type { RunId, RunStorageFileLocation } from '@shared/schemas';
import { ensureError } from '@utils/errors/errorMessage';
import {
  inspectRunStorageEntry,
  runStorageLocationFromAnyAbsolutePath,
} from '@utils/files/runStorageFs';

import { getRunRecords } from './RunKVStore';

/**
 * Resolve a declared output of a completed direct child run. The absolute path
 * is only a lookup token; persisted lineage and result metadata are the source
 * of authority.
 */
export const resolveChildRunOutput = Effect.fn('resolveChildRunOutput')(
  function* (
    parentRunId: RunId,
    absolutePath: string,
    session: SessionHandle,
  ): Effect.fn.Return<RunStorageFileLocation | undefined, Error> {
    const reference = runStorageLocationFromAnyAbsolutePath(absolutePath);
    if (!reference) {
      return yield* Effect.fail(
        new Error('Workflow output is not inside task-run storage.'),
      );
    }

    const store = getRunRecords(session, reference.runId);
    const [meta, resultMeta] = yield* Effect.all([
      store.readMeta(),
      store.readResultMeta(),
    ]);
    if (meta?.parentRunId !== parentRunId) {
      return yield* Effect.fail(
        new Error(
          `Run ${reference.runId} is not a direct child of ${parentRunId}.`,
        ),
      );
    }
    if (
      resultMeta?.producer !== 'subagent' ||
      resultMeta.result.output.category !== 'workflow' ||
      resultMeta.result.outcome !== 'completed'
    ) {
      return yield* Effect.fail(
        new Error(
          `Run ${reference.runId} has no completed workflow output manifest.`,
        ),
      );
    }

    const declared = resultMeta.result.output.outputs.some(
      (output) =>
        output.location === 'runStorage' &&
        output.relativePath.replaceAll('\\', '/') === reference.relativePath,
    );
    if (!declared) {
      return yield* Effect.fail(
        new Error(
          `${reference.relativePath} is not a declared output of run ${reference.runId}.`,
        ),
      );
    }

    const entry = yield* Effect.tryPromise({
      try: () =>
        runInSession(session, () =>
          inspectRunStorageEntry(reference.runId, reference.relativePath),
        ),
      catch: ensureError,
    });
    switch (entry.kind) {
      case 'file':
        return entry.location;
      case 'symlink':
        return undefined;
      case 'missing':
        return yield* Effect.fail(
          new Error(
            `Declared output ${reference.relativePath} is missing from run ${reference.runId}.`,
          ),
        );
      case 'invalid':
        return yield* Effect.fail(
          new Error(`Invalid declared workflow output: ${entry.reason}`),
        );
      default:
        return yield* Effect.fail(
          new Error(
            `Declared output ${reference.relativePath} is not a regular file.`,
          ),
        );
    }
  },
);
