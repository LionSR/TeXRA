// Project durable session and run facts into the local TUI state.

import { isDeepStrictEqual } from 'node:util';

import type { AgentEvent } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { defaultSession } from '@agent/runtime/SessionHandle';
import type { SessionEventHub } from '@agent/runtime/SessionEventHub';
import {
  type ClearMissingOutputsPayload,
  type SetActiveStreamPayload,
  type StreamTabId,
  type UpdateQueuedFollowUpsPayload,
  type UpdateStreamUsagePayload,
} from '@shared/schemas';
import type { StreamSnapshotStore } from '@transcript';
import { assertNever } from '@utils/core';

import {
  activeStreamId,
  focusStream,
  getCliStateGeneration,
  patchStream,
  recordMissingOutputsReset,
  removeStream,
  registerCliStateResetHook,
  type StreamStage,
} from './cliState';
import {
  applySubagentRoster,
  isChildStreamRemoved,
  setParentStream,
} from './childExecutions';
import { sumResumeUsageStats } from './resumeHint';
import { appendLocalAssistantTranscript } from './transcript';

const GOAL_PAUSED_TRANSCRIPT_NOTICE =
  'Goal paused after a failed cycle. Review the error before starting a new goal.';

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
    focusStream(next);
  }
}

function sameStringList(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return isDeepStrictEqual(left, right);
}

function applyRunConfig(streamId: StreamTabId, config: AgentConfig): void {
  patchStream(streamId, (s) => {
    const files = {
      input: config.inputFiles,
      context: config.contextFiles,
      media: config.mediaFiles,
      output: config.outputFiles,
    };
    const sameFiles =
      s.files !== undefined &&
      (Object.keys(files) as (keyof typeof files)[]).every((key) =>
        sameStringList(s.files?.[key] ?? [], files[key]),
      );
    if (
      s.model === config.model &&
      s.category === config.agentCategory &&
      sameFiles
    ) {
      return s;
    }
    return {
      ...s,
      model: config.model,
      category: config.agentCategory,
      files,
    };
  });
}

function applyStage(streamId: StreamTabId, stage: StreamStage): void {
  patchStream(streamId, (s) =>
    isDeepStrictEqual(s.stage, stage) ? s : { ...s, stage },
  );
}

type MissingOutputTargetResolver = Pick<
  StreamSnapshotStore,
  'findWorkflowStreamsMatching'
>;

function applyClearMissingOutputs(
  payload: ClearMissingOutputsPayload,
  targetResolver: MissingOutputTargetResolver | undefined,
): void {
  let targets: readonly StreamTabId[] = [];
  if (payload.streamId) {
    targets = [payload.streamId];
  } else if (payload.streamConfig && targetResolver) {
    targets = targetResolver.findWorkflowStreamsMatching(payload.streamConfig);
  }
  for (const streamId of targets) {
    // The empty map is a destructive reset, not a round patch. Record its
    // source revision even when the current map is already empty so a cold
    // read that started before this fact cannot restore older disk warnings.
    recordMissingOutputsReset(streamId);
    patchStream(streamId, (slice) =>
      Object.keys(slice.missingOutputsByRound).length === 0
        ? slice
        : { ...slice, missingOutputsByRound: {} },
    );
  }
}

function applyDirectTuiRunEvent(
  event: AgentEvent,
  fallbackStreamId: StreamTabId,
): void {
  switch (event.type) {
    case 'run.config':
      applyRunConfig(event.streamId, event.config);
      return;
    case 'usage':
      applyUsageUpdate(event.payload);
      return;
    case 'conversation.progress':
      patchStream(fallbackStreamId, (s) => ({
        ...s,
        conversation: event.progress,
      }));
      return;
    case 'updateTodos':
      patchStream(event.streamId, (s) => ({
        ...s,
        todos: event.todos,
      }));
      return;
    case 'updatePlan':
      patchStream(event.streamId, (s) => ({
        ...s,
        plan: event.plan,
      }));
      return;
    case 'goalPaused':
      // Without a transcript line, an auto-paused goal is indistinguishable
      // from a hang: the agent simply stops mid-objective.
      appendLocalAssistantTranscript(
        GOAL_PAUSED_TRANSCRIPT_NOTICE,
        event.streamId,
      );
      return;
    case 'addOutputFiles':
      patchStream(event.streamId, (s) => ({
        ...s,
        outputFilesByRound: { ...s.outputFilesByRound, ...event.filesByRound },
      }));
      return;
    case 'updateMissingOutputs':
      patchStream(event.streamId, (s) => ({
        ...s,
        missingOutputsByRound: {
          ...s.missingOutputsByRound,
          ...event.filesByRound,
        },
      }));
      return;
    case 'updateCompileFailures':
      patchStream(event.streamId, (s) => ({
        ...s,
        compileFailuresByRound: {
          ...s.compileFailuresByRound,
          ...event.filesByRound,
        },
      }));
      return;
    case 'stage.start':
      if (event.kind === 'phase') {
        applyStage(fallbackStreamId, {
          kind: 'phase',
          label: event.label,
          ...(event.index !== undefined ? { index: event.index } : {}),
          ...(event.total !== undefined && event.total > 0
            ? { total: event.total }
            : {}),
        });
        return;
      }
      if (event.kind !== 'round') return;
      applyStage(fallbackStreamId, {
        kind: 'round',
        index: event.index ?? 0,
        ...(event.total !== undefined && event.total > 0
          ? { total: event.total }
          : {}),
      });
      return;
    case 'child.activity':
      applySubagentRoster(event.parentStreamId, event.items);
      return;
  }
}

function refreshQueuedFollowUps(
  streamId: UpdateQueuedFollowUpsPayload['streamId'],
): void {
  const messages = defaultSession().followUps.getAll(streamId);
  patchStream(streamId, (s) => {
    if (sameStringList(s.queuedFollowUpMessages, messages)) {
      return s;
    }
    return {
      ...s,
      queuedFollowUpMessages: messages,
    };
  });
}

export function attachTuiRunFactSubscription(
  events: SessionEventHub,
  missingOutputTargets?: MissingOutputTargetResolver,
): () => void {
  let generation = getCliStateGeneration();
  const detachResetHook = registerCliStateResetHook(() => {
    generation = getCliStateGeneration();
  });
  const detachSessionFacts = events.subscribe(
    (sessionEvent) => {
      if (generation !== getCliStateGeneration()) return;
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
          setParentStream(
            fact.payload.childStreamId,
            fact.payload.parentStreamId,
          );
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
        case 'status':
          return;
        case 'clearMissingOutputs':
          applyClearMissingOutputs(fact.payload, missingOutputTargets);
          return;
      }
      assertNever(fact, 'Unhandled TUI session fact');
    },
    { scope: 'session' },
  );
  const detachRunFacts = events.subscribe(
    (sessionEvent) => {
      if (generation !== getCliStateGeneration()) return;
      if (sessionEvent.scope !== 'run') return;
      if (isChildStreamRemoved(sessionEvent.streamId)) return;
      applyDirectTuiRunEvent(sessionEvent.event, sessionEvent.streamId);
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
        'stage.start',
        'child.activity',
      ],
    },
  );
  return () => {
    detachResetHook();
    detachRunFacts();
    detachSessionFacts();
  };
}
