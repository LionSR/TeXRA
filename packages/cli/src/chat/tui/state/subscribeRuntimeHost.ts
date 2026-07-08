// Wrap a runtime host's `emit` so progress payloads patch `cliState` while
// still flowing through the original emitter. Approvals are intentionally
// not handled here — `subscribeApprovals.ts` owns the typed-modal pipeline.

import type { AgentEvent } from '@agent/trace';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { projectRunFactToProgressEvent } from '@agent/runtime/sessionProgressEventProjection';
import type { SessionEventHub } from '@agent/runtime/SessionEventHub';
import type {
  ProgressEvent,
  ProgressEventPayloads,
} from '@agent/runtime/hostProgressEvents';
import type { CliRuntimeHost } from '@cli/runtime/runtimeHost';
import {
  type ActiveChildInfo,
  type GoalPausedPayload,
  type UpdateActiveProcessesPayload,
  type UpdateProcessOutputPayload,
  type UpdateStreamUsagePayload,
} from '@shared/schemas';
import { diffActiveChildren } from '@shared/streams/childActivityReducer';
import {
  reduceStreamMeta,
  type StreamMetaCommand,
} from '@shared/streams/streamMetaReducer';

import {
  activeStreamId,
  registerChildStreams,
  setParentStream,
  removeStream,
  patchStream,
  type StreamSlice,
} from './cliState';
import { mergeChildStreams } from './childExecutions';
import { appendCompletedProcessEntries } from './completedProcessTranscript';
import { sumResumeUsageStats } from './resumeHint';
import { appendLocalAssistantTranscript } from './transcript';

type Emit = <K extends ProgressEvent>(
  event: K,
  payload: ProgressEventPayloads[K],
) => void;

const GOAL_PAUSED_TRANSCRIPT_NOTICE =
  'Goal paused after a failed cycle. Review the error before starting a new goal.';

function appendGoalPausedTranscriptNotice(payload: GoalPausedPayload): void {
  // Without a transcript line, an auto-paused goal is indistinguishable
  // from a hang: the agent simply stops mid-objective.
  appendLocalAssistantTranscript(
    GOAL_PAUSED_TRANSCRIPT_NOTICE,
    payload.streamId,
  );
}

function applyUsageUpdate(payload: UpdateStreamUsagePayload): void {
  patchStream(payload.streamId, (s) => ({
    ...s,
    usage: payload.usage,
    cumulativeUsage: sumResumeUsageStats(
      s.cumulativeUsage ? [s.cumulativeUsage, payload.usage] : [payload.usage],
    ),
  }));
}

function applySetActiveStream(
  payload: ProgressEventPayloads['setActiveStream'],
): void {
  const next = payload.streamId;
  if (!next) {
    activeStreamId.set(undefined);
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
    category: payload.agentCategory ?? s.category,
  }));
  if (payload.suppressViewSwitch !== true) {
    activeStreamId.set(next);
  }
}

function applyTaskState(payload: ProgressEventPayloads['setTaskState']): void {
  const config = payload.taskState.agentConfig;
  patchStream(payload.streamId, (s) => {
    if (s.model === config.model && s.category === config.agentCategory) {
      return s;
    }
    return {
      ...s,
      model: config.model,
      category: config.agentCategory,
    };
  });
}

function sameQueuedFollowUps(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => item === right[index])
  );
}

function applyRoundStage(
  payload: ProgressEventPayloads['updateRoundStage'],
): void {
  patchStream(payload.streamId, (s) => {
    if (
      s.roundStage?.index === payload.roundStage.index &&
      s.roundStage?.total === payload.roundStage.total
    ) {
      return s;
    }
    return {
      ...s,
      roundStage: payload.roundStage,
    };
  });
}

function sameActiveChildren(
  left: readonly ActiveChildInfo[],
  right: readonly ActiveChildInfo[],
): boolean {
  return (
    left.length === right.length && left.every((item, i) => item === right[i])
  );
}

function applyActiveSubagents(
  payload: ProgressEventPayloads['updateActiveSubagents'],
): void {
  registerChildStreams(payload.parentStreamId, payload.children);
  patchStream(payload.parentStreamId, (s) => {
    const childStreams = mergeChildStreams(s.childStreams, payload.children);
    if (
      sameActiveChildren(s.activeSubagents, payload.children) &&
      sameActiveChildren(s.childStreams, childStreams)
    ) {
      return s;
    }
    return {
      ...s,
      activeSubagents: payload.children,
      childStreams,
    };
  });
}

function applyActiveProcesses(payload: UpdateActiveProcessesPayload): void {
  // The shared reducer drops tails for executions that left the active
  // list; the CLI also persists a bounded transcript for each finished
  // process before its tail is pruned (a CLI-only side effect).
  patchStream(payload.parentStreamId, (s) => {
    const vanishedIds = diffActiveChildren(
      s.activeProcesses,
      payload.processes,
    );
    const entries = appendCompletedProcessEntries(
      payload.parentStreamId,
      s,
      vanishedIds,
    );
    const meta = applyStreamMeta(s, {
      kind: 'activeProcesses',
      processes: payload.processes,
    });
    return {
      ...s,
      activeProcesses: meta.activeProcesses,
      entries,
      processOutput: meta.processOutput,
    };
  });
}

function applyProcessOutput(payload: UpdateProcessOutputPayload): void {
  patchStream(payload.parentStreamId, (s) => ({
    ...s,
    processOutput: applyStreamMeta(s, {
      kind: 'processOutput',
      executionId: payload.executionId,
      stdout: payload.stdout,
      stderr: payload.stderr,
    }).processOutput,
  }));
}

function applyParentStream(
  payload: ProgressEventPayloads['setParentStream'],
): void {
  setParentStream(payload.childStreamId, payload.parentStreamId);
}

function applyDirectTuiRunEvent(
  event: AgentEvent,
  fallbackStreamId: ProgressEventPayloads['updateRoundStage']['streamId'],
): boolean {
  const projected = projectRunFactToProgressEvent(fallbackStreamId, event);
  if (!projected) return false;

  switch (projected.event) {
    case 'setTaskState':
      applyTaskState(projected.payload);
      return true;
    case 'updateStreamUsage':
      applyUsageUpdate(projected.payload);
      return true;
    case 'updateTodos':
      patchStream(projected.payload.streamId, (s) => ({
        ...s,
        todos: projected.payload.todos,
      }));
      return true;
    case 'updatePlan':
      patchStream(projected.payload.streamId, (s) => ({
        ...s,
        plan: projected.payload.plan,
      }));
      return true;
    case 'updateConversationProgress':
      patchStream(projected.payload.streamId, (s) => ({
        ...s,
        conversation: projected.payload.progress,
      }));
      return true;
    case 'updateRoundStage':
      applyRoundStage(projected.payload);
      return true;
    case 'updateActiveSubagents':
      applyActiveSubagents(projected.payload);
      return true;
    case 'updateActiveProcesses':
      applyActiveProcesses(projected.payload);
      return true;
    case 'updateProcessOutput':
      applyProcessOutput(projected.payload);
      return true;
    case 'goalPaused':
      appendGoalPausedTranscriptNotice(projected.payload);
      return true;
    default:
      return false;
  }
}

function refreshQueuedFollowUps(
  streamId: ProgressEventPayloads['updateQueuedFollowUps']['streamId'],
): void {
  const messages = defaultSession().followUps.getAll(streamId);
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
 *  the shared stream-meta reducer truncates at the head (exact cut, no
 *  `retainChars`) so the live pane never grows unbounded. */
const PROCESS_TAIL_CHARS_MAX = 8 * 1024;
const CLI_OUTPUT_CAP = { maxChars: PROCESS_TAIL_CHARS_MAX } as const;

/**
 * Run one stream-meta command against a CLI slice with the CLI cap policy.
 * The shared reducer owns only process-tail capping and pruning.
 */
function applyStreamMeta(
  s: StreamSlice,
  command: StreamMetaCommand,
): Pick<StreamSlice, 'activeProcesses' | 'processOutput'> {
  return reduceStreamMeta(
    {
      activeProcesses: s.activeProcesses,
      processOutput: s.processOutput,
    },
    command,
    { outputCap: CLI_OUTPUT_CAP },
  );
}

export function wrapRuntimeHost(host: CliRuntimeHost): CliRuntimeHost {
  const original = host.emit;
  const emit: Emit = (event, payload) => {
    applyToState(event, payload);
    return original(event, payload);
  };
  return { ...host, emit };
}

export function attachTuiRunFactSubscription(
  events: SessionEventHub,
): () => void {
  const detachSessionFacts = events.subscribe(
    (sessionEvent) => {
      if (sessionEvent.scope !== 'session') return;
      switch (sessionEvent.event.type) {
        case 'setActiveStream':
          applySetActiveStream(sessionEvent.event.payload);
          return;
        case 'updateStreamDescription': {
          const payload = sessionEvent.event.payload;
          patchStream(payload.streamId, (s) => ({
            ...s,
            description: payload.description,
          }));
          return;
        }
        case 'setParentStream':
          applyParentStream(sessionEvent.event.payload);
          return;
        case 'removeStream':
          removeStream(sessionEvent.event.payload.streamId);
          return;
        case 'followUpSent':
          // Active-session follow-ups enter the same queue before the wait node
          // consumes them; refresh immediately so the status bar shows the
          // pending message instead of only seeing the later drain event.
          refreshQueuedFollowUps(sessionEvent.event.payload.streamId);
          return;
        case 'updateQueuedFollowUps':
          refreshQueuedFollowUps(sessionEvent.event.payload.streamId);
          return;
        default:
          return;
      }
    },
    { scope: 'session' },
  );
  const detachRunFacts = events.subscribe(
    (sessionEvent) => {
      if (sessionEvent.scope !== 'run') return;
      const { event } = sessionEvent;
      if (applyDirectTuiRunEvent(event, sessionEvent.streamId)) {
        return;
      }
    },
    {
      scope: 'run',
      types: [
        'domain',
        'run.config',
        'usage',
        'stage.start',
        'child.activity',
        'process.output',
      ],
    },
  );
  return () => {
    detachRunFacts();
    detachSessionFacts();
  };
}

function applyToState<K extends ProgressEvent>(
  event: K,
  payload: ProgressEventPayloads[K],
): void {
  switch (event) {
    case 'setActiveStream': {
      const p = payload as ProgressEventPayloads['setActiveStream'];
      applySetActiveStream(p);
      return;
    }
    case 'setTaskState': {
      const p = payload as ProgressEventPayloads['setTaskState'];
      applyTaskState(p);
      return;
    }
    case 'setParentStream': {
      const p = payload as ProgressEventPayloads['setParentStream'];
      applyParentStream(p);
      return;
    }
    case 'removeStream':
      removeStream((payload as ProgressEventPayloads['removeStream']).streamId);
      return;
    case 'updateStreamUsage': {
      const p = payload as ProgressEventPayloads['updateStreamUsage'];
      applyUsageUpdate(p);
      return;
    }
    case 'updateConversationProgress': {
      const p = payload as ProgressEventPayloads['updateConversationProgress'];
      patchStream(p.streamId, (s) => ({
        ...s,
        conversation: p.progress,
      }));
      return;
    }
    case 'updateRoundStage': {
      const p = payload as ProgressEventPayloads['updateRoundStage'];
      applyRoundStage(p);
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
      applyActiveSubagents(p);
      return;
    }
    case 'updateActiveProcesses': {
      const p = payload as ProgressEventPayloads['updateActiveProcesses'];
      applyActiveProcesses(p);
      return;
    }
    case 'updateProcessOutput': {
      const p = payload as ProgressEventPayloads['updateProcessOutput'];
      applyProcessOutput(p);
      return;
    }
    case 'updateTodos': {
      const p = payload as ProgressEventPayloads['updateTodos'];
      patchStream(p.streamId, (s) => ({
        ...s,
        todos: p.todos,
      }));
      return;
    }
    case 'updatePlan': {
      const p = payload as ProgressEventPayloads['updatePlan'];
      patchStream(p.streamId, (s) => ({
        ...s,
        plan: p.plan,
      }));
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
      refreshQueuedFollowUps(p.streamId);
      return;
    }
    case 'goalPaused': {
      const p = payload as ProgressEventPayloads['goalPaused'];
      appendGoalPausedTranscriptNotice(p);
      return;
    }
    default:
      return;
  }
}
