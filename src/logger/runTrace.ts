/**
 * Factories that produce ready-to-use {@link TexraTrace} instances with
 * the standard TeXRA subscribers attached.
 *
 * - `createChannelTrace(name)` — for module-level singletons that just need
 *   per-channel debug output (no transcript).
 *
 * - `createRunTrace(streamId, store)` — for agent runs. Attaches BOTH the
 *   channel-output subscriber AND the {@link attachTranscriptRecorder} that
 *   drives the webview transcript. Returns `{ trace, dispose }` so callers
 *   can release the subscribers when the run ends.
 *
 * The returned trace is `TexraTrace` (the host-extended surface). SDK
 * consumers that only care about agent-general events can still treat it
 * as `AgentTrace` — `TexraTrace extends AgentTrace`.
 */
import type { StreamTabId } from '@shared/schemas';

import { attachChannelSubscriber } from './logUtils';
import {
  getDefaultStreamLogStore,
  type StreamLogStore,
} from './StreamLogStore';
import { attachTranscriptRecorder } from './TexraTranscriptRecorder';
import { TexraTraceEmitter } from './TexraTraceEmitter';
import type { TexraTrace } from './TexraTrace';

/**
 * Produce a trace that writes log events to a per-channel output sink and
 * ignores everything else. Used by module-level singletons that exist
 * outside any agent run.
 */
export function createChannelTrace(name: string): TexraTrace {
  const trace = new TexraTraceEmitter();
  attachChannelSubscriber(trace, { channel: name, isAgent: false });
  return trace;
}

export interface RunTrace {
  readonly trace: TexraTrace;
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
  const trace = new TexraTraceEmitter();
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
