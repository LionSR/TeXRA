// Wrap a runtime host's `emit` so progress payloads patch `cliState` while
// still flowing through the original emitter. Approvals are intentionally
// not handled here — Phase 1 keeps them on the legacy adapter.

import type {
  ProgressEvent,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';

import { cliState, patchStream, removeStream } from './cliState';
import type { CliRuntimeHost } from '../../../runtime/runtimeHost';

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
      // `updateQueuedFollowUps` fires for both enqueue AND consume of the
      // tool-use follow-up queue with no delta payload, so any local counter
      // would drift one-way. Phase 1 leaves `queuedFollowUps` at its default
      // (0); Phase 4 wires the StatusBar pill to the real queue length via
      // `ToolUseFollowUpQueue.getAll(streamId).length` when the multi-agent
      // surface lands.
      return;
    }
    default:
      // Phase 1 only consumes the events the header/conversation/input row
      // surfaces — later phases handle subagents/tools/approvals.
      return;
  }
}
