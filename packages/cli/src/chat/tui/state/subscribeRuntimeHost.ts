// Wrap a runtime host's `emit` so progress payloads patch `cliState` while
// still flowing through the original emitter. Approvals are intentionally
// not handled here — `subscribeApprovals.ts` owns the typed-modal pipeline.

import { defaultSession } from '@agent/runtime/SessionHandle';
import { fromRunFactDomainKey } from '@agent/runtime/runFactEvents';
import type { SessionEventHub } from '@agent/runtime/SessionEventHub';
import { toUpdateStreamUsagePayload } from '@agent/runtime/SessionRunFactProjector';
import type { CliRuntimeHost } from '@cli/runtime/runtimeHost';
import type {
  ProgressEvent,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';
import {
  ExtendedTokenUsageStatsSchema,
  UpdatePlanPayloadSchema,
  UpdateTodosPayloadSchema,
} from '@shared/schemas';
import { diffActiveChildren } from '@shared/streams/childActivityReducer';
import {
  reduceStreamMeta,
  type StreamMetaCommand,
} from '@shared/streams/streamMetaReducer';
import { isObject } from '@utils/core';

import { activeStreamId } from './cliState/focusSlice';
import {
  registerChildStreams,
  setParentStream,
} from './cliState/parentStreamSlice';
import { removeStream } from './cliState/removeStream';
import { patchStream } from './cliState/streamsSlice';
import { mergeChildStreams } from './childExecutions';
import { appendCompletedProcessEntries } from './completedProcessTranscript';
import { sumResumeUsageStats } from './resumeHint';
import { appendLocalAssistantTranscript } from './transcript';
import type { StreamSlice } from './cliState/types';
import type { StreamSnapshotStore } from '@transcript';

type Emit = <K extends ProgressEvent>(
  event: K,
  payload: ProgressEventPayloads[K],
) => void;

type UpdateStreamUsagePayload = ProgressEventPayloads['updateStreamUsage'];
type GoalPausedPayload = ProgressEventPayloads['goalPaused'];

const GOAL_PAUSED_TRANSCRIPT_NOTICE =
  'Goal paused after a failed cycle. Review the error before starting a new goal.';

function usageEchoKey(payload: UpdateStreamUsagePayload): string {
  const parsedUsage = ExtendedTokenUsageStatsSchema.safeParse(payload.usage);
  const usage = parsedUsage.success ? parsedUsage.data : payload.usage;
  const extendedUsage = parsedUsage.success ? parsedUsage.data : undefined;
  return JSON.stringify({
    streamId: payload.streamId,
    storageKey: payload.storageKey,
    executionId: payload.executionId ?? null,
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cost: usage.cost,
      cacheReadInputTokens: usage.cacheReadInputTokens ?? null,
      cacheMissInputTokens: usage.cacheMissInputTokens ?? null,
      cacheCreationInputTokens: usage.cacheCreationInputTokens ?? null,
      elapsedTime: extendedUsage?.elapsedTime ?? null,
      percentageCached: extendedUsage?.percentageCached ?? null,
      reasoningTokens: extendedUsage?.reasoningTokens ?? null,
      toolUseTokens: extendedUsage?.toolUseTokens ?? null,
      usageRoute: usage.usageRoute ?? null,
    },
  });
}

function consumeEchoCount(counts: Map<string, number>, key: string): boolean {
  const count = counts.get(key);
  if (!count) return false;
  if (count === 1) {
    counts.delete(key);
  } else {
    counts.set(key, count - 1);
  }
  return true;
}

class EchoGuard<T> {
  private readonly directAppliedCounts = new Map<string, number>();
  private readonly legacyAppliedCounts = new Map<string, number>();

  constructor(
    private readonly keyFor: (payload: T) => string,
    private readonly apply: (payload: T) => void,
  ) {}

  applyDirect(payload: T): void {
    const key = this.keyFor(payload);
    if (consumeEchoCount(this.legacyAppliedCounts, key)) return;
    this.apply(payload);
    this.rememberForThisTurn(this.directAppliedCounts, key);
  }

  applyLegacy(payload: T): void {
    const key = this.keyFor(payload);
    if (consumeEchoCount(this.directAppliedCounts, key)) return;
    this.apply(payload);
    this.rememberForThisTurn(this.legacyAppliedCounts, key);
  }

  clear(): void {
    this.directAppliedCounts.clear();
    this.legacyAppliedCounts.clear();
  }

  private rememberForThisTurn(counts: Map<string, number>, key: string): void {
    counts.set(key, (counts.get(key) ?? 0) + 1);
    queueMicrotask(() => {
      consumeEchoCount(counts, key);
    });
  }
}

type UsageEchoGuard = EchoGuard<UpdateStreamUsagePayload>;
let activeUsageEchoGuard: UsageEchoGuard | undefined;

function goalPausedEchoKey(payload: GoalPausedPayload): string {
  return payload.streamId;
}

type GoalPausedNoticeEchoGuard = EchoGuard<GoalPausedPayload>;
let activeGoalPausedNoticeEchoGuard: GoalPausedNoticeEchoGuard | undefined;

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

export function wrapRuntimeHost(
  host: CliRuntimeHost,
  snapshotStore?: StreamSnapshotStore,
): CliRuntimeHost {
  const original = host.emit;
  const emit: Emit = (event, payload) => {
    applyToState(event, payload);
    switch (event) {
      case 'setTaskState':
      case 'updateStreamDescription':
      case 'setParentStream':
        snapshotStore?.handleProgressEvent(event, payload);
        break;
      default:
        break;
    }
    return original(event, payload);
  };
  return { ...host, emit };
}

export function attachTuiRunFactSubscription(
  events: SessionEventHub,
): () => void {
  const usageEchoGuard = new EchoGuard(usageEchoKey, applyUsageUpdate);
  const goalPausedNoticeEchoGuard = new EchoGuard(
    goalPausedEchoKey,
    appendGoalPausedTranscriptNotice,
  );
  activeUsageEchoGuard = usageEchoGuard;
  activeGoalPausedNoticeEchoGuard = goalPausedNoticeEchoGuard;
  const detach = events.subscribe(
    (sessionEvent) => {
      if (sessionEvent.scope !== 'run') return;
      const { event } = sessionEvent;
      if (event.type === 'usage') {
        const payload = toUpdateStreamUsagePayload(
          event.data,
          sessionEvent.streamId,
        );
        if (payload) {
          usageEchoGuard.applyDirect(payload);
        }
        return;
      }

      if (event.type !== 'domain') return;
      const factName = fromRunFactDomainKey(event.key);

      switch (factName) {
        case 'updateTodos': {
          const payload = UpdateTodosPayloadSchema.safeParse(event.data);
          if (payload.success) {
            patchStream(payload.data.streamId, (s) => ({
              ...s,
              todos: payload.data.todos,
            }));
          }
          return;
        }
        case 'updatePlan': {
          const payload = UpdatePlanPayloadSchema.safeParse(event.data);
          if (payload.success) {
            patchStream(payload.data.streamId, (s) => ({
              ...s,
              plan: payload.data.plan,
            }));
          }
          return;
        }
        case 'goalPaused': {
          if (isObject(event.data) && typeof event.data.streamId === 'string') {
            goalPausedNoticeEchoGuard.applyDirect({
              streamId: event.data.streamId as GoalPausedPayload['streamId'],
            });
          }
          return;
        }
        default:
          return;
      }
    },
    { scope: 'run', types: ['domain', 'usage'] },
  );
  return () => {
    detach();
    usageEchoGuard.clear();
    goalPausedNoticeEchoGuard.clear();
    if (activeUsageEchoGuard === usageEchoGuard) {
      activeUsageEchoGuard = undefined;
    }
    if (activeGoalPausedNoticeEchoGuard === goalPausedNoticeEchoGuard) {
      activeGoalPausedNoticeEchoGuard = undefined;
    }
  };
}

function applyToState<K extends ProgressEvent>(
  event: K,
  payload: ProgressEventPayloads[K],
): void {
  switch (event) {
    case 'setActiveStream': {
      const p = payload as ProgressEventPayloads['setActiveStream'];
      const next = p.streamId;
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
        category: p.agentCategory ?? s.category,
      }));
      if (p.suppressViewSwitch !== true) {
        activeStreamId.set(next);
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
      if (activeUsageEchoGuard) {
        activeUsageEchoGuard.applyLegacy(p);
      } else {
        applyUsageUpdate(p);
      }
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
      patchStream(p.streamId, (s) => ({
        ...s,
        roundStage: p.roundStage,
      }));
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
      // The shared reducer drops tails for executions that left the active
      // list; the CLI also persists a bounded transcript for each finished
      // process before its tail is pruned (a CLI-only side effect).
      patchStream(p.parentStreamId, (s) => {
        const vanishedIds = diffActiveChildren(s.activeProcesses, p.processes);
        const entries = appendCompletedProcessEntries(
          p.parentStreamId,
          s,
          vanishedIds,
        );
        const meta = applyStreamMeta(s, {
          kind: 'activeProcesses',
          processes: p.processes,
        });
        return {
          ...s,
          activeProcesses: meta.activeProcesses,
          entries,
          processOutput: meta.processOutput,
        };
      });
      return;
    }
    case 'updateProcessOutput': {
      const p = payload as ProgressEventPayloads['updateProcessOutput'];
      patchStream(p.parentStreamId, (s) => ({
        ...s,
        processOutput: applyStreamMeta(s, {
          kind: 'processOutput',
          executionId: p.executionId,
          stdout: p.stdout,
          stderr: p.stderr,
        }).processOutput,
      }));
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
      if (activeGoalPausedNoticeEchoGuard) {
        activeGoalPausedNoticeEchoGuard.applyLegacy(p);
      } else {
        appendGoalPausedTranscriptNotice(p);
      }
      return;
    }
    case 'followUpSent': {
      // Active-session follow-ups enter the same queue before the wait node
      // consumes them; refresh immediately so the status bar shows the pending
      // message instead of only seeing the later drain event.
      const p = payload as ProgressEventPayloads['followUpSent'];
      refreshQueuedFollowUps(p.streamId);
      return;
    }
    default:
      return;
  }
}
