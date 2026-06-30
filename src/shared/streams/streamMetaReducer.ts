// Host-neutral per-stream-meta reducer shared by the CLI TUI and the webview
// progress view. Both hosts used to maintain their own near-identical copy of
// this logic (the CLI's `applyToState` mirrored the webview's `streamMetaSlice`
// prune/cap rules). This is the single source of truth: each host projects its
// own store into a `StreamMeta`, runs a `StreamMetaCommand`, and splices the
// returned fields back. Host-only concerns (finished counts, usage, focus,
// task groups, child-stream routing, transcript entries) stay in the adapters.
//
// NO host imports here (no vscode / electron / ink / immer): the reducer is a
// pure function over plain values.

import type {
  ActiveChildInfo,
  ConversationProgress,
  Plan,
  TodoItem,
} from '@shared/schemas';
import { appendTail } from '@utils/strings/appendTail';

/** Per-execution captured stdout/stderr tail held in stream meta. */
export interface StreamProcessOutput {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The slice of per-stream state this reducer owns. `ActiveChildInfo` is the
 * shared badge value object used for both subagent and process rows.
 */
export interface StreamMeta {
  readonly conversation: ConversationProgress | undefined;
  readonly activeSubagents: readonly ActiveChildInfo[];
  readonly activeProcesses: readonly ActiveChildInfo[];
  readonly processOutput: ReadonlyMap<string, StreamProcessOutput>;
  readonly todos: readonly TodoItem[];
  readonly plan: Plan | null;
  readonly description: string | undefined;
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
    }
  | {
      readonly kind: 'activeSubagents';
      readonly subagents: readonly ActiveChildInfo[];
    }
  | {
      readonly kind: 'conversation';
      readonly conversation: ConversationProgress | undefined;
    }
  | { readonly kind: 'todos'; readonly todos: readonly TodoItem[] }
  | { readonly kind: 'plan'; readonly plan: Plan | null }
  | { readonly kind: 'description'; readonly description: string | undefined };

/**
 * Output-cap policy. Once a stream's stdout/stderr crosses `maxChars`, it is
 * trimmed to the last `retainChars` (default `maxChars`, i.e. an exact head-cut
 * at the cap). The CLI uses an exact cut; the webview trims to a lower
 * `retainChars` so output can keep appending before the next reset.
 */
export interface OutputCap {
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
  conversation: undefined,
  activeSubagents: [],
  activeProcesses: [],
  processOutput: new Map(),
  todos: [],
  plan: null,
  description: undefined,
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
      const { maxChars, retainChars } = options.outputCap;
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
    case 'activeSubagents':
      return { ...meta, activeSubagents: command.subagents };
    case 'conversation':
      return { ...meta, conversation: command.conversation };
    case 'todos':
      return { ...meta, todos: command.todos };
    case 'plan':
      return { ...meta, plan: command.plan };
    case 'description':
      return { ...meta, description: command.description };
  }
}
