// Local imports
import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

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
