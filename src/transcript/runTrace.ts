/**
 * The TeXRA "run trace": an {@link AgentTrace} wired with the product
 * subscribers an agent run needs: per-channel output and the webview/CLI
 * transcript recorder (this package).
 *
 * This lives in `@transcript` rather than `@logger` so the logger package
 * stays free of any transcript/product dependency: SDK consumers use the
 * pure `@agent/trace` channel and attach their own subscribers; they never
 * pull in `StreamLogStore`.
 */
import {
  attachChannelSubscriber,
  TraceEmitter,
  type AgentTrace,
} from '@agent/trace';
import type { StreamTabId } from '@shared/schemas';
import { aggregateError } from '@utils/core';

import { attachTranscriptRecorder } from './TexraTranscriptRecorder';
import type { StreamLogStore, TranscriptWriter } from './StreamLogStore';

export interface RunTrace {
  readonly trace: AgentTrace;
  readonly dispose: () => void;
}

export type RunTraceFlushEntry =
  | { readonly state: 'active'; readonly flush: () => void }
  | {
      readonly state: 'failed';
      readonly error: unknown;
      readonly flush: () => void;
    };

/** Run `action`, collecting any throw so every cleanup step still runs. */
function collectFailure(failures: unknown[], action: () => void): void {
  try {
    action();
  } catch (error) {
    failures.push(error);
  }
}

/**
 * Produce a trace wired with the standard agent-run subscribers: per-channel
 * channel output AND the transcript recorder.
 *
 * `store` is caller-supplied — production launch paths pass the owning
 * session's `transcripts` store (`session.transcripts`); there is no
 * process-wide default to fall back to (`@transcript` never imports
 * `@agent/runtime`, so it cannot reach `defaultSession()` itself).
 */
export function createRunTrace(
  streamId: StreamTabId,
  store: StreamLogStore,
  flushers: Map<string, RunTraceFlushEntry> = new Map(),
  ownerKey: string = streamId,
  reservedWriter?: TranscriptWriter,
): RunTrace {
  const writer = reservedWriter ?? store.acquireWriter(streamId, ownerKey);
  const previousEntry = flushers.get(ownerKey);
  if (previousEntry?.state === 'active') {
    const failures: unknown[] = [
      new Error(`Execution ${ownerKey} already owns a run trace.`),
    ];
    collectFailure(failures, () => writer.close());
    throw aggregateError(
      failures,
      'Duplicate run trace setup and cleanup failed',
    );
  }
  const trace = new TraceEmitter();
  let unsubscribeChannel: (() => void) | undefined;
  let transcript: ReturnType<typeof attachTranscriptRecorder>;
  try {
    unsubscribeChannel = attachChannelSubscriber(trace, {
      channel: streamId,
      isAgent: true,
    });
    transcript = attachTranscriptRecorder(trace, writer);
  } catch (error) {
    const failures = [error];
    collectFailure(failures, () => unsubscribeChannel?.());
    collectFailure(failures, () => writer.close());
    throw aggregateError(failures, 'Run trace setup and cleanup failed');
  }

  const pendingFailures =
    previousEntry?.state === 'failed' ? [previousEntry.error] : [];
  const activeEntry: RunTraceFlushEntry = {
    state: 'active',
    flush: () => {
      const failures: unknown[] = [];
      collectFailure(failures, () => transcript.flushPending());
      if (pendingFailures.length > 0) {
        failures.push(...pendingFailures);
        pendingFailures.length = 0;
      }
      if (failures.length > 0) {
        throw aggregateError(failures, 'Run trace flush failed');
      }
    },
  };

  // Register the flush by execution so durability boundaries drain only their
  // own trace, while session shutdown can still drain every trace.
  flushers.set(ownerKey, activeEntry);

  let disposed = false;

  return {
    trace,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      const failures: unknown[] = [];
      collectFailure(failures, () => transcript.unsubscribe());
      collectFailure(failures, () => unsubscribeChannel());
      collectFailure(failures, () => writer.close());
      if (flushers.get(ownerKey) !== activeEntry) return;
      failures.unshift(...pendingFailures);
      if (failures.length === 0) {
        flushers.delete(ownerKey);
        return;
      }
      const failure = aggregateError(failures, 'Run trace cleanup failed');
      const failedEntry: RunTraceFlushEntry = {
        state: 'failed',
        error: failure,
        flush: () => {
          if (flushers.get(ownerKey) === failedEntry) {
            flushers.delete(ownerKey);
          }
          throw failure;
        },
      };
      flushers.set(ownerKey, failedEntry);
    },
  };
}
