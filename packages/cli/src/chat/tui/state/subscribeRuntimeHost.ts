// Wrap a runtime host's `emit` so progress payloads patch `cliState` while
// still flowing through the original emitter. Approvals are intentionally
// not handled here — Phase 1 keeps them on the legacy adapter.

import type {
  ProgressEvent,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';

import type { CliRuntimeHost } from '../../../runtime/runtimeHost';

import { cliState, patchStream, removeStream } from './cliState';

type Emit = <K extends ProgressEvent>(
  event: K,
  payload: ProgressEventPayloads[K],
) => void;

export function wrapRuntimeHost(host: CliRuntimeHost): CliRuntimeHost {
  const original = host.emit;
  const emit: Emit = (event, payload) => {
    applyToState(event, payload);
    return original(event, payload);
  };
  return { ...host, emit };
}

function applyToState<K extends ProgressEvent>(
  event: K,
  payload: ProgressEventPayloads[K],
): void {
  switch (event) {
    case 'setActiveStream': {
      const next = (payload as ProgressEventPayloads['setActiveStream'])
        .streamId;
      cliState.activeStreamId.set(next ?? undefined);
      return;
    }
    case 'removeStream':
      removeStream((payload as ProgressEventPayloads['removeStream']).streamId);
      return;
    case 'updateStreamUsage': {
      const p = payload as ProgressEventPayloads['updateStreamUsage'];
      patchStream(p.streamId, (s) => ({ ...s, usage: p.usage }));
      return;
    }
    case 'updateConversationProgress': {
      const p = payload as ProgressEventPayloads['updateConversationProgress'];
      patchStream(p.streamId, (s) => ({ ...s, conversation: p.progress }));
      return;
    }
    case 'updateStreamDescription': {
      const p = payload as ProgressEventPayloads['updateStreamDescription'];
      patchStream(p.streamId, (s) => ({ ...s, description: p.description }));
      return;
    }
    case 'updateQueuedFollowUps': {
      const p = payload as ProgressEventPayloads['updateQueuedFollowUps'];
      patchStream(p.streamId, (s) => ({
        ...s,
        // We only get a "something queued" pulse — bump by one and let the
        // consumer (StatusBar / InputBar pill) reset on submit.
        queuedFollowUps: s.queuedFollowUps + 1,
      }));
      return;
    }
    default:
      // Phase 1 only consumes the events the header/conversation/input row
      // surfaces — later phases handle subagents/tools/approvals.
      return;
  }
}
