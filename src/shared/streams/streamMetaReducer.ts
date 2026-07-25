// Host-neutral per-stream-meta reducer shared by the CLI TUI and the webview
// progress view. It owns only the cross-host logic that was duplicated:
// setting the active-process roster and pruning tails for processes that
// vanished. Verbatim assignments stay in the host adapters.
//
// NO host imports here (no vscode / electron / ink / immer): the reducer is a
// pure function over plain values.

import type { ActiveChildInfo } from '@shared/schemas';

/** Per-execution captured stdout/stderr tail held in stream meta. */
interface StreamProcessOutput {
  readonly stdout: string;
  readonly stderr: string;
}

/** The slice of per-stream state this reducer owns. */
export interface StreamMeta {
  readonly activeProcesses: readonly ActiveChildInfo[];
  readonly processOutput: ReadonlyMap<string, StreamProcessOutput>;
}

/** Sets the active-process list AND prunes output for processes that vanished. */
export interface StreamMetaCommand {
  readonly kind: 'activeProcesses';
  readonly processes: readonly ActiveChildInfo[];
}

/**
 * An empty stream-meta slice. Hosts whose state is split across stores project
 * just the field a command touches over this default.
 */
export const EMPTY_STREAM_META: StreamMeta = {
  activeProcesses: [],
  processOutput: new Map(),
};

/**
 * Apply one command to a stream-meta slice. Pure: never mutates `meta`, always
 * returns a fresh `StreamMeta` (with a fresh `processOutput` Map when entries
 * are pruned), so callers can compare identities or copy fields into their
 * store.
 */
export function reduceStreamMeta(
  meta: StreamMeta,
  command: StreamMetaCommand,
): StreamMeta {
  const live = new Set(command.processes.map((p) => p.executionId));
  let pruned: Map<string, StreamProcessOutput> | undefined;
  for (const id of meta.processOutput.keys()) {
    if (live.has(id)) continue;
    pruned ??= new Map(meta.processOutput);
    pruned.delete(id);
  }
  return {
    ...meta,
    activeProcesses: command.processes,
    processOutput: pruned ?? meta.processOutput,
  };
}
