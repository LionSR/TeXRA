// Local imports
import type { SessionEventHub } from '@agent/runtime';
import type { AddOutputFilesPayload } from '@shared/schemas';

export function subscribeAddOutputFilesRunFact(
  events: SessionEventHub,
  listener: (payload: AddOutputFilesPayload) => void,
): () => void {
  return events.subscribeRunFacts(({ event }) => listener(event), {
    types: ['addOutputFiles'],
  });
}
