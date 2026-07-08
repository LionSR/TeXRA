import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { ProjectedProgressEvent } from '@agent/runtime/sessionProgressEventProjection';
import {
  projectSessionFactToProgressEvent,
  subscribeRunFactsAsProgressEvents,
} from '@agent/runtime/sessionProgressEventProjection';
import type { SessionEventHub } from '@agent/runtime/SessionEventHub';

function emitProjectedProgressEvent(
  runtimeHost: AgentRuntimeHost,
  projected: ProjectedProgressEvent,
): void {
  if (
    projected.event === 'removeStream' &&
    runtimeHost.interactions?.handleProgressEvent(
      projected.event,
      projected.payload,
    )
  ) {
    return;
  }
  runtimeHost.emit(projected.event, projected.payload);
}

/**
 * Headless CLI compatibility adapter. Public CLI output still speaks the
 * frozen host progress-event vocabulary, so this boundary alone re-emits
 * session facts through `runtimeHost.emit`.
 */
export function attachCliSessionProgressProjection(
  events: SessionEventHub,
  runtimeHost: AgentRuntimeHost,
): () => void {
  const detachSessionFacts = events.subscribe(
    (sessionEvent) => {
      if (sessionEvent.scope !== 'session') return;
      const projected = projectSessionFactToProgressEvent(sessionEvent.event);
      if (projected) emitProjectedProgressEvent(runtimeHost, projected);
    },
    { scope: 'session' },
  );
  const detachRunFacts = subscribeRunFactsAsProgressEvents(
    events,
    (projected) => emitProjectedProgressEvent(runtimeHost, projected),
  );

  return () => {
    detachRunFacts();
    detachSessionFacts();
  };
}
