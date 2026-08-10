import type { ExecutionId, RunStorageFileLocation } from '@shared/schemas';
import {
  inspectRunStorageEntry,
  runStorageLocationFromAnyAbsolutePath,
} from '@utils/files/runStorageFs';

import { getExecutionStore } from './ExecutionKVStore';

/**
 * Resolve a declared output of a completed direct child run. The absolute path
 * is only a lookup token; persisted lineage and result metadata are the source
 * of authority.
 */
export async function resolveChildRunOutput(
  parentExecutionId: ExecutionId,
  absolutePath: string,
): Promise<RunStorageFileLocation | undefined> {
  const reference = runStorageLocationFromAnyAbsolutePath(absolutePath);
  if (!reference) {
    throw new Error('Workflow output is not inside task-run storage.');
  }

  const store = getExecutionStore(reference.executionId);
  const [meta, resultMeta] = await Promise.all([
    store.readMeta(),
    store.readResultMeta(),
  ]);
  if (meta?.parentExecutionId !== parentExecutionId) {
    throw new Error(
      `Execution ${reference.executionId} is not a direct child of ${parentExecutionId}.`,
    );
  }
  if (
    resultMeta?.producer !== 'subagent' ||
    resultMeta.result.category !== 'workflow' ||
    resultMeta.result.outcome !== 'completed'
  ) {
    throw new Error(
      `Execution ${reference.executionId} has no completed workflow output manifest.`,
    );
  }

  const declared = resultMeta.result.outputs.some(
    (output) =>
      output.location === 'runStorage' &&
      output.relativePath.replaceAll('\\', '/') === reference.relativePath,
  );
  if (!declared) {
    throw new Error(
      `${reference.relativePath} is not a declared output of execution ${reference.executionId}.`,
    );
  }

  const entry = await inspectRunStorageEntry(
    reference.executionId,
    reference.relativePath,
  );
  if (entry.kind === 'file') return entry.location;
  if (entry.kind === 'symlink') return undefined;
  if (entry.kind === 'missing') {
    throw new Error(
      `Declared output ${reference.relativePath} is missing from execution ${reference.executionId}.`,
    );
  }
  if (entry.kind === 'invalid') {
    throw new Error(`Invalid declared workflow output: ${entry.reason}`);
  }
  throw new Error(
    `Declared output ${reference.relativePath} is not a regular file.`,
  );
}
