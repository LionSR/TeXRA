/**
 * The version registry of the session store's row kinds. Each kind the
 * store holds carries the version this build writes and the adjacent
 * upcasters that bring an older stored version to it; the session store's
 * row codec is the one reader of both.
 *
 * A row is always written at its kind's current version. A lower stored
 * version is upcast step by step and then parsed with the current arm; a
 * higher one, or a kind this registry lacks and never retired, refuses the
 * whole store (`storeGate`) and is never rewritten.
 *
 * The release watermark is the schemas frozen at a release: a
 * version frozen there never changes in place. Before 1.0 a kind changes with
 * no upcaster; its version is bumped when an older build's row would read
 * wrong (or fail): such a row then reads as an earlier build's
 * (`DatabaseRowEarlier`, its whole run listed as written by an earlier
 * build), never as damaged or silently stripped.
 */
// The frozen schemas live in `config/storage/frozen/`, written by
// `npm run storage:freeze` at a release and checked by `rowVersions.vitest.ts`.
import type { JsonValue } from './jsonValue';
import type { SessionEventDraft } from './sessionEvent';

interface RowKind {
  /** The version this build writes. */
  readonly version: number;
  /** `upcast[i]` maps stored version `i + 1` to `i + 2`, over plain JSON. */
  readonly upcast: readonly ((data: {
    readonly [field: string]: JsonValue;
  }) => {
    readonly [field: string]: JsonValue;
  })[];
}

const V1 = { version: 1, upcast: [] } as const satisfies RowKind;

/**
 * The row kinds this build deleted from `ROW_KINDS`. A store that holds one
 * is not a newer build's: its rows fail the reads of their own run
 * (`DatabaseRowCorrupt`) and the rest of the store opens. A kind moves here
 * from `ROW_KINDS` in the change that deletes it; every kind ever stored is
 * listed in `config/storage/row-kinds-ever.json`, which never shrinks.
 */
export const RETIRED_ROW_KINDS: ReadonlySet<string> = new Set<string>([
  'inquiryThreadUpdated',
  'model.compaction',
  'model.retry',
  'output.produced',
  'run.snapshot',
  'tool.binding',
  'workflow.attempt',
  'workflow.call',
  'workflow.journal',
  'workflow.plan',
  'workflow.script',
]);

/** The lowest stored version of a plugin arm's value this build reads: an
 *  older one has no upcaster here, so an earlier build wrote it. The store
 *  (`decodeRow`, `earlierRuns`) and an imported trace refuse it alike. */
export const pluginFactFloor = (arm: {
  readonly version: number;
  readonly upcasters: readonly unknown[];
}): number => arm.version - arm.upcasters.length;

/** The version every current-value family writes and reads
 *  (each `ValueFamily`), until one gains an upcaster. */
export const CURRENT_VALUE_VERSION = 1;

/** Every arm of `SessionEventDraftSchema`: a new arm without an entry does
 *  not compile. */
export const ROW_KINDS: Readonly<Record<SessionEventDraft['type'], RowKind>> = {
  'run.start': V1,
  'run.activate': V1,
  // v2: a recipe's script names its block and options; `toolConfig` is
  // gone (no upcaster: an earlier build's v1 row refuses its run as written
  // by that build, rather than launching with its options dropped).
  // v3: a script's handed-down call commits in the run's opening batch (no
  // upcaster: a v2 script run cut before its handed-down row would resume
  // into a model call instead of its script).
  'run.config': { version: 3, upcast: [] },
  'run.model': V1,
  'run.detach': V1,
  // v2: a recipe's value is `structured`, with no `documents` (no upcaster,
  // as `run.config`).
  'run.end': { version: 2, upcast: [] },
  'conversation.progress': V1,
  'run.fact': V1,
  'child.park': V1,
  'run.removed': V1,
  'run.description': V1,
  'plugin.fact': V1,
  'followup.queued': V1,
  'followup.consumed': V1,
  // v2: a task proposal carries its plugin's `options`, not `toolConfig`
  // (no upcaster, as `run.config`).
  'request.opened': { version: 2, upcast: [] },
  'request.decided': V1,
  'approval.policy': V1,
  'run.position': V1,
  // v2: no `latexdiff` or `missingOutputs` message type; the documents
  // plugin's fact holds both (no upcaster, as `run.config`).
  log: { version: 2, upcast: [] },
  // v2: no `phase` kind and no `index`/`total` (no upcaster, as
  // `run.config`: an earlier build's workflow phase stage would fail its
  // run as damaged rather than read as that build's).
  'stage.start': { version: 2, upcast: [] },
  'stage.end': V1,
  // v2: a tool's card is stated (`card`), not derived from its name, so the
  // fold has no Codex builders (no upcaster, as `run.config`: an earlier
  // build's card would read without its sections).
  'tool.start': { version: 2, upcast: [] },
  'tool.end': V1,
  usage: V1,
  'context.state': V1,
  'stream.start': V1,
  'stream.end': V1,
  'response.finalized': V1,
  'run.report': V1,
  // v2: no `cliWorkflow` producer and no delivery-time diffs (no upcaster,
  // as `run.config`).
  'run.result': { version: 2, upcast: [] },
  'followup.closed': V1,
  // v2: dispatch facts record `lane`, not `parallelSafe` (no upcaster: an
  // earlier build's v1 row refuses its run as written by that build).
  // v3: dispatch facts carry no `ordinal` (a call's place is its index) and
  // no `stageId` (no upcaster, as v2).
  // v4: stateless Google responses may have a null provider ID. Older builds
  // must refuse the newer store rather than parse those rows as corrupt.
  'model.message': { version: 4, upcast: [] },
  'context.edit': V1,
  'tool.intent': V1,
  'script.call': V1,
  'tool.result': V1,
  'tools.offered': V1,
  'context.blob': V1,
  'hook.outcome': V1,
  'child.turn': V1,
};
