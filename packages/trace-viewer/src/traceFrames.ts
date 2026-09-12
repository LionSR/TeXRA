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
  AgentCategory,
  AgentConfigFieldsSchema,
  emptyRunEndOutput,
  runIdentityDisplayName,
  USER_FOLLOW_UP_SUPPORT,
  type DisplaySessionEvent,
  type DisplaySessionEventDraft,
} from '@shared/schemas';
import {
  emptyHostSnapshot,
  type HostSnapshot,
} from '@shared/session/hostSnapshot';
import type { EventsFrame, Subscribe } from '@shared/session/sessionFrames';
import type { TraceDocument } from '@transcript';

/** The run's display name: the same identity rule every host's run tab
 *  labels with, so the page title and the tab cannot disagree. */
export function traceDisplayName(trace: TraceDocument): string {
  return runIdentityDisplayName(trace.meta.identity);
}

/** The listing facts of the run, in publish order, without envelopes. */
function listingBodies(trace: TraceDocument): DisplaySessionEventDraft[] {
  const { meta, runId } = trace;
  const agentConfig =
    'agentCategory' in trace.config ? trace.config : undefined;
  const identity = meta.identity;
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
  if (meta.description !== null) {
    bodies.push({
      type: 'run.description',
      aggregateId: qualifyAggregateId('run', runId),
      description: meta.description,
    });
  }
  // `meta.outcome` is the one terminal fact the document carries; a trace
  // with none folds as interrupted: an exported file has no producer that
  // could still be running it.
  const { outcome } = meta;
  if (outcome !== null) {
    // `run.end` carries the outcome but no run window; the activation is what
    // opens it, so the folded view reads its `runStartedAt` from this row's
    // stamp (the trace's first entry). It leads the facts it activated: an
    // activation resets the run's progress counters.
    bodies.push({
      type: 'run.activate',
      aggregateId: qualifyAggregateId('run', runId),
      category,
      isRemote: false,
    });
  }
  bodies.push(
    {
      type: 'conversation.progress',
      aggregateId: qualifyAggregateId('run', runId),
      progress: meta.conversationProgress,
    },
    {
      type: 'usage',
      aggregateId: qualifyAggregateId('run', runId),
      runId,
      usage: meta.usage,
    },
    {
      type: 'addOutputFiles',
      aggregateId: qualifyAggregateId('run', runId),
      filesByRound: meta.outputs,
    },
    {
      type: 'updateMissingOutputs',
      aggregateId: qualifyAggregateId('run', runId),
      filesByRound: meta.missingOutputs,
    },
    {
      type: 'updateCompileFailures',
      aggregateId: qualifyAggregateId('run', runId),
      filesByRound: meta.compileFailures,
    },
  );
  if (category === AgentCategory.ToolUse) {
    bodies.push(
      {
        type: 'updateTodos',
        aggregateId: qualifyAggregateId('run', runId),
        todos: meta.todos,
      },
      {
        type: 'updatePlan',
        aggregateId: qualifyAggregateId('run', runId),
        plan: meta.plan,
      },
    );
  }
  if (outcome !== null) {
    bodies.push({
      type: 'run.end',
      aggregateId: qualifyAggregateId('run', runId),
      outcome,
      output: emptyRunEndOutput(category),
    });
  }
  return bodies;
}

/**
 * The events of one trace: listing rows, then the transcript rows, one
 * aggregate (the run), seq in publish order, commit equal to seq. The
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
 * listing, the transcript rows of the run when the subscriber named it,
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
