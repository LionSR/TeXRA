// Host-neutral per-stream-meta reducer shared by the CLI TUI and the webview
// progress view. It owns only the cross-host logic that was duplicated:
// bounded per-process output tails and pruning vanished process tails. Verbatim
// assignments stay in the host adapters.
//
// NO host imports here (no vscode / electron / ink / immer): the reducer is a
// pure function over plain values.

import type { ActiveChildInfo } from '@shared/schemas';
import { appendTail } from '@utils/strings/appendTail';

/** Maximum stdout/stderr tail length retained per active process. */
export const PROCESS_OUTPUT_MAX_CHARS = 100_000;

/** Per-execution captured stdout/stderr tail held in stream meta. */
export interface StreamProcessOutput {
  readonly stdout: string;
  readonly stderr: string;
}

/** The slice of per-stream state this reducer owns. */
export interface StreamMeta {
  readonly activeProcesses: readonly ActiveChildInfo[];
  readonly processOutput: ReadonlyMap<string, StreamProcessOutput>;
}

export type StreamMetaCommand =
  | {
      readonly kind: 'processOutput';
      readonly executionId: string;
      readonly stdout: string;
      readonly stderr: string;
    }
  // Sets the active-process list AND prunes output for processes that vanished.
  | {
      readonly kind: 'activeProcesses';
      readonly processes: readonly ActiveChildInfo[];
    };

/**
 * Output-cap policy. Once a stream's stdout/stderr crosses `maxChars`, it is
 * trimmed to the last `retainChars` (default `maxChars`, i.e. an exact head-cut
 * at the cap). The CLI uses an exact cut; the webview trims to a lower
 * `retainChars` so output can keep appending before the next reset.
 */
interface OutputCap {
  readonly maxChars: number;
  readonly retainChars?: number;
}

export interface ReduceStreamMetaOptions {
  readonly outputCap: OutputCap;
}

const EMPTY_OUTPUT: StreamProcessOutput = { stdout: '', stderr: '' };

/**
 * An empty stream-meta slice. Hosts whose state is split across stores (the
 * webview keeps process output separate from the rest of stream meta) project
 * just the field a command touches over this default.
 */
export const EMPTY_STREAM_META: StreamMeta = {
  activeProcesses: [],
  processOutput: new Map(),
};

/**
 * Apply one command to a stream-meta slice. Pure: never mutates `meta`, always
 * returns a fresh `StreamMeta` (with a fresh `processOutput` Map when output
 * changes), so callers can compare identities or copy fields into their store.
 */
export function reduceStreamMeta(
  meta: StreamMeta,
  command: StreamMetaCommand,
  options: ReduceStreamMetaOptions,
): StreamMeta {
  switch (command.kind) {
    case 'processOutput': {
      const { maxChars } = options.outputCap;
      const retainChars = options.outputCap.retainChars ?? maxChars;
      const prev = meta.processOutput.get(command.executionId) ?? EMPTY_OUTPUT;
      const processOutput = new Map(meta.processOutput);
      processOutput.set(command.executionId, {
        stdout: appendTail(prev.stdout, command.stdout, maxChars, retainChars),
        stderr: appendTail(prev.stderr, command.stderr, maxChars, retainChars),
      });
      return { ...meta, processOutput };
    }
    case 'activeProcesses': {
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
  }
}
