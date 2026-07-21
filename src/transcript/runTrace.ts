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

import { attachTranscriptRecorder } from './TexraTranscriptRecorder';
import type { StreamLogStore, TranscriptWriter } from './StreamLogStore';

export interface RunTrace {
  readonly trace: AgentTrace;
  readonly dispose: () => void;
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
  flushers: Map<string, () => void> = new Map(),
  ownerKey: string = streamId,
  reservedWriter?: TranscriptWriter,
): RunTrace {
  const writer = reservedWriter ?? store.acquireWriter(streamId, ownerKey);
  const trace = new TraceEmitter();
  const unsubscribeChannel = attachChannelSubscriber(trace, {
    channel: streamId,
    isAgent: true,
  });
  const transcript = attachTranscriptRecorder(trace, writer);

  // Register the flush by execution so durability boundaries drain only their
  // own trace, while session shutdown can still drain every trace.
  // only the artifacts belonging to that session.
  flushers.set(ownerKey, transcript.flushPending);

  let disposed = false;

  return {
    trace,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (flushers.get(ownerKey) === transcript.flushPending) {
        flushers.delete(ownerKey);
      }
      try {
        transcript.unsubscribe();
      } finally {
        try {
          unsubscribeChannel();
        } finally {
          writer.close();
        }
      }
    },
  };
}
