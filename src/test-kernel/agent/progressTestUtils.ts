// Local imports
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import type { AgentRuntimeHost } from '@hosts/AgentRuntimeHost';

export type RecordedProgressEvent = {
  event: keyof ProgressEventPayloads;
  payload: ProgressEventPayloads[keyof ProgressEventPayloads];
};

export function createRecordingHost(): {
  events: RecordedProgressEvent[];
  host: AgentRuntimeHost;
} {
  const events: RecordedProgressEvent[] = [];
  return {
    events,
    host: {
      emit: (event, payload) => events.push({ event, payload }),
    },
  };
}
