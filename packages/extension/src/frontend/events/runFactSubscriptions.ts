// Local imports
import type { SessionEventHub } from '@agent/runtime/SessionEventHub';
import type { AddOutputFilesPayload } from '@shared/schemas';

export function subscribeAddOutputFilesRunFact(
  events: SessionEventHub,
  listener: (payload: AddOutputFilesPayload) => void,
): () => void {
  return events.subscribe(
    (sessionEvent) => {
      if (sessionEvent.scope !== 'run') return;
      const { event } = sessionEvent;
      if (event.type !== 'addOutputFiles') return;
      listener({
        streamId: event.streamId,
        ...(event.executionId ? { executionId: event.executionId } : {}),
        filesByRound: event.filesByRound,
      });
    },
    { scope: 'run', types: ['addOutputFiles'] },
  );
}
