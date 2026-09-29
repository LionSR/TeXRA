/**
 * The version registry of the session store's row kinds
 * (`.agents/docs/proposed/architecture/2026-09-28-storage-v1-design.md` §3).
 * Each kind the store holds carries the version this build writes and the
 * adjacent upcasters that bring an older stored version to it; the row codec
 * (`src/controllers/session/rowCodec.ts`) is the one reader of both.
 *
 * A row is always written at its kind's current version. A lower stored
 * version is upcast step by step and then parsed with the current arm; a
 * higher one, or a kind this registry lacks, blocks its aggregate and is
 * never rewritten.
 *
 * Before the 1.0 release every kind is unreleased: its shape may change with
 * no upcaster and no bump, and no upcaster exists yet.
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
  /** The payload field whose `{ digest, value }` lives in the `blob` table. */
  readonly blob?: 'payload';
}

const V1 = { version: 1, upcast: [] } as const satisfies RowKind;

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
  'output.produced': V1,
  'run.fact': V1,
  'child.park': V1,
  'run.removed': V1,
  'run.description': V1,
  'plugin.fact': V1,
  inquiryThreadUpdated: V1,
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
  'workflow.plan': V1,
  'workflow.call': V1,
  usage: V1,
  'context.state': V1,
  'stream.start': V1,
  'stream.end': V1,
  'response.finalized': V1,
  domain: V1,
  'run.report': V1,
  'run.result': V1,
  'followup.closed': V1,
  'model.message': V1,
  'model.compaction': V1,
  'tool.intent': V1,
  'tool.binding': V1,
  'tool.result': V1,
  'model.retry': V1,
  'run.snapshot': V1,
  'tools.offered': V1,
  'context.blob': { ...V1, blob: 'payload' },
  'hook.outcome': V1,
  'child.turn': V1,
  'workflow.script': V1,
  'workflow.journal': V1,
  'workflow.attempt': V1,
};
