// Wrap a runtime host's `emit` so progress payloads patch `cliState` while
// still flowing through the original emitter. Approvals are intentionally
// not handled here — `subscribeApprovals.ts` owns the typed-modal pipeline.

import type {
  ProgressEvent,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';
import { ToolUseFollowUpQueue } from '@agent/toolUse/ToolUseFollowUpQueueManager';
import { appendTail } from '@utils/strings/appendTail';

import {
  cliState,
  patchStream,
  removeStream,
  setParentStream,
} from './cliState';
import type { CliRuntimeHost } from '../../../runtime/runtimeHost';

type Emit = <K extends ProgressEvent>(
  event: K,
  payload: ProgressEventPayloads[K],
) => void;

/** Cap on per-process tail length held in the signal map (UTF-16 code
 *  units, not bytes — markdown-it / ink work in JS strings). Beyond this
 *  we truncate at the head via the shared `appendTail` helper so the live
 *  pane never grows unbounded. */
export const PROCESS_TAIL_CHARS_MAX = 8 * 1024;

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
    case 'setParentStream': {
      const p = payload as ProgressEventPayloads['setParentStream'];
      setParentStream(p.childStreamId, p.parentStreamId);
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
    case 'updateActiveSubagents': {
      const p = payload as ProgressEventPayloads['updateActiveSubagents'];
      patchStream(p.parentStreamId, (s) => ({
        ...s,
        activeSubagents: p.children,
      }));
      return;
    }
    case 'updateActiveProcesses': {
      const p = payload as ProgressEventPayloads['updateActiveProcesses'];
      patchStream(p.parentStreamId, (s) => ({
        ...s,
        activeProcesses: p.processes,
      }));
      return;
    }
    case 'updateProcessOutput': {
      const p = payload as ProgressEventPayloads['updateProcessOutput'];
      patchStream(p.parentStreamId, (s) => {
        const prev = s.processOutput.get(p.executionId) ?? {
          stdout: '',
          stderr: '',
        };
        const next = {
          stdout: appendTail(prev.stdout, p.stdout, PROCESS_TAIL_CHARS_MAX),
          stderr: appendTail(prev.stderr, p.stderr, PROCESS_TAIL_CHARS_MAX),
        };
        const map = new Map(s.processOutput);
        map.set(p.executionId, next);
        return { ...s, processOutput: map };
      });
      return;
    }
    case 'updateTodos': {
      const p = payload as ProgressEventPayloads['updateTodos'];
      patchStream(p.streamId, (s) => ({ ...s, todos: p.todos }));
      return;
    }
    case 'updatePlan': {
      const p = payload as ProgressEventPayloads['updatePlan'];
      patchStream(p.streamId, (s) => ({ ...s, plan: p.plan }));
      return;
    }
    case 'updateToolEditApprovalBypassState': {
      const p =
        payload as ProgressEventPayloads['updateToolEditApprovalBypassState'];
      patchStream(p.streamId, (s) => ({
        ...s,
        bypass: { ...s.bypass, toolEdit: p.bypassActive },
      }));
      return;
    }
    case 'updateSuperYoloBypassState': {
      const p = payload as ProgressEventPayloads['updateSuperYoloBypassState'];
      patchStream(p.streamId, (s) => ({
        ...s,
        bypass: { ...s.bypass, superYolo: p.bypassActive },
      }));
      return;
    }
    case 'updateQueuedFollowUps': {
      // The event itself has no delta payload — re-read the queue directly so
      // the StatusBar pill stays accurate after both enqueue and drain.
      const p = payload as ProgressEventPayloads['updateQueuedFollowUps'];
      const count = ToolUseFollowUpQueue.getAll(p.streamId).length;
      patchStream(p.streamId, (s) =>
        s.queuedFollowUps === count ? s : { ...s, queuedFollowUps: count },
      );
      return;
    }
    default:
      return;
  }
}
