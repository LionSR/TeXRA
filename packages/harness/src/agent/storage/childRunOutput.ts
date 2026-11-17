import { Effect, type FileSystem } from 'effect';

import { readProgramResult } from '@agent/runtime/programRun';
import {
  runEntryUnder,
  runStorageLocationUnder,
} from '@common/storage/storageLayout';
import { SessionRoots } from '@platform/rootedFs';
import {
  RUN_OUTCOME,
  type RunId,
  type RunStorageFileLocation,
} from '@shared/schemas';
import {
  type RunHistory,
  SessionLog,
  type SessionViewAccess,
} from '@shared/session/runHistory';
import type { ToolRegistry } from '@tools/toolTable';
import { normalizeFilePath } from '@utils/core/pathBasics';

import { getRunRecords } from './runOwnership';

/** Fail unless `reference` names a declared output of a completed direct
 *  child of `parentId`. */
const checkDeclaredChildOutput = Effect.fn('checkDeclaredChildOutput')(
  function* (
    parentId: RunId,
    reference: Pick<
      RunStorageFileLocation,
      'runId' | 'relativePath' | 'absolutePath'
    >,
  ) {
    const store = getRunRecords(reference.runId);
    const [runEnd, config] = yield* Effect.all([
      store.readRunEnd(),
      store.readConfig(),
    ]);
    // The store's edge, not the view's: the view trails the log, and a
    // child it has not applied yet would be refused as no child at all.
    const facts = yield* (yield* SessionLog).facts(reference.runId);
    if (facts?.start?.parent?.id !== parentId) {
      return yield* Effect.fail(
        new Error(
          `Run ${reference.runId} is not a direct child of ${parentId}.`,
        ),
      );
    }
    // A completed program's changes are its declared outputs: the files it
    // wrote, which its registration names (`Program.result.changes`).
    const program =
      runEnd?.outcome === RUN_OUTCOME.COMPLETED
        ? yield* readProgramResult(config, reference.runId, yield* SessionRoots)
        : undefined;
    if (program === undefined) {
      return yield* Effect.fail(
        new Error(`Run ${reference.runId} is no completed program's run.`),
      );
    }
    const declared = program.changes.some(
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
 * Resolve a file of the calling run's own storage (a program's
 * figures), or a declared output of a completed direct child run. The
 * absolute path is only a lookup token; persisted lineage and result
 * metadata are the source of authority.
 */
export const resolveChildRunOutput = Effect.fn('resolveChildRunOutput')(
  function* (
    parentId: RunId,
    absolutePath: string,
  ): Effect.fn.Return<
    RunStorageFileLocation | undefined,
    Error,
    | FileSystem.FileSystem
    | ToolRegistry
    | SessionLog
    | SessionViewAccess
    | RunHistory
    | SessionRoots
  > {
    const roots = yield* SessionRoots;
    const storageRoot = roots.storage;
    const reference = runStorageLocationUnder(storageRoot, absolutePath);
    if (!reference) {
      return yield* Effect.fail(
        new Error('A declared output is not inside run storage.'),
      );
    }

    // The calling run's own storage needs no manifest: it is its own.
    if (reference.runId !== parentId)
      yield* checkDeclaredChildOutput(parentId, reference);

    const entry = yield* runEntryUnder(
      storageRoot,
      reference.runId,
      reference.relativePath,
    );
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
          new Error(`Invalid declared output: ${entry.reason}`),
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
