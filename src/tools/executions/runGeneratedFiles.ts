/**
 * The generated (non-KV) files under an execution's storage directory.
 *
 * One walk, two renderings: the agent-facing `/executions/{id}/files` listing
 * in `ExecutionsTool` and the CLI's history detail view both need "what did
 * this run produce", and previously each walked the directory itself. The two
 * walks agreed on depth and on the internal-metadata predicate
 * (`executionKvFiles.isKVFile`, deliberately shared) but disagreed on order,
 * on stat/readDir failure policy, and on whether a KV-*named directory* was
 * descended into — so the same run listed differently depending on who asked.
 *
 * This module lives beside `executionKvFiles` rather than under
 * `@agent/storage` on purpose: the predicate reaches into
 * `@agent/workflowScript` and `@tools/delegation`, and `src/tools` consumes
 * `agent/core`, not the reverse.
 */

import * as path from 'node:path';

import { isFileNotFoundError, isNotADirectoryError } from '@common/errors';
import { createLog } from '@logger/logUtils';
import type { ExecutionId } from '@shared/schemas';
import { byStringProp } from '@utils/core';
// toPosixPath also trims and resolves `.`/`..` segments beyond a bare slash
// swap; safe here since the input is a storage-relative path produced by the
// walk below, not raw user input.
import { toPosixPath } from '@utils/core/pathCore';
import { isDirectory } from '@utils/files/fsEntryType';
import { findExistingRunStoragePath } from '@utils/files/runStorageFs';
import { StorageFS } from '@utils/files/storageFS';

import { isKVFile } from './executionKvFiles';

const log = createLog('runGeneratedFiles');

/** Scan depth: the run root plus one level of generated subdirectories. */
const RUN_FILE_SCAN_DEPTH = 2;

export interface RunGeneratedFile {
  /** Path relative to the run storage directory, POSIX-separated. */
  readonly path: string;
  readonly size: number;
  readonly isDirectory: boolean;
}

/**
 * List the generated (non-KV) files under a run's storage directory, sorted by
 * path. Returns `[]` when the run has no storage directory at all.
 */
export async function listRunGeneratedFiles(
  executionId: ExecutionId,
): Promise<RunGeneratedFile[]> {
  const runDir = await findExistingRunStoragePath(executionId);
  if (!runDir) return [];
  const files = await walkRunStorage(runDir, '', RUN_FILE_SCAN_DEPTH);
  return files.sort(byStringProp((file) => file.path));
}

async function walkRunStorage(
  basePath: string,
  relativePath: string,
  maxDepth: number,
): Promise<RunGeneratedFile[]> {
  const fullPath = relativePath ? path.join(basePath, relativePath) : basePath;

  let entries: readonly (readonly [string, number])[];
  try {
    entries = await StorageFS.readDir(fullPath);
  } catch (error) {
    // Deliberately warn-and-continue rather than rethrow: an unreadable
    // subdirectory must not blank out the rest of the listing. A missing
    // directory is the expected "nothing persisted here" case; any other read
    // failure (permissions, corrupt storage) still degrades to empty, but
    // loudly — the warn is the surfacing mechanism, matching the
    // outputDiscovery/externalInquiryStorage fallback precedent (#10630).
    if (!isFileNotFoundError(error)) {
      log.warn(`Unreadable run directory '${fullPath}'; listing it as empty`, {
        data: error,
      });
    }
    return [];
  }

  const files: RunGeneratedFile[] = [];
  for (const [name, type] of entries) {
    // Skip before stat and before recursion: a KV-named *directory* is
    // internal metadata all the way down, so its children are not generated
    // output either.
    if (isKVFile(name)) continue;

    const rawRelative = relativePath ? path.join(relativePath, name) : name;
    const childPath = path.join(basePath, rawRelative);
    const entryIsDirectory = isDirectory(type);

    try {
      const stat = await StorageFS.stat(childPath);
      files.push({
        path: toPosixPath(rawRelative),
        size: stat.size,
        isDirectory: entryIsDirectory,
      });
    } catch (error) {
      // An entry that vanished (or whose parent stopped being a directory)
      // between readDir and stat is a benign race; anything else is a real
      // fault and propagates.
      if (isFileNotFoundError(error) || isNotADirectoryError(error)) continue;
      throw error;
    }

    if (entryIsDirectory && maxDepth > 1) {
      files.push(
        ...(await walkRunStorage(basePath, rawRelative, maxDepth - 1)),
      );
    }
  }
  return files;
}
