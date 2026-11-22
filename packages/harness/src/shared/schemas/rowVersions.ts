/**
 * The registry of the session store's row kinds. Each kind the store holds
 * carries the version this build writes and reads, and where the listing
 * keeps its newest row. The session store's row codec is the one reader of
 * the version; `listingTypeOf` reads the listing class.
 *
 * A row is always written at its kind's current version, and read at that
 * version only: a lower stored version is an earlier build's row
 * (`DatabaseRowEarlier`, its whole run listed as written by an earlier
 * build), never damaged or silently stripped; a higher one, or a kind this
 * registry lacks and never retired, refuses the whole store (`storeGate`)
 * and is never rewritten. A kind's version is bumped when an older build's
 * row would read wrong (or fail). Nothing converts a stored row: the first
 * released version that must stay readable across a change brings the
 * first upcaster with it.
 *
 * The release watermark is the schemas frozen at a release: a version
 * frozen there never changes in place.
 */
// The frozen schemas live in `config/storage/frozen/`, written by
// `npm run storage:freeze` at a release and checked by `rowVersions.vitest.ts`.
import type { SessionRowDraft } from './sessionEvent';

interface RowKind {
  /** The version this build writes and reads. */
  readonly version: number;
  /**
   * Where the listing keeps the kind's newest row: under the kind's own
   * type, under a key shared with the rows that update the same thing, or
   * nowhere. The request pair updates one set and the follow-up pair
   * another; the lifecycle pair (`run.start`, `run.removed`) updates one
   * existence, so a deletion marker's commit outranks a replayed
   * `run.start` below it, which makes the marker final under every read.
   * The run history and the transcript tier but `context.state` (the
   * run's context gauge, read from its newest row) are listed nowhere: a
   * cold initial load would pull the newest one of every run into every
   * renderer for no reader. `run.position` is listed: the phase is read
   * from it, so a listing without it would paint every waiting run as
   * ready.
   */
  readonly listing: 'none' | 'own' | 'request' | 'followup' | 'lifecycle';
}

const V1 = { version: 1 } as const;

/**
 * The row kinds this build deleted from `ROW_KINDS`, each with what its rows
 * fed. A store that holds one is not a newer build's, and the rest of the
 * store opens. A `display` row fed only what a view showed: it is skipped on
 * read (logged once) and its run resumes, since no decision of the run was
 * made from it. An `execution` row fed a decision the run made (its
 * context, a retry permit, a request, its result): its run reads as an
 * earlier build's (`DatabaseRowEarlier`), shown read-only, since resuming
 * without it would continue from a different state. A kind moves here from
 * `ROW_KINDS` in the change that deletes it; every kind ever stored is
 * listed in `config/storage/row-kinds-ever.json`, which never shrinks.
 */
export const RETIRED_ROW_KINDS: ReadonlyMap<string, 'display' | 'execution'> =
  new Map([
    // A completed turn's tool-call count, which only the view showed.
    ['conversation.progress', 'display'],
    // A run's model switch, projected from the `run.config` that carries it.
    ['run.model', 'display'],
    // An external inquiry thread's state: an open request.
    ['inquiryThreadUpdated', 'execution'],
    // A compaction of the model context.
    ['model.compaction', 'execution'],
    // The human retry permit a restart read back.
    ['model.retry', 'execution'],
    // A document round's outputs: the run's files.
    ['output.produced', 'execution'],
    // A child's parent edge severed by its parent's stop, which decided
    // where its end delivered and the grants it kept.
    ['run.detach', 'execution'],
    // A goal run's plan.
    ['run.fact', 'execution'],
    // The loop state a resume continued from.
    ['run.snapshot', 'execution'],
    // A child's turns, waits and result manifest, which its resume and its
    // parent's call read: a child is a run that ends, its `run.end` the
    // result.
    ['child.turn', 'execution'],
    ['child.park', 'execution'],
    ['run.result', 'execution'],
    // An approval request's binding to its tool call.
    ['tool.binding', 'execution'],
    // The script engine's journal, plan, script, calls and attempts.
    ['workflow.attempt', 'execution'],
    ['workflow.call', 'execution'],
    ['workflow.journal', 'execution'],
    ['workflow.plan', 'execution'],
    ['workflow.script', 'execution'],
  ]);

/** Plugin fact kinds a built-in plugin wrote before this build retired
 *  them, by `plugin/kind`: a row of one is an earlier build's, refused by
 *  the store (`factKindOf`) and an imported trace alike, never read
 *  unavailable, since its plugin is loaded. */
export const RETIRED_PLUGIN_FACTS: ReadonlySet<string> = new Set([
  'goal/state',
]);

/** Why a plugin fact is read uninterpreted: no plugin of this process
 *  registers its kind. Its row stays as written; the store and an imported
 *  trace read it with this reason (`unavailable`), its value and version
 *  unchanged, and a run holding one does not resume here. */
export const unavailableFactReason = (fact: {
  readonly plugin: string;
  readonly kind: string;
}): string =>
  `Plugin "${fact.plugin}" is unavailable: nothing loaded here registers its fact kind ${fact.kind}, so the fact is kept as written and not interpreted.`;

/** The version every current-value family writes and reads
 *  (each `ValueFamily`). */
export const CURRENT_VALUE_VERSION = 1;

/** Every arm of `SessionRowDraftSchema`: a new arm without an entry, its
 *  version and its listing class, does not compile. */
export const ROW_KINDS: Readonly<Record<SessionRowDraft['type'], RowKind>> =
  Object.freeze({
    'run.start': Object.freeze({ ...V1, listing: 'lifecycle' }),
    'run.activate': Object.freeze({ ...V1, listing: 'own' }),
    'run.config': Object.freeze({ ...V1, listing: 'own' }),
    'run.stop': Object.freeze({ ...V1, listing: 'own' }),
    'run.end': Object.freeze({ ...V1, listing: 'own' }),
    'run.removed': Object.freeze({ ...V1, listing: 'lifecycle' }),
    'run.description': Object.freeze({ ...V1, listing: 'own' }),
    'plugin.fact': Object.freeze({ ...V1, listing: 'own' }),
    'followup.queued': Object.freeze({ ...V1, listing: 'followup' }),
    'followup.consumed': Object.freeze({ ...V1, listing: 'followup' }),
    'request.opened': Object.freeze({ ...V1, listing: 'request' }),
    'request.decided': Object.freeze({ ...V1, listing: 'request' }),
    'approval.policy': Object.freeze({ ...V1, listing: 'own' }),
    'run.position': Object.freeze({ ...V1, listing: 'own' }),
    log: Object.freeze({ ...V1, listing: 'none' }),
    'stage.start': Object.freeze({ ...V1, listing: 'none' }),
    'stage.end': Object.freeze({ ...V1, listing: 'none' }),
    'tool.start': Object.freeze({ ...V1, listing: 'none' }),
    'tool.end': Object.freeze({ ...V1, listing: 'none' }),
    usage: Object.freeze({ ...V1, listing: 'none' }),
    'context.state': Object.freeze({ ...V1, listing: 'own' }),
    'stream.start': Object.freeze({ ...V1, listing: 'none' }),
    'stream.end': Object.freeze({ ...V1, listing: 'none' }),
    'response.finalized': Object.freeze({ ...V1, listing: 'none' }),
    'run.report': Object.freeze({ ...V1, listing: 'own' }),
    'process.output': Object.freeze({ ...V1, listing: 'none' }),
    'process.exit': Object.freeze({ ...V1, listing: 'own' }),
    'followup.closed': Object.freeze({ ...V1, listing: 'own' }),
    'model.message': Object.freeze({ ...V1, listing: 'none' }),
    'context.edit': Object.freeze({ ...V1, listing: 'none' }),
    'tool.intent': Object.freeze({ ...V1, listing: 'none' }),
    'script.call': Object.freeze({ ...V1, listing: 'none' }),
    'tool.result': Object.freeze({ ...V1, listing: 'none' }),
    'tools.offered': Object.freeze({ ...V1, listing: 'none' }),
    // The recorded request a blob holds is part of this kind's shape, its
    // controls as each protocol prepares them: a resumed background turn is
    // rebuilt from it, so a change to it is a version, never only new
    // digests (`rowVersions.vitest.ts` holds it at a release).
    'context.blob': Object.freeze({ ...V1, listing: 'none' }),
    'hook.outcome': Object.freeze({ ...V1, listing: 'none' }),
  });

/**
 * The listing type the fold keys `latest` by, from the kind's listing class,
 * or null for a kind the listing leaves out. `plugin.fact` holds several
 * kinds on one type, so it is read grouped by kind as well (`listingKeyOf`,
 * `Database`).
 */
export function listingTypeOf(
  event: Pick<SessionRowDraft, 'type'>,
): string | null {
  const { listing } = ROW_KINDS[event.type];
  if (listing === 'none') return null;
  return listing === 'own' ? event.type : listing;
}
