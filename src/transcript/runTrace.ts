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
import type { StreamLogStore } from './StreamLogStore';

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
  flushers: Set<() => void> = activeFlushers,
): RunTrace {
  const trace = new TraceEmitter();
  const unsubscribeChannel = attachChannelSubscriber(trace, {
    channel: streamId,
    isAgent: true,
  });
  const transcript = attachTranscriptRecorder(trace, streamId, store);

  // Register the flush in the run's (session-scoped) set so the session can
  // drain its own streams, and track the set so the process-wide shutdown
  // hook (`flushPendingRunTraces()`) still reaches every session's streams.
  flushers.add(transcript.flushPending);
  flusherSets.add(flushers);

  return {
    trace,
    dispose: () => {
      flushers.delete(transcript.flushPending);
      transcript.unsubscribe();
      unsubscribeChannel();
    },
  };
}

/** The default (process) session's flusher set; see `getActiveFlushers`. */
const activeFlushers = new Set<() => void>();

/**
 * Every flusher set handed to {@link createRunTrace}, so the process-wide drain
 * reaches non-default sessions too. The default set is always a member.
 */
const flusherSets = new Set<Set<() => void>>([activeFlushers]);

/**
 * Drain pending stream-chunk updates across every active run trace in every
 * session. Called by shutdown paths (progress view dispose, CLI exit) so
 * throttled stream writes hit the store before the process tears down.
 */
export function flushPendingRunTraces(): void {
  for (const set of flusherSets) {
    for (const flush of [...set]) flush();
  }
}

/**
 * Accessor for the process-default flusher set.
 *
 * Exposed so `SessionHandle` (in `@agent/runtime`) can alias the default
 * session's flushers to this exact set *by identity*. The dependency edge
 * must point this way only — `@transcript` never imports `@agent/runtime`
 * (the layering inversion that the SDK readiness work already removed) — so
 * the agent runtime reaches the set through this accessor, not the reverse.
 */
export function getActiveFlushers(): Set<() => void> {
  return activeFlushers;
}

/**
 * Drop a session's flusher set from the process-wide drain registry — called by
 * {@link SessionHandle.dispose} so a torn-down session's set is not iterated by
 * {@link flushPendingRunTraces} for the rest of the process lifetime. The
 * default (process) set is never removed: it lives for the whole process and
 * the default session is never disposed.
 */
export function unregisterFlushers(set: Set<() => void>): void {
  if (set !== activeFlushers) flusherSets.delete(set);
}
