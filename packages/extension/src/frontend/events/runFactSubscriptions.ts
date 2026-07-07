// Local imports
import type { SessionEventHub } from '@agent/runtime/SessionEventHub';
import { toRunFactDomainKey } from '@agent/runtime/runFactEvents';
import type { AddOutputFilesPayload } from '@shared/schemas';
import { isObject } from '@utils/core';

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
