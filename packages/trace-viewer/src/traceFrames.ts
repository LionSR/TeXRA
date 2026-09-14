/**
 * An exported trace answered through the live plane's own vocabulary (PRD
 * one-fold-three-renderers, 7.1): the document already IS the run aggregate's
 * display events, so this file only splits them into the two reads a
 * `Subscribe` is answered with — the cold listing, and the named aggregate's
 * history. No synthetic envelope and no reconstruction: the export authored
 * the rows (`assembleTrace`). The document is immutable, so every `Subscribe`
 * is answered from these rows in full.
 */
import {
  aggregateId as qualifyAggregateId,
  listingTypeOf,
  referencedAggregates,
  runIdentityDisplayName,
  type DisplaySessionEvent,
} from '@shared/schemas';
import {
  emptyHostSnapshot,
  type HostSnapshot,
} from '@shared/session/hostSnapshot';
import type { EventsFrame, Subscribe } from '@shared/session/sessionFrames';
import type { TraceDocument } from '@transcript';

/** One position of the run's loop: the row the scrubber cuts the trace at. */
export type TraceStep = Extract<DisplaySessionEvent, { type: 'flow.step' }>;

/** The run's `flow.step` rows in commit order — the scrubber's positions. */
export function traceSteps(trace: TraceDocument): TraceStep[] {
  return trace.events.filter(
    (event): event is TraceStep => event.type === 'flow.step',
  );
}

/** The run's display name: the same identity rule every host's run tab
 *  labels with, so the page title and the tab cannot disagree. A document
 *  with no creation row folds to nothing, so its id is all there is to name. */
export function traceDisplayName(trace: TraceDocument): string {
  const start = trace.events.find(
    (event): event is Extract<DisplaySessionEvent, { type: 'run.start' }> =>
      event.type === 'run.start',
  );
  return start ? runIdentityDisplayName(start.identity) : trace.runId;
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
 * listing facts, the whole aggregate when the subscriber named the run, the
 * marker, an empty local snapshot, and the trace's host snapshot. A trace has
 * no tail.
 *
 * `cut` is the scrubber's position: the index of the `flow.step` the view is
 * read at, `null` for the whole document. A cut is a commit — the prefix the
 * live plane would have delivered at that moment — so the phase, the progress
 * counters and the transcript are all the fold's own reading at step k, with
 * no separate rule per tier.
 *
 * Sending the listing facts on both reads mirrors the live reader
 * (`sessionInputs.ts`): `foldDurable` orders listing facts by commit per
 * (aggregate, listing type), so the second delivery of a row changes nothing.
 */
export function traceFrame(
  trace: TraceDocument,
  session: string,
  subscribe: Subscribe,
  cut: number | null = null,
): EventsFrame {
  const step = cut === null ? undefined : traceSteps(trace)[cut];
  const events =
    step === undefined
      ? trace.events
      : trace.events.filter((event) => event.commit <= step.commit);
  const named = subscribe.aggregates.some(
    (aggregate) => aggregate.id === qualifyAggregateId('run', trace.runId),
  );
  const listing = events.filter((event) => listingTypeOf(event) !== null);
  const checkedAggregateIds = [
    ...new Set(listing.flatMap(referencedAggregates)),
  ];
  return {
    kind: 'events',
    session,
    generation: subscribe.generation,
    cursor: events.at(-1)?.commit ?? 0,
    events: [
      ...listing.map((event) => ({
        _tag: 'event' as const,
        read: 'listing' as const,
        event,
      })),
      ...(named
        ? events.map((event) => ({
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
