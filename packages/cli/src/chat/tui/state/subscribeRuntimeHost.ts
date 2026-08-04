// Project durable session and run facts into the local TUI state.

import { isDeepStrictEqual } from 'node:util';

import type { AgentEvent } from '@agent/trace';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { defaultSession } from '@agent/runtime/SessionHandle';
import type { SessionEventHub } from '@agent/runtime/SessionEventHub';
import {
  sumUsageStats,
  type ClearMissingOutputsPayload,
  type SetActiveStreamPayload,
  type StreamStage,
  type StreamTabId,
  type UpdateQueuedFollowUpsPayload,
  type UpdateStreamUsagePayload,
} from '@shared/schemas';
import { streamStageFromStageStart } from '@shared/streams/stage';
import { assertNever } from '@utils/core';

import {
  activeStreamId,
  focusStream,
  getCliStateGeneration,
  patchStream,
  removeStream,
  registerCliStateResetHook,
} from './cliState';
import {
  applySubagentRoster,
  isChildStreamRemoved,
  setParentStream,
} from './childExecutions';
import { appendLocalAssistantTranscript } from './transcript';
import type { StreamArtifactReader } from './subscribeStreamArtifacts';

const GOAL_PAUSED_TRANSCRIPT_NOTICE =
  'Goal paused after a failed cycle. Review the error before starting a new goal.';

function applyUsageUpdate(
  snapshots: StreamArtifactReader,
  payload: UpdateStreamUsagePayload,
): void {
  // `usage` is a latest-value snapshot (the context-window gauge reads it);
  // the cumulative total is read back from the store's per-run accumulator
  // instead of being summed here a second time.
  const runUsage = [...snapshots.getRunUsage(payload.streamId).values()];
  patchStream(payload.streamId, (s) => ({
    ...s,
    usage: payload.usage,
    cumulativeUsage: runUsage.length
      ? sumUsageStats(runUsage)
      : s.cumulativeUsage,
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
      s.agent === config.agent &&
      s.model === config.model &&
      s.category === config.agentCategory &&
      sameFiles
    ) {
      return s;
    }
    return {
      ...s,
      agent: config.agent,
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

function applyClearMissingOutputs(
  snapshots: StreamArtifactReader,
  { streamId }: ClearMissingOutputsPayload,
): void {
  // The store applies the reset first (its subscription attaches before this
  // one), including the ordering against a still-unseeded stream — see its
  // overlay `reset` flag — so re-reading yields the post-clear state.
  const missingOutputsByRound = snapshots.getMissingOutputs(streamId);
  patchStream(streamId, (slice) =>
    Object.keys(slice.missingOutputsByRound).length === 0 &&
    Object.keys(missingOutputsByRound).length === 0
      ? slice
      : { ...slice, missingOutputsByRound },
  );
}

type TuiRunFactHandlers = {
  readonly [K in AgentEvent['type']]?: (
    event: Extract<AgentEvent, { type: K }>,
    fallbackStreamId: StreamTabId,
    snapshots: StreamArtifactReader,
  ) => void;
};

/**
 * Run facts this TUI projects. The subscription filter below is derived from
 * these keys, so the handled set and the delivered set cannot drift apart and
 * a fact reaching the dispatch always has a handler.
 */
const TUI_RUN_FACT_HANDLERS = {
  'run.start': (event) =>
    patchStream(event.streamId, (s) => ({ ...s, identity: event.identity })),
  'run.config': (event) => applyRunConfig(event.streamId, event.config),
  usage: (event, _fallbackStreamId, snapshots) =>
    applyUsageUpdate(snapshots, event.payload),
  'conversation.progress': (event, fallbackStreamId) =>
    patchStream(fallbackStreamId, (s) => ({
      ...s,
      conversation: event.progress,
    })),
  updateTodos: (event) =>
    patchStream(event.streamId, (s) => ({
      ...s,
      todos: event.todos,
    })),
  updatePlan: (event) =>
    patchStream(event.streamId, (s) => ({
      ...s,
      plan: event.plan,
    })),
  // Without a transcript line, an auto-paused goal is indistinguishable from a
  // hang: the agent simply stops mid-objective.
  goalPaused: (event) =>
    appendLocalAssistantTranscript(
      GOAL_PAUSED_TRANSCRIPT_NOTICE,
      event.streamId,
    ),
  // Artifact facts are triggers, not payloads to accumulate: the shared
  // snapshot store already folded the fact in (its subscription attaches
  // first), so the slice re-reads the store's accumulated rounds — mirroring
  // the extension's ProgressFactApplier.
  addOutputFiles: (event, _fallbackStreamId, snapshots) =>
    patchStream(event.streamId, (s) => ({
      ...s,
      outputFilesByRound: snapshots.getOutputFiles(event.streamId),
    })),
  updateMissingOutputs: (event, _fallbackStreamId, snapshots) =>
    patchStream(event.streamId, (s) => ({
      ...s,
      missingOutputsByRound: snapshots.getMissingOutputs(event.streamId),
    })),
  updateCompileFailures: (event, _fallbackStreamId, snapshots) =>
    patchStream(event.streamId, (s) => ({
      ...s,
      compileFailuresByRound: snapshots.getCompileFailures(event.streamId),
    })),
  'stage.start': (event, fallbackStreamId) => {
    const stage = streamStageFromStageStart(event);
    if (stage) applyStage(fallbackStreamId, stage);
  },
  'child.activity': (event) =>
    applySubagentRoster(event.parentStreamId, event.items),
} satisfies TuiRunFactHandlers;

type TuiRunFactType = keyof typeof TUI_RUN_FACT_HANDLERS;

type TuiRunFactEvent = Extract<AgentEvent, { type: TuiRunFactType }>;

const TUI_RUN_FACT_TYPES = Object.keys(
  TUI_RUN_FACT_HANDLERS,
) as TuiRunFactType[];

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

/**
 * Project session/run facts into the TUI's stream slices. `snapshots` must be
 * the `StreamSnapshotStore` already attached to the same hub (the session
 * attaches it at construction, before this subscription), so artifact and
 * usage facts can re-read the store's accumulated state instead of keeping a
 * second accumulator here.
 */
export function attachTuiRunFactSubscription(
  events: SessionEventHub,
  snapshots: StreamArtifactReader,
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
          applyClearMissingOutputs(snapshots, fact.payload);
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
      // Narrowed by the filter below; TypeScript cannot correlate a union
      // event with its own handler slot, so the lookup is asserted once.
      const event = sessionEvent.event as TuiRunFactEvent;
      const handle = TUI_RUN_FACT_HANDLERS[event.type] as (
        event: TuiRunFactEvent,
        fallbackStreamId: StreamTabId,
        snapshots: StreamArtifactReader,
      ) => void;
      handle(event, sessionEvent.streamId, snapshots);
    },
    { scope: 'run', types: TUI_RUN_FACT_TYPES },
  );
  return () => {
    detachResetHook();
    detachRunFacts();
    detachSessionFacts();
  };
}
