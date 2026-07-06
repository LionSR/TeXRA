import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';

import {
  emitProjectedProgressEvent,
  projectRunFactToProgressEvent,
} from './sessionProgressEventProjection';
import {
  emitLegacySessionFactOnHost,
  type SessionEventHub,
} from './SessionEventHub';

/**
 * Temporary Stage 3a bridge from the new session-owned fact plane to the old
 * ProgressEventPayloads surface. It is intentionally finite and one-way:
 * SessionEventHub remains the source of truth for the migrated facts, while
 * legacy hosts keep their byte-identical payload names until their consumers
 * move to the session plane.
 */
export function attachLegacyProgressEventProjection(
  events: SessionEventHub,
  runtimeHost: AgentRuntimeHost,
): () => void {
  const detachSessionFacts = events.subscribe(
    (sessionEvent) => {
      if (sessionEvent.scope === 'session') {
        emitLegacySessionFactOnHost(runtimeHost, sessionEvent.event);
      }
    },
    { scope: 'session' },
  );
  const detachRunFacts = events.subscribe(
    (sessionEvent) => {
      if (sessionEvent.scope !== 'run') return;
      const projected = projectRunFactToProgressEvent(
        sessionEvent.streamId,
        sessionEvent.event,
      );
      if (!projected) return;
      emitProjectedProgressEvent(runtimeHost, projected);
    },
    {
      scope: 'run',
      types: ['stage.start', 'child.activity', 'process.output'],
    },
  );

  return () => {
    detachRunFacts();
    detachSessionFacts();
  };
}
