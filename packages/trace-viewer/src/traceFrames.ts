/**
 * An exported trace as the session plane would have carried it (PRD
 * one-fold-three-renderers, 7.1): the listing facts of one finished run
 * and its transcript rows, stamped with a synthetic envelope so the same
 * fold the live hosts run folds them to the same view. The document is
 * immutable, so every `Subscribe` is answered from these rows in full.
 */
import {
  AgentCategory,
  END_GROUP_STATUS,
  runIdentityDisplayName,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  USER_FOLLOW_UP_SUPPORT,
  type RunIdentity,
  type SessionEvent,
  type SessionEventDraft,
  type StreamPhase,
} from '@shared/schemas';
import type { EventsFrame, Subscribe } from '@shared/session/sessionFrames';
import { isTerminalOutcomePhase } from '@shared/streams/streamStatus';
import type { TraceDocument } from '@transcript';

/**
 * Stage kinds nested under the root "Run:" stage (see `StageOptions.kind` in
 * `@agent/trace`). A tool-use round (and any other non-root stage of these
 * kinds) is opened without an ambient parent, so its `GROUP_END` row gets
 * `groupId === undefined` just like the root run stage's own. Only the root
 * stage's row is tagged `kind: 'run'` (or has no `kind` at all, for traces
 * recorded before stage kinds existed); anything tagged with one of these
 * kinds is a nested stage that shares the root's "no parent" shape and must
 * be excluded from the reverse scan below.
 */
const NESTED_STAGE_KINDS = new Set(['round', 'phase', 'session']);

/**
 * The root run stage's entry id by structural position, for archived traces
 * where `data.kind` is not available to check. Every historical trace holds
 * each stage in exactly one entry for its whole lifetime (`stage.end`
 * mutates that entry in place), and `beginRunStage` opens the root run stage
 * before any flow starts, so among every top-level stage entry the root's is
 * the earliest by seqNo.
 */
function findRootStageId(
  entries: TraceDocument['entries'],
): string | undefined {
  return entries.find(
    (entry) =>
      entry.groupId === undefined &&
      (entry.type === STREAM_LOG_ENTRY_TYPES.GROUP_START ||
        entry.type === STREAM_LOG_ENTRY_TYPES.GROUP_END),
  )?.id;
}

/**
 * The terminal phase the trace records, or null for a trace that never
 * reached one. `meta.outcome` is the one terminal fact the document
 * carries; for traces that predate outcome tracking, the persisted
 * transcript's last terminal root group row decides, then the older
 * snapshot-status escape hatch (already normalized to `StreamPhase` at
 * trace parse). A trace with no terminal fact folds as interrupted: an
 * exported file has no producer that could still be running it.
 */
function traceOutcome(trace: TraceDocument): StreamPhase | null {
  if (trace.meta?.outcome) return trace.meta.outcome;
  const rootStageId = findRootStageId(trace.entries);
  for (const entry of trace.entries.toReversed()) {
    if (entry.type !== STREAM_LOG_ENTRY_TYPES.GROUP_END) continue;
    if (entry.groupId !== undefined) continue;
    const kind = entry.data.kind;
    if (kind !== undefined) {
      if (NESTED_STAGE_KINDS.has(kind)) continue;
    } else if (entry.id !== rootStageId) {
      // No `data.kind` to check: this entry predates kind-tagging. Only the
      // entry at the root stage's fixed position can be the run's own
      // GROUP_END; anything else sharing the "no parent" shape is a nested
      // round, phase, or session.
      continue;
    }
    const { status } = entry.data;
    if (status === END_GROUP_STATUS.ERROR) return STREAM_PHASE.FAILED;
    if (status === END_GROUP_STATUS.STOPPED) return STREAM_PHASE.COMPLETED;
    if (status !== undefined) return status;
  }
  const status = trace.snapshot.status;
  return status !== undefined && isTerminalOutcomePhase(status) ? status : null;
}

/** The raw configured name across both arms of the config union. Not a
 *  display name: it still carries any source prefix. */
function recordName(config: TraceDocument['config']): string {
  return 'agentCategory' in config ? config.agent : config.name;
}

function legacyTraceIdentity(trace: TraceDocument): RunIdentity {
  const { streamId } = trace;
  const name = recordName(trace.config);
  if (streamId.startsWith('workflow-script#')) {
    return { kind: 'multiAgentWorkflow', workflowName: name };
  }
  if (streamId.startsWith('codex@')) {
    return { kind: 'agent', agent: name, tool: 'codex' };
  }
  if (streamId.startsWith('claude@')) {
    return { kind: 'agent', agent: name, tool: 'claude_code' };
  }
  if (streamId.startsWith('bash@')) return { kind: 'process', tool: 'bash' };
  return { kind: 'agent', agent: name };
}

/**
 * The run's identity. The embedded ExecutionMeta carries it; pre-migration
 * exports have none and are not all agent runs (bash process and
 * workflow-script traces exist), so those classify from the trace's
 * stream-id prefix. An exported trace file is immutable, so this fallback
 * is permanent: it is the only place a stream-id prefix may be read as
 * evidence.
 */
function traceIdentity(trace: TraceDocument): RunIdentity {
  return trace.meta?.identity ?? legacyTraceIdentity(trace);
}

/** The run's display name: the same identity rule every host's stream tab
 *  labels with, so the page title and the tab cannot disagree. */
export function traceDisplayName(trace: TraceDocument): string {
  return runIdentityDisplayName(traceIdentity(trace));
}

/** The listing facts of the run, in publish order, without envelopes. */
function listingBodies(trace: TraceDocument): SessionEventDraft[] {
  const { snapshot, executionId } = trace;
  const agentConfig =
    'agentCategory' in trace.config ? trace.config : undefined;
  const identity = traceIdentity(trace);
  // Workflow-shaped for workflow agents and multi-agent-workflow containers
  // (both have round outputs); everything else renders the tool-use shape.
  const category =
    agentConfig?.agentCategory === AgentCategory.Workflow ||
    identity.kind === 'multiAgentWorkflow'
      ? AgentCategory.Workflow
      : AgentCategory.ToolUse;
  const bodies: SessionEventDraft[] = [
    {
      type: 'run.start',
      aggregateId: trace.streamId,
      executionId,
      identity,
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
      category,
      isRemote: false,
      worktree: null,
      parentStreamId: null,
    },
    {
      type: 'run.config',
      aggregateId: trace.streamId,
      executionId,
      config: {
        model: trace.config.model,
        instruction: trace.config.instruction,
        agent: recordName(trace.config),
        inputFiles: agentConfig?.inputFiles ?? null,
      },
    },
  ];
  if (trace.meta?.description) {
    bodies.push({
      type: 'updateStreamDescription',
      aggregateId: trace.streamId,
      description: trace.meta.description,
    });
  }
  if (snapshot.conversationProgress) {
    bodies.push({
      type: 'conversation.progress',
      aggregateId: trace.streamId,
      progress: snapshot.conversationProgress,
    });
  }
  for (const [storageKey, usage] of Object.entries(snapshot.runUsage)) {
    bodies.push({
      type: 'usage',
      aggregateId: trace.streamId,
      storageKey,
      usage,
    });
  }
  if (category === AgentCategory.Workflow) {
    bodies.push(
      {
        type: 'addOutputFiles',
        aggregateId: trace.streamId,
        filesByRound: snapshot.outputFilesByRound,
      },
      {
        type: 'updateMissingOutputs',
        aggregateId: trace.streamId,
        filesByRound: snapshot.missingOutputsByRound,
      },
      {
        type: 'updateCompileFailures',
        aggregateId: trace.streamId,
        filesByRound: snapshot.compileFailuresByRound,
      },
    );
  } else {
    bodies.push(
      {
        type: 'updateTodos',
        aggregateId: trace.streamId,
        todos: snapshot.todos,
      },
      { type: 'updatePlan', aggregateId: trace.streamId, plan: snapshot.plan },
    );
  }
  const outcome = traceOutcome(trace);
  if (outcome !== null && isTerminalOutcomePhase(outcome)) {
    bodies.push(
      {
        type: 'status',
        aggregateId: trace.streamId,
        phase: outcome,
        previousPhase: null,
        cause: 'trace',
        substate: null,
        runStartedAt: trace.entries[0]?.timestamp ?? null,
      },
      {
        type: 'result',
        aggregateId: trace.streamId,
        outcome,
        executionId,
        category,
        isSubagent: false,
        error: null,
      },
    );
  }
  return bodies;
}

/**
 * The events of one trace: listing rows, then the transcript rows, one
 * aggregate (the stream), seq in publish order, commit equal to seq. The
 * legacy import stamps `ownerId: null` (contract C3), which folds every
 * unfinished run as interrupted and every finished one as durably final.
 */
function traceEvents(trace: TraceDocument): {
  readonly listing: SessionEvent[];
  readonly transcript: SessionEvent[];
} {
  const at = trace.entries[0]?.timestamp ?? 0;
  let seq = 0;
  // The publisher's stamp (contract C2), as `SessionEventLog` would have
  // applied it: a draft is a distributive omit over the union, so the
  // spread cannot be typed back into the union without the assertion.
  const stamp = (draft: SessionEventDraft): SessionEvent => {
    seq += 1;
    return { ...draft, seq, commit: seq, ownerId: null, at } as SessionEvent;
  };
  const listing = listingBodies(trace).map(stamp);
  const transcript = trace.entries.map((entry) =>
    stamp({ type: 'transcript.entry', aggregateId: trace.streamId, entry }),
  );
  return { listing, transcript };
}

/**
 * The one frame that answers a `Subscribe` over an exported trace: the
 * listing, the transcript rows of the stream when the subscriber named it,
 * the marker, and an empty local snapshot. A trace has no tail.
 */
export function traceFrame(
  trace: TraceDocument,
  session: string,
  subscribe: Subscribe,
): EventsFrame {
  const { listing, transcript } = traceEvents(trace);
  const named = subscribe.aggregates.some(
    (aggregate) => aggregate.id === trace.streamId,
  );
  return {
    kind: 'events',
    session,
    generation: subscribe.generation,
    cursor: listing.length + transcript.length,
    events: [
      ...listing.map((event) => ({
        _tag: 'event' as const,
        read: 'listing' as const,
        event,
      })),
      ...(named
        ? transcript.map((event) => ({
            _tag: 'event' as const,
            read: 'aggregate' as const,
            event,
          }))
        : []),
    ],
    chunks: [],
    local: { self: [], heldBy: [], unreadable: [] },
    host: null,
    replayComplete: true,
  };
}
