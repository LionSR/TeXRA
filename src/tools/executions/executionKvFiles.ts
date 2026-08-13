/**
 * Internal KV metadata files stored alongside an execution's generated
 * output. Shared by run-directory listing (`runDirectoryFiles.ts`) and the
 * CLI's history file listing (`packages/cli/src/runtime/history/generatedFiles.ts`)
 * so the two stay in sync on what counts as internal metadata.
 *
 * The reserved-key vocabulary itself (meta, config, todos, `child-*`, …) is
 * owned by `ExecutionKVStore`; the `flow_*` prefix is owned by
 * `persistedFlow`; workflow checkpoint keys are owned by `multiAgentWorkflow`.
 * This module only strips the on-disk `.json` suffix and defers to those
 * owners rather than re-deriving the vocabulary.
 *
 * Every real KV entry is written through `KVStore.keyToPath`, which always
 * appends `.json` — so a name without that suffix can never be an internal
 * KV file. Requiring the suffix here (before checking the reserved-name
 * vocabulary) keeps a generated file that happens to be named exactly
 * `meta`, `config`, etc. from being wrongly hidden.
 */

import { isReservedKvKeyName } from '@agent/storage';
import { FLOW_KEY_PREFIX } from '@agent/node/persistedFlow';
import { isWorkflowScriptCheckpointKvKey } from '@agent/workflowScript/checkpointKey';
import { isStableSubagentStateKvKey } from '@tools/delegation/stableSubagentAttempt';

export function isKVFile(name: string): boolean {
  const match = /^(.+)\.json$/.exec(name);
  if (!match) return false;
  const key = match[1];
  return (
    isReservedKvKeyName(key) ||
    key.startsWith(FLOW_KEY_PREFIX) ||
    isWorkflowScriptCheckpointKvKey(key) ||
    isStableSubagentStateKvKey(key)
  );
}
