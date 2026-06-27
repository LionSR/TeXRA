// Wrap a runtime host's `emit` so progress payloads patch `cliState` while
// still flowing through the original emitter. Approvals are intentionally
// not handled here — `subscribeApprovals.ts` owns the typed-modal pipeline.
import type { CliRuntimeHost } from '@cli/runtime/runtimeHost';
import type {
  ProgressEvent,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';
import { bus } from '@eventBus/ProgressEventBus';
import { appendTail } from '@utils/strings/appendTail';

import {
  cliState,
  patchStream,
  registerChildStreams,
  removeStream,
  setParentStream,
  type ProcessOutputTail,
} from './cliState';
import { mergeChildStreams } from './childExecutions';
import { appendCompletedProcessEntries } from './completedProcessTranscript';
import { sumResumeUsageStats } from './resumeHint';
import { appendLocalAssistantTranscript } from './transcript';

type Emit = <K extends ProgressEvent>(
  event: K,
  payload: ProgressEventPayloads[K],
) => void;

interface RuntimeHostProjectionOptions {
  readonly getQueuedFollowUps?: (
    streamId: ProgressEventPayloads['updateQueuedFollowUps']['streamId'],
  ) => readonly string[];
}

const EMPTY_QUEUED_FOLLOW_UPS: readonly string[] = [];

function sameQueuedFollowUps(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => item === right[index])
  );
}

function refreshQueuedFollowUps(
  streamId: ProgressEventPayloads['updateQueuedFollowUps']['streamId'],
  options: RuntimeHostProjectionOptions,
): void {
  const messages =
    options.getQueuedFollowUps?.(streamId) ?? EMPTY_QUEUED_FOLLOW_UPS;
  patchStream(streamId, (s) => {
    if (
      s.queuedFollowUps === messages.length &&
      sameQueuedFollowUps(s.queuedFollowUpMessages, messages)
    ) {
      return s;
    }
    return {
      ...s,
      queuedFollowUps: messages.length,
      queuedFollowUpMessages: messages,
    };
  });
}

/** Cap on per-process tail length held in the signal map (UTF-16 code
 *  units, not bytes — markdown-it / ink work in JS strings). Beyond this
 *  we truncate at the head via the shared `appendTail` helper so the live
 *  pane never grows unbounded. */
const PROCESS_TAIL_CHARS_MAX = 8 * 1024;

export function wrapRuntimeHost(
  host: CliRuntimeHost,
  options: RuntimeHostProjectionOptions = {},
): CliRuntimeHost {
  const original = host.emit;
  const emit: Emit = (event, payload) => {
    applyToState(event, payload, options);
    bus.emit(event, payload);
    return original(event, payload);
  };
  return { ...host, emit };
}

function applyToState<K extends ProgressEvent>(
  event: K,
  payload: ProgressEventPayloads[K],
  options: RuntimeHostProjectionOptions,
): void {
  switch (event) {
    case 'setActiveStream': {
      const p = payload as ProgressEventPayloads['setActiveStream'];
      const next = p.streamId;
      if (!next) {
        cliState.activeStreamId.set(undefined);
        return;
      }
      // Register background child streams without stealing focus from the
      // parent page. This mirrors the extension progress view contract.
      // Capture the agent category so the exit hint can list only resumable
      // tool-use subagents (workflows don't resume).
      // Always return a fresh slice so a brand-new (e.g. suppressed child)
      // stream is registered in the map even when no category is supplied —
      // returning `s` unchanged would leave a never-created stream unregistered.
      patchStream(next, (s) => ({
        ...s,
        category: p.agentCategory ?? s.category,
      }));
      if (p.suppressViewSwitch !== true) {
        cliState.activeStreamId.set(next);
      }
      return;
    }
    case 'setTaskState': {
      const p = payload as ProgressEventPayloads['setTaskState'];
      const config = p.taskState.agentConfig;
      patchStream(p.streamId, (s) => {
        if (s.model === config.model && s.category === config.agentCategory) {
          return s;
        }
        return {
          ...s,
          model: config.model,
          category: config.agentCategory,
        };
      });
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
      patchStream(p.streamId, (s) => ({
        ...s,
        usage: p.usage,
        cumulativeUsage: sumResumeUsageStats(
          s.cumulativeUsage ? [s.cumulativeUsage, p.usage] : [p.usage],
        ),
      }));
      return;
    }
    case 'updateConversationProgress': {
      const p = payload as ProgressEventPayloads['updateConversationProgress'];
      patchStream(p.streamId, (s) => ({ ...s, conversation: p.progress }));
      return;
    }
    case 'updateStreamDescription': {
      const p = payload as ProgressEventPayloads['updateStreamDescription'];
      patchStream(p.streamId, (s) => ({
        ...s,
        description: p.description,
      }));
      return;
    }
    case 'updateActiveSubagents': {
      const p = payload as ProgressEventPayloads['updateActiveSubagents'];
      registerChildStreams(p.parentStreamId, p.children);
      patchStream(p.parentStreamId, (s) => ({
        ...s,
        activeSubagents: p.children,
        childStreams: mergeChildStreams(s.childStreams, p.children),
      }));
      return;
    }
    case 'updateActiveProcesses': {
      const p = payload as ProgressEventPayloads['updateActiveProcesses'];
      // Drop tails for executions that just left the active list — mirrors
      // `pruneStaleOutputs` in the webview's streamMetaSlice so the map
      // doesn't grow unboundedly for the lifetime of the parent stream.
      const live = new Set(p.processes.map((c) => c.executionId));
      patchStream(p.parentStreamId, (s) => {
        let pruned: Map<string, ProcessOutputTail> | undefined;
        for (const id of s.processOutput.keys()) {
          if (live.has(id)) continue;
          pruned ??= new Map(s.processOutput);
          pruned.delete(id);
        }
        const entries = appendCompletedProcessEntries(
          p.parentStreamId,
          s,
          live,
        );
        return {
          ...s,
          activeProcesses: p.processes,
          entries,
          processOutput: pruned ?? s.processOutput,
        };
      });
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
    case 'updateBashApprovalBypassState': {
      const p =
        payload as ProgressEventPayloads['updateBashApprovalBypassState'];
      patchStream(p.streamId, (s) => ({
        ...s,
        bypass: { ...s.bypass, bash: p.bypassActive },
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
      // The event itself has no delta payload, so re-read the queue directly.
      const p = payload as ProgressEventPayloads['updateQueuedFollowUps'];
      refreshQueuedFollowUps(p.streamId, options);
      return;
    }
    case 'goalPaused': {
      // Without a transcript line, an auto-paused goal is indistinguishable
      // from a hang: the agent simply stops mid-objective.
      const p = payload as ProgressEventPayloads['goalPaused'];
      appendLocalAssistantTranscript(
        'Goal paused after a failed cycle. Review the error before starting a new goal.',
        p.streamId,
      );
      return;
    }
    case 'followUpSent': {
      // Active-session follow-ups enter the same queue before the wait node
      // consumes them; refresh immediately so the status bar shows the pending
      // message instead of only seeing the later drain event.
      const p = payload as ProgressEventPayloads['followUpSent'];
      refreshQueuedFollowUps(p.streamId, options);
      return;
    }
    default:
      return;
  }
}
