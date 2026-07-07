// Local imports
import type { SessionEventHub } from '@agent/runtime/SessionEventHub';
import { toRunFactDomainKey } from '@agent/runtime/runFactEvents';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventContract';
import { isObject } from '@utils/core';

type AddOutputFilesPayload = ProgressEventPayloads['addOutputFiles'];

function isAddOutputFilesPayload(data: unknown): data is AddOutputFilesPayload {
  return isObject(data) && isObject(data.filesByRound);
}

export function subscribeAddOutputFilesRunFact(
  events: SessionEventHub,
  listener: (payload: AddOutputFilesPayload) => void,
): () => void {
  const key = toRunFactDomainKey('addOutputFiles');
  return events.subscribe(
    (sessionEvent) => {
      if (sessionEvent.scope !== 'run') return;
      const { event } = sessionEvent;
      if (event.type !== 'domain' || event.key !== key) return;
      if (!isAddOutputFilesPayload(event.data)) return;
      listener(event.data);
    },
    { scope: 'run', types: ['domain'] },
  );
}
