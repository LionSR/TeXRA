/**
 * Factories that produce ready-to-use {@link AgentTrace} instances with
 * the standard TeXRA subscribers attached.
 *
 * - `createChannelTrace(name)` — for module-level singletons that just need
 *   per-channel debug output (no transcript). Replaces the
 *   `new AgentLogger(name)` pattern (isAgentLogger=false).
 *
 * - `createRunTrace(streamId, store)` — for agent runs. Attaches BOTH the
 *   console subscriber (channel output) AND the {@link
 *   TexraTranscriptRecorder} that drives the webview transcript. Returns
 *   `{ trace, flushPending, dispose }` so callers can drain in-flight
 *   stream chunks at shutdown.
 *
 * Lives in `src/logger/` rather than `src/agent/trace/` because both
 * subscribers (console, transcript) are TeXRA-product concerns. The trace
 * core itself stays platform-neutral.
 */
import type { AgentTrace } from '@agent/trace';
import { TraceEmitter } from '@agent/trace';
import type { StreamTabId } from '@shared/schemas';

import {
  attachConsoleSubscriber,
  type ConsoleSubscriberOptions,
} from './consoleSubscriber';
import { getDefaultStreamLogStore, type StreamLogStore } from './StreamLogStore';
import {
  attachTranscriptRecorder,
  type TranscriptRecorderHandle,
} from './TexraTranscriptRecorder';

/**
 * Produce a trace that writes log events to a per-channel output sink and
 * ignores everything else. Used by module-level singletons that exist
 * outside any agent run.
 */
export function createChannelTrace(name: string): AgentTrace {
  const trace = new TraceEmitter();
  attachConsoleSubscriber(trace, {
    channel: name,
    isAgent: false,
  } satisfies ConsoleSubscriberOptions);
  return trace;
}

export interface RunTrace {
  readonly trace: AgentTrace;
  readonly flushPending: () => void;
  readonly dispose: () => void;
}

/**
 * Produce a trace wired with the standard agent-run subscribers: per-channel
 * console output AND the transcript recorder.
 *
 * `store` defaults to the AgentLogger-managed default — tests can override.
 */
export function createRunTrace(
  streamId: StreamTabId,
  store: StreamLogStore = getDefaultStreamLogStore(),
): RunTrace {
  const trace = new TraceEmitter();
  const unsubscribeConsole = attachConsoleSubscriber(trace, {
    channel: streamId,
    isAgent: true,
  });
  const transcript: TranscriptRecorderHandle = attachTranscriptRecorder(
    trace,
    streamId,
    store,
  );

  // Centralized registry so the static shutdown hook
  // (`flushPendingRunTraces()`) can drain every in-flight stream buffer.
  activeFlushers.add(transcript.flushPending);

  return {
    trace,
    flushPending: transcript.flushPending,
    dispose: () => {
      activeFlushers.delete(transcript.flushPending);
      transcript.unsubscribe();
      unsubscribeConsole();
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
