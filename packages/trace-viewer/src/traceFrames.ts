/**
 * An exported trace as the session plane would have carried it (PRD
 * one-fold-three-renderers, 7.1): the listing facts of one finished run
 * and its transcript rows, stamped with a synthetic envelope so the same
 * fold the live hosts run folds them to the same view. The document is
 * immutable, so every `Subscribe` is answered from these rows in full.
 */
import {
  aggregateId as qualifyAggregateId,
  referencedAggregates,
  RunIdSchema,
  AgentCategory,
  AgentConfigFieldsSchema,
  runIdentityDisplayName,
  STREAM_LOG_ENTRY_TYPES,
  RUN_PHASE,
  USER_FOLLOW_UP_SUPPORT,
  type RunIdentity,
  type DisplaySessionEvent,
  type DisplaySessionEventDraft,
  type RunPhase,
} from '@shared/schemas';
import {
  emptyHostSnapshot,
  type HostSnapshot,
} from '@shared/session/hostSnapshot';
import type { EventsFrame, Subscribe } from '@shared/session/sessionFrames';
import { isTerminalOutcomePhase } from '@shared/runs/runStatus';
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
 * carries; failing that, the persisted transcript's last terminal root group
 * row decides, then the snapshot status. Every one of those is a canonical
 * `RunPhase`. A trace with no terminal fact folds as interrupted: an
 * exported file has no producer that could still be running it.
 */
function traceOutcome(trace: TraceDocument): RunPhase | null {
  if (trace.meta.outcome) return trace.meta.outcome;
  const rootStageId = findRootStageId(trace.entries);
  for (const entry of trace.entries.toReversed()) {
    if (entry.type !== STREAM_LOG_ENTRY_TYPES.GROUP_END) continue;
    if (entry.groupId !== undefined) continue;
    const kind = entry.data.kind;
    if (kind !== undefined) {
      if (NESTED_STAGE_KINDS.has(kind)) continue;
    } else if (entry.id !== rootStageId) {
      // Untagged: only the entry at the root stage's fixed position can be the
      // run's own GROUP_END; anything else sharing the "no parent" shape is a
      // nested round, phase, or session.
      continue;
    }
    const { status } = entry.data;
    if (status !== undefined) return status;
  }
  const status = trace.snapshot.status;
  return status !== undefined && isTerminalOutcomePhase(status) ? status : null;
}

/** The run's display name: the same identity rule every host's stream tab
 *  labels with, so the page title and the tab cannot disagree. */
export function traceDisplayName(trace: TraceDocument): string {
  return runIdentityDisplayName(trace.meta.identity);
}

/** The listing facts of the run, in publish order, without envelopes. */
function listingBodies(trace: TraceDocument): DisplaySessionEventDraft[] {
  const { snapshot, runId } = trace;
  const agentConfig =
    'agentCategory' in trace.config ? trace.config : undefined;
  const identity = trace.meta.identity;
  // Workflow-shaped for workflow agents and multi-agent-workflow containers
  // (both have round outputs); everything else renders the tool-use shape.
  const category =
    agentConfig?.agentCategory === AgentCategory.Workflow ||
    identity.kind === 'multiAgentWorkflow'
      ? AgentCategory.Workflow
      : AgentCategory.ToolUse;
  const bodies: DisplaySessionEventDraft[] = [
    {
      type: 'run.start',
      aggregateId: qualifyAggregateId('run', runId),
      identity,
      userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
      category,
      isRemote: false,
      worktree: null,
      parent: null,
    },
  ];
  if (agentConfig) {
    bodies.push({
      type: 'run.config',
      aggregateId: qualifyAggregateId('run', runId),
      config: agentConfig,
    });
  } else if ('name' in trace.config) {
    // Process and workflow-container exports persist a non-agent RunRecord
    // (name/instruction/model, no agentCategory). Project that into the
    // durable config arm the fold already reads for `command` / `model`.
    const processConfig = trace.config;
    bodies.push({
      type: 'run.config',
      aggregateId: qualifyAggregateId('run', runId),
      config: AgentConfigFieldsSchema.parse({
        agentCategory: AgentCategory.ToolUse,
        agent: processConfig.name,
        instruction: processConfig.instruction,
        ...(processConfig.model === undefined
          ? {}
          : { model: processConfig.model }),
        ...(processConfig.workingDirectory === undefined
          ? {}
          : { workingDirectory: processConfig.workingDirectory }),
      }),
    });
  }
  if (trace.meta.description) {
    bodies.push({
      type: 'updateRunDescription',
      aggregateId: qualifyAggregateId('run', trace.runId),
      description: trace.meta.description,
    });
  }
  if (snapshot.conversationProgress) {
    bodies.push({
      type: 'conversation.progress',
      aggregateId: qualifyAggregateId('run', trace.runId),
      progress: snapshot.conversationProgress,
    });
  }
  for (const [usageRunId, usage] of Object.entries(snapshot.runUsage)) {
    bodies.push({
      type: 'usage',
      aggregateId: qualifyAggregateId('run', runId),
      runId: RunIdSchema.parse(usageRunId),
      usage,
    });
  }
  if (category === AgentCategory.Workflow) {
    bodies.push(
      {
        type: 'addOutputFiles',
        aggregateId: qualifyAggregateId('run', trace.runId),
        filesByRound: snapshot.outputFilesByRound,
      },
      {
        type: 'updateMissingOutputs',
        aggregateId: qualifyAggregateId('run', trace.runId),
        filesByRound: snapshot.missingOutputsByRound,
      },
      {
        type: 'updateCompileFailures',
        aggregateId: qualifyAggregateId('run', trace.runId),
        filesByRound: snapshot.compileFailuresByRound,
      },
    );
  } else {
    bodies.push(
      {
        type: 'updateTodos',
        aggregateId: qualifyAggregateId('run', trace.runId),
        todos: snapshot.todos,
      },
      {
        type: 'updatePlan',
        aggregateId: qualifyAggregateId('run', trace.runId),
        plan: snapshot.plan,
      },
    );
  }
  const outcome = traceOutcome(trace);
  if (outcome !== null && isTerminalOutcomePhase(outcome)) {
    bodies.push(
      {
        type: 'status',
        aggregateId: qualifyAggregateId('run', trace.runId),
        phase: outcome,
        previousPhase: null,
        cause: 'trace',
        substate: null,
        runStartedAt: trace.entries[0]?.timestamp ?? null,
      },
      {
        type: 'result',
        aggregateId: qualifyAggregateId('run', runId),
        outcome,
        category,
        agentName: runIdentityDisplayName(identity),
      },
    );
  }
  return bodies;
}

/**
 * The events of one trace: listing rows, then the transcript rows, one
 * aggregate (the stream), seq in publish order, commit equal to seq. The
 * viewer stamps `ownerId: null` (contract C3) because an archived export has
 * no owning process, which folds every unfinished run as interrupted and every
 * finished one as durably final.
 */
function traceEvents(trace: TraceDocument): {
  readonly listing: DisplaySessionEvent[];
  readonly transcript: DisplaySessionEvent[];
} {
  const at = trace.entries[0]?.timestamp ?? 0;
  let seq = 0;
  // The publisher's stamp (contract C2), as `DisplaySessionEventLog` would have
  // applied it: a draft is a distributive omit over the union, so the
  // spread cannot be typed back into the union without the assertion.
  const stamp = (draft: DisplaySessionEventDraft): DisplaySessionEvent => {
    seq += 1;
    return {
      ...draft,
      seq,
      commit: seq,
      ownerId: null,
      at,
    } as DisplaySessionEvent;
  };
  const listing = listingBodies(trace).map(stamp);
  const transcript = trace.entries.map((entry) =>
    stamp({
      type: 'transcript.entry',
      aggregateId: qualifyAggregateId('run', trace.runId),
      entry,
    }),
  );
  return { listing, transcript };
}

/**
 * The host snapshot of an exported trace (PRD 8.1): the run's display name
 * as the paper, no catalogs (a trace launches nothing), no banners. The
 * shell renders nothing until a host snapshot arrives, and a trace's one
 * frame is the only one it ever gets.
 */
function traceHost(trace: TraceDocument): HostSnapshot {
  const name = traceDisplayName(trace);
  return emptyHostSnapshot({
    key: trace.runId,
    name,
    initials: name.slice(0, 2).toUpperCase(),
    subtitle: 'Exported trace',
  });
}

/**
 * The one frame that answers a `Subscribe` over an exported trace: the
 * listing, the transcript rows of the stream when the subscriber named it,
 * the marker, an empty local snapshot, and the trace's host snapshot. A
 * trace has no tail.
 */
export function traceFrame(
  trace: TraceDocument,
  session: string,
  subscribe: Subscribe,
): EventsFrame {
  const { listing, transcript } = traceEvents(trace);
  const named = subscribe.aggregates.some(
    (aggregate) => aggregate.id === qualifyAggregateId('run', trace.runId),
  );
  const checkedAggregateIds = [
    ...new Set(listing.flatMap(referencedAggregates)),
  ];
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
    local: { self: [], dead: [], unreadable: [] },
    host: traceHost(trace),
    replayComplete: true,
    existence: {
      checkedAggregateIds,
      removedAggregateIds: [],
      claims: checkedAggregateIds.map((aggregateId) => ({
        aggregateId,
        ownerId: null,
      })),
    },
  };
}
