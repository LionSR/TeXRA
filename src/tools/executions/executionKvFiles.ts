/**
 * Internal KV metadata files stored alongside an execution's generated
 * output. Shared by run-directory listing (`runDirectoryFiles.ts`) and the
 * CLI's history file listing (`packages/cli/src/runtime/history/generatedFiles.ts`)
 * so the two stay in sync on what counts as internal metadata.
 *
 * The reserved-key vocabulary itself (meta, config, todos, `child-*`, …) is
 * owned by `ExecutionKVStore`; the `flow_*` prefix is owned by
 * `persistedFlow`. This module only strips the on-disk `.json` suffix and
 * defers to those owners rather than re-deriving the vocabulary.
 */

import { isReservedKvKeyName } from '@agent/storage';
import { FLOW_KEY_PREFIX } from '@agent/node/persistedFlow';

export function isKVFile(name: string): boolean {
  const key = name.replace(/\.json$/, '');
  return isReservedKvKeyName(key) || key.startsWith(FLOW_KEY_PREFIX);
}
