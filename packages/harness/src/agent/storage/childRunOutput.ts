import { Effect, type FileSystem } from 'effect';

import { readRecipeResult } from '@agent/runtime/recipeResult';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  RUN_OUTCOME,
  type RunId,
  type RunStorageFileLocation,
} from '@shared/schemas';
import type { ToolRegistry } from '@tools/toolTable';
import { normalizeFilePath } from '@utils/core';
import { RunFileService } from '@utils/files/runStorage';
import { runStorageLocationUnder } from '@utils/files/runStorageFs';

import { getRunRecords } from './runRecords';

/** Fail unless `reference` names a declared output of a completed direct
 *  child of `parentRunId`. */
const checkDeclaredChildOutput = Effect.fn('checkDeclaredChildOutput')(
  function* (
    session: SessionHandle,
    parentRunId: RunId,
    reference: Pick<
      RunStorageFileLocation,
      'runId' | 'relativePath' | 'absolutePath'
    >,
  ) {
    const store = getRunRecords(session, reference.runId);
    const [runEnd, resultMeta, config] = yield* Effect.all([
      store.readRunEnd(),
      store.readResultMeta(),
      store.readConfig(),
    ]);
    if (session.view.run(reference.runId)?.parentId !== parentRunId) {
      return yield* Effect.fail(
        new Error(
          `Run ${reference.runId} is not a direct child of ${parentRunId}.`,
        ),
      );
    }
    // A completed recipe's changes are its declared outputs: the files it
    // wrote, which its block names (`AgentBlock.result.changes`).
    const recipe =
      resultMeta?.producer === 'subagent' &&
      runEnd?.outcome === RUN_OUTCOME.COMPLETED
        ? yield* readRecipeResult(
            config,
            runEnd.output,
            reference.runId,
            session.roots,
          )
        : undefined;
    if (recipe === undefined) {
      return yield* Effect.fail(
        new Error(
          `Run ${reference.runId} has no completed task output manifest.`,
        ),
      );
    }
    const declared = recipe.changes.some(
      ({ absolutePath }) =>
        normalizeFilePath(absolutePath) ===
        normalizeFilePath(reference.absolutePath),
    );
    if (!declared) {
      return yield* Effect.fail(
        new Error(
          `${reference.relativePath} is not a declared output of run ${reference.runId}.`,
        ),
      );
    }
  },
);

/**
 * Resolve a file of the calling run's own storage (a recipe's
 * figures), or a declared output of a completed direct child run. The
 * absolute path is only a lookup token; persisted lineage and result
 * metadata are the source of authority.
 */
export const resolveChildRunOutput = Effect.fn('resolveChildRunOutput')(
  function* (
    parentRunId: RunId,
    absolutePath: string,
    session: SessionHandle,
  ): Effect.fn.Return<
    RunStorageFileLocation | undefined,
    Error,
    FileSystem.FileSystem | ToolRegistry
  > {
    const storageRoot = session.roots.storage;
    const reference = runStorageLocationUnder(storageRoot, absolutePath);
    if (!reference) {
      return yield* Effect.fail(
        new Error('Workflow output is not inside run storage.'),
      );
    }

    // The calling run's own storage needs no manifest: it is its own.
    if (reference.runId !== parentRunId)
      yield* checkDeclaredChildOutput(session, parentRunId, reference);

    const entry = yield* new RunFileService(
      reference.runId,
      session.roots,
    ).inspectEntry(reference.relativePath);
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
