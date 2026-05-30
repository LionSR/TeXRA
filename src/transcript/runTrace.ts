/**
 * The TeXRA "run trace": an {@link AgentTrace} wired with the product
 * subscribers an agent run needs — per-channel output (from `@logger`) AND
 * the webview/CLI transcript recorder (this package).
 *
 * This lives in `@transcript` rather than `@logger` so the logger package
 * stays free of any transcript/product dependency: SDK consumers use the
 * pure `@agent/trace` channel plus `createChannelTrace`, and attach their own
 * subscribers — they never pull in `StreamLogStore`.
 */
import { TraceEmitter, type AgentTrace } from '@agent/trace';
import { attachChannelSubscriber } from '@logger/logUtils';
import type { StreamTabId } from '@shared/schemas';

import { attachTranscriptRecorder } from './TexraTranscriptRecorder';
import {
  getDefaultStreamLogStore,
  type StreamLogStore,
} from './StreamLogStore';

export interface RunTrace {
  readonly trace: AgentTrace;
  readonly dispose: () => void;
}

/**
 * Produce a trace wired with the standard agent-run subscribers: per-channel
 * channel output AND the transcript recorder.
 *
 * `store` defaults to the global stream-log store — tests can override.
 */
export function createRunTrace(
  streamId: StreamTabId,
  store: StreamLogStore = getDefaultStreamLogStore(),
): RunTrace {
  const trace = new TraceEmitter();
  const unsubscribeChannel = attachChannelSubscriber(trace, {
    channel: streamId,
    isAgent: true,
  });
  const transcript = attachTranscriptRecorder(trace, streamId, store);

  // Centralized registry so the static shutdown hook
  // (`flushPendingRunTraces()`) can drain every in-flight stream buffer.
  activeFlushers.add(transcript.flushPending);

  return {
    trace,
    dispose: () => {
      activeFlushers.delete(transcript.flushPending);
      transcript.unsubscribe();
      unsubscribeChannel();
    },
  };
}

const activeFlushers = new Set<() => void>();

/**
 * Drain pending stream-chunk updates across every active run trace. Called
 * by shutdown paths (progress view dispose, CLI exit) so throttled stream
 * writes hit the store before the process tears down.
 */
export function flushPendingRunTraces(): void {
  for (const flush of [...activeFlushers]) flush();
}
