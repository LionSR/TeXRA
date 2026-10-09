/**
 * The version registry of the session store's row kinds
 * (`.agents/docs/proposed/architecture/2026-09-28-storage-v1-design.md` §3).
 * Each kind the store holds carries the version this build writes and the
 * adjacent upcasters that bring an older stored version to it; the row codec
 * (`packages/harness/src/controllers/session/rowCodec.ts`) is the one reader of both.
 *
 * A row is always written at its kind's current version. A lower stored
 * version is upcast step by step and then parsed with the current arm; a
 * higher one, or a kind this registry lacks and never retired, refuses the
 * whole store (`storeGate`) and is never rewritten.
 *
 * The release watermark is the frozen schemas, `config/storage/frozen/`
 * (`npm run storage:freeze` at a release; `rowVersions.vitest.ts`): a
 * version frozen there never changes in place. Before the 1.0 release every
 * kind is unreleased: its shape may change with no upcaster and no bump, and
 * no upcaster exists yet.
 */
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

/** The version every current-value family writes and reads
 *  (each `ValueFamily`), until one gains an upcaster. */
export const CURRENT_VALUE_VERSION = 1;

/** Every arm of `SessionEventDraftSchema`: a new arm without an entry does
 *  not compile. */
export const ROW_KINDS: Readonly<Record<SessionEventDraft['type'], RowKind>> = {
  'run.start': V1,
  'run.activate': V1,
  'run.config': V1,
  'run.model': V1,
  'run.detach': V1,
  'run.end': V1,
  'conversation.progress': V1,
  'run.fact': V1,
  'child.park': V1,
  'run.removed': V1,
  'run.description': V1,
  'plugin.fact': V1,
  'followup.queued': V1,
  'followup.consumed': V1,
  'request.opened': V1,
  'request.decided': V1,
  'approval.policy': V1,
  'run.position': V1,
  log: V1,
  'stage.start': V1,
  'stage.end': V1,
  'tool.start': V1,
  'tool.end': V1,
  usage: V1,
  'context.state': V1,
  'stream.start': V1,
  'stream.end': V1,
  'response.finalized': V1,
  'run.report': V1,
  'run.result': V1,
  'followup.closed': V1,
  // v2: dispatch facts record `lane`, not `parallelSafe` (no upcaster: an
  // earlier build's v1 row refuses its run as written by that build).
  'model.message': { version: 2, upcast: [] },
  'context.edit': V1,
  'tool.intent': V1,
  'script.call': V1,
  'tool.result': V1,
  'tools.offered': V1,
  'context.blob': V1,
  'hook.outcome': V1,
  'child.turn': V1,
};
