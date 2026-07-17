// Project durable session and run facts into the local TUI state.

import type { AgentEvent } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { toUpdateStreamUsagePayload } from '@agent/runtime/runFactUsage';
import { defaultSession } from '@agent/runtime/SessionHandle';
import type { SessionEventHub } from '@agent/runtime/SessionEventHub';
import {
  type ActiveChildInfo,
  type GoalPausedPayload,
  type SetActiveStreamPayload,
  type StreamTabId,
  type UpdateActiveProcessesPayload,
  type UpdateProcessOutputPayload,
  type UpdateQueuedFollowUpsPayload,
  type UpdateRoundStagePayload,
  type UpdateStreamUsagePayload,
} from '@shared/schemas';
import { DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME } from '@shared/constants/delegationTools';
import { diffActiveChildren } from '@shared/streams/childActivityReducer';
import {
  reduceStreamMeta,
  type StreamMetaCommand,
} from '@shared/streams/streamMetaReducer';
import { assertNever } from '@utils/core';

import {
  activeStreamId,
  removeStream,
  patchStream,
  type ConversationEntry,
  type StreamSlice,
  type WorkflowScriptProgressFact,
} from './cliState';
import {
  applySubagentRoster,
  isChildStreamRemoved,
  setParentStream,
} from './childExecutions';
import { appendCompletedProcessEntries } from './completedProcessTranscript';
import { sumResumeUsageStats } from './resumeHint';
import { syncStreamLog } from './subscribeStreamLog';
import { appendLocalAssistantTranscript } from './transcript';

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

function applySetActiveStream(payload: SetActiveStreamPayload): void {
  const next = payload.streamId;
  if (!next) {
    activeStreamId.set(undefined);
    return;
  }
  // A stream identity tombstoned by removeStream is never resurrected; a
  // fresh activation after removal uses a distinct StreamTabId.
  if (isChildStreamRemoved(next)) return;
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

function applyRunConfig(streamId: StreamTabId, config: AgentConfig): void {
  patchStream(streamId, (s) => {
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

function applyRoundStage(payload: UpdateRoundStagePayload): void {
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

function applyActiveSubagents(payload: {
  parentStreamId: StreamTabId;
  children: readonly ActiveChildInfo[];
}): void {
  applySubagentRoster(payload.parentStreamId, payload.children);
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

function applyParentStream(payload: {
  childStreamId: StreamTabId;
  parentStreamId: StreamTabId | null;
}): void {
  setParentStream(payload.childStreamId, payload.parentStreamId);
}

interface ActiveWorkflowScriptInvocation {
  readonly logId: string;
  readonly parentStageId: string | undefined;
  readonly phaseIds: Set<string>;
  nextFactIndex: number;
}

type ToolConversationEntry = Extract<ConversationEntry, { role: 'tool' }>;

function patchWorkflowScriptOwner(
  streamId: StreamTabId,
  logId: string,
  update: (entry: ToolConversationEntry) => ToolConversationEntry,
): void {
  patchStream(streamId, (slice) => {
    const index = slice.entries.findIndex(
      (entry) => entry.role === 'tool' && entry.id === logId,
    );
    const entry = slice.entries[index];
    if (index < 0 || entry?.role !== 'tool') return slice;

    const entries = [...slice.entries];
    entries[index] = update(entry);
    return { ...slice, entries };
  });
}

function appendWorkflowScriptFact(
  streamId: StreamTabId,
  logId: string,
  fact: WorkflowScriptProgressFact,
): void {
  patchWorkflowScriptOwner(streamId, logId, (entry) => ({
    ...entry,
    workflowScriptFacts: [...(entry.workflowScriptFacts ?? []), fact],
  }));
}

/** Move the immutable invocation header to Static before progress arrives. */
function finalizeWorkflowScriptOwner(
  streamId: StreamTabId,
  logId: string,
): void {
  patchWorkflowScriptOwner(streamId, logId, (entry) => ({
    ...entry,
    finalized: true,
    workflowScriptFacts: entry.workflowScriptFacts ?? [],
  }));
}

function applyDirectTuiRunEvent(
  event: AgentEvent,
  fallbackStreamId: StreamTabId,
  activeWorkflowScripts: Map<StreamTabId, ActiveWorkflowScriptInvocation>,
): boolean {
  switch (event.type) {
    case 'run.config':
      applyRunConfig(event.streamId, event.config);
      return true;
    case 'usage': {
      const payload = toUpdateStreamUsagePayload(event.data, fallbackStreamId);
      if (!payload) return false;
      applyUsageUpdate(payload);
      return true;
    }
    case 'conversation.progress':
      patchStream(fallbackStreamId, (s) => ({
        ...s,
        conversation: event.progress,
      }));
      return true;
    case 'updateTodos':
      patchStream(event.streamId, (s) => ({
        ...s,
        todos: event.todos,
      }));
      return true;
    case 'updatePlan':
      patchStream(event.streamId, (s) => ({
        ...s,
        plan: event.plan,
      }));
      return true;
    case 'goalPaused':
      appendGoalPausedTranscriptNotice(event);
      return true;
    case 'addOutputFiles':
    case 'updateMissingOutputs':
    case 'updateCompileFailures':
      return false;
    case 'stage.start': {
      if (event.kind === 'phase') {
        const invocation = activeWorkflowScripts.get(fallbackStreamId);
        if (!invocation || event.parentId !== invocation.parentStageId) {
          return false;
        }
        invocation.phaseIds.add(event.id);
        appendWorkflowScriptFact(fallbackStreamId, invocation.logId, {
          type: 'phase',
          id: `${invocation.logId}:phase:${event.id}`,
          stageId: event.id,
          label: event.label,
        });
        return true;
      }
      if (event.kind !== 'round') return false;
      applyRoundStage({
        streamId: fallbackStreamId,
        roundStage: {
          index: event.index ?? 0,
          ...(event.total !== undefined && event.total > 0
            ? { total: event.total }
            : {}),
        },
      });
      return true;
    }
    case 'log': {
      const invocation = activeWorkflowScripts.get(fallbackStreamId);
      if (!invocation || event.stageId === undefined) return false;
      const inPhase = invocation.phaseIds.has(event.stageId);
      if (!inPhase && event.stageId !== invocation.parentStageId) return false;
      appendWorkflowScriptFact(fallbackStreamId, invocation.logId, {
        type: 'log',
        id: `${invocation.logId}:log:${invocation.nextFactIndex++}`,
        level: event.level,
        message: event.message,
        ...(inPhase ? { phaseId: event.stageId } : {}),
      });
      return true;
    }
    case 'tool.start':
      if (event.toolName !== DELEGATE_WORKFLOW_SCRIPT_TOOL_NAME) return false;
      // The transcript recorder runs before the SessionEventHub bridge, so a
      // direct sync materializes the canonical tool row before synchronous
      // script phase/log events can follow in the same turn.
      syncStreamLog(fallbackStreamId);
      finalizeWorkflowScriptOwner(fallbackStreamId, event.logId);
      activeWorkflowScripts.set(fallbackStreamId, {
        logId: event.logId,
        parentStageId: event.stageId,
        phaseIds: new Set(),
        nextFactIndex: 0,
      });
      return true;
    case 'tool.end': {
      const invocation = activeWorkflowScripts.get(fallbackStreamId);
      if (!invocation || invocation.logId !== event.logId) return false;
      activeWorkflowScripts.delete(fallbackStreamId);
      syncStreamLog(fallbackStreamId);
      return true;
    }
    case 'child.activity':
      if (event.kind === 'subagents') {
        applyActiveSubagents({
          parentStreamId: event.parentStreamId,
          children: [...event.children],
        });
        return true;
      }
      applyActiveProcesses({
        parentStreamId: event.parentStreamId,
        processes: [...event.processes],
      });
      return true;
    case 'process.output':
      applyProcessOutput({
        parentStreamId: event.parentStreamId,
        executionId: event.executionId,
        stdout: event.stdout,
        stderr: event.stderr,
      });
      return true;
    default:
      return false;
  }
}

function refreshQueuedFollowUps(
  streamId: UpdateQueuedFollowUpsPayload['streamId'],
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

export function attachTuiRunFactSubscription(
  events: SessionEventHub,
): () => void {
  const activeWorkflowScripts = new Map<
    StreamTabId,
    ActiveWorkflowScriptInvocation
  >();
  const detachSessionFacts = events.subscribe(
    (sessionEvent) => {
      if (sessionEvent.scope !== 'session') return;
      const fact = sessionEvent.event;
      switch (fact.type) {
        case 'setActiveStream':
          applySetActiveStream(fact.payload);
          return;
        case 'updateStreamDescription': {
          const payload = fact.payload;
          patchStream(payload.streamId, (s) => ({
            ...s,
            description: payload.description,
          }));
          return;
        }
        case 'setParentStream':
          applyParentStream(fact.payload);
          return;
        case 'removeStream':
          removeStream(fact.payload.streamId);
          return;
        case 'followUpSent':
          // Active-session follow-ups enter the same queue before the wait node
          // consumes them; refresh immediately so the status bar shows the
          // pending message instead of only seeing the later drain event.
          refreshQueuedFollowUps(fact.payload.streamId);
          return;
        case 'updateQueuedFollowUps':
          refreshQueuedFollowUps(fact.payload.streamId);
          return;
        case 'goalStateChanged':
        case 'inquiryThreadUpdated':
        case 'clearMissingOutputs':
        case 'updateStreamStatus':
          return;
      }
      assertNever(fact, 'Unhandled TUI session fact');
    },
    { scope: 'session' },
  );
  const detachRunFacts = events.subscribe(
    (sessionEvent) => {
      if (sessionEvent.scope !== 'run') return;
      const { event } = sessionEvent;
      if (
        applyDirectTuiRunEvent(
          event,
          sessionEvent.streamId,
          activeWorkflowScripts,
        )
      ) {
        return;
      }
    },
    {
      scope: 'run',
      types: [
        'conversation.progress',
        'updateTodos',
        'updatePlan',
        'addOutputFiles',
        'updateMissingOutputs',
        'updateCompileFailures',
        'goalPaused',
        'run.config',
        'usage',
        'log',
        'stage.start',
        'tool.start',
        'tool.end',
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
