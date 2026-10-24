/**
 * The external-inquiry plugin's rows (its `arms`, `@tools/plugins`): each thread is an aggregate the plugin owns,
 * `('plugin', 'external-inquiry:<threadId>')`, and its latest `plugin.fact`
 * of kind `thread` is the summary the Background Tasks panel lists under the
 * run that asked, the row's `parent`. The thread's full record stays in the
 * global database (`InquiryRecords`); this row only displays it. Core folds
 * the row without reading it (`SessionView.pluginFacts`); this module is its
 * schema, its writer and its one reader, beside the service over the
 * thread records. Browser-safe: it imports only schemas, `zod` and `effect`.
 */
import { Context, type Effect, Result, Schema, Struct } from 'effect';

import {
  ExternalInquiryTurnRecordSchema,
  InquiryThreadIdSchema,
  RunIdSchema,
  type InquiryThreadId,
  type JsonValue,
  type RunId,
  type ToolFact,
} from '@texra-ai/harness/schemas';
import type { ValueFamily } from '@texra-ai/harness';
import type { SessionView } from '@texra-ai/harness/schemas';

const InquiryThreadStatusSchema = Schema.Literals([
  'open',
  'answered',
  'dropped',
]);
/** Where a thread stands: awaiting an answer, answered, or dropped. */
type InquiryThreadStatus = typeof InquiryThreadStatusSchema.Type;

/** A thread as a list shows it: its status, last question and turn count. */
const InquiryThreadSummarySchema = Schema.Struct({
  threadId: InquiryThreadIdSchema,
  /** The run the last question was asked under; continuations flow back to it. */
  parentRunId: Schema.NullOr(RunIdSchema),
  status: InquiryThreadStatusSchema,
  lastQuestionPreview: Schema.String,
  lastActivityIso:
    Schema.String /* TODO(effect-schema): z.iso.datetime; was `z.iso.datetime()` */,
  turnCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
/** A thread as a list shows it. */
export type InquiryThreadSummary = typeof InquiryThreadSummarySchema.Type;

/** An open turn's unsent answer, as its panel keeps it between renders. */
export const InquiryDraftSchema = Schema.Struct({
  answer: Schema.String,
  sessionLinks: Schema.String,
});
/** An open turn's unsent answer. */
export type InquiryDraft = typeof InquiryDraftSchema.Type;

/** A thread's full record: its turns, explicit `status` and the asking run. */
const InquiryThreadRecordSchema = Schema.Struct({
  threadId: InquiryThreadIdSchema,
  /** The run the last question was asked under; a continuation is addressed
   *  to it. Kept beside the row's `parent` edge because the global record
   *  spans projects, and listing a run's threads reads it here. */
  parentRunId: Schema.NullOr(RunIdSchema),
  status: InquiryThreadSummarySchema.fields.status,
  createdAt: Schema.String.check(Schema.isMinLength(1)),
  updatedAt: Schema.String.check(Schema.isMinLength(1)),
  turns: Schema.Array(ExternalInquiryTurnRecordSchema),
});
/** A thread's full record, as the global database stores it. */
export type InquiryThreadRecord = typeof InquiryThreadRecordSchema.Type;

/** The thread records, in the global database's current values and keyed by
 *  thread id, so a follow-up from another project still reaches its thread.
 *  Named as the plugin's own row kind is (`external-inquiry/thread`). */
export const INQUIRY_THREADS: ValueFamily<InquiryThreadRecord> = {
  name: 'external-inquiry/thread',
  schema: InquiryThreadRecordSchema,
  deletable: false,
};

/** The row's value: the summary less its asking run, which is the row's
 *  `parent` edge and has no second copy. */
const InquiryThreadRowSchema = InquiryThreadSummarySchema.mapFields(
  Struct.omit(['parentRunId']),
);

/** A thread row as the transition rule reads it. */
interface ThreadRow {
  readonly value: JsonValue;
  readonly parent: RunId | null;
}

/**
 * Refuse a thread row its latest row does not admit, so a delayed or
 * replayed update can neither regress the thread nor move it to an earlier
 * asker. Only a reopen of an answered thread (a new turn) changes parents.
 */
function admitsThreadRow(
  previous: ThreadRow | undefined,
  next: ThreadRow,
): string | null {
  const after = Schema.decodeUnknownResult(InquiryThreadRowSchema)(next.value);
  if (!Result.isSuccess(after)) return 'Unreadable inquiry thread row';
  if (previous === undefined) return null;
  const before = Schema.decodeUnknownResult(InquiryThreadRowSchema)(
    previous.value,
  );
  if (!Result.isSuccess(before))
    return `Unreadable inquiry history: ${after.success.threadId}`;
  const was = before.success;
  const now = after.success;
  const reopened = was.status === 'answered' && now.status === 'open';
  if (now.turnCount < was.turnCount)
    return `Inquiry update must preserve turn order: ${now.threadId}`;
  if (reopened && now.turnCount <= was.turnCount)
    return `Inquiry reopen must advance the turn: ${now.threadId}`;
  if (previous.parent !== next.parent && !reopened)
    return `Only an answered inquiry can change parents: ${now.threadId}`;
  if (
    was.status === 'open' &&
    now.status === 'open' &&
    was.turnCount !== now.turnCount
  )
    return `An open inquiry cannot start another turn: ${now.threadId}`;
  if (was.status === 'dropped' && now.status !== 'dropped')
    return `A dropped inquiry cannot reopen: ${now.threadId}`;
  return null;
}

/** A thread's latest row supersedes a call's lagging `next` when the turn
 *  `next` opens was already closed (answered or dropped) or passed. */
function supersedesThreadRow(latest: ThreadRow, next: ThreadRow): boolean {
  const was = Schema.decodeUnknownResult(InquiryThreadRowSchema)(latest.value);
  const now = Schema.decodeUnknownResult(InquiryThreadRowSchema)(next.value);
  if (!Result.isSuccess(was) || !Result.isSuccess(now)) return false;
  return (
    was.success.turnCount > now.success.turnCount ||
    (was.success.turnCount === now.success.turnCount &&
      was.success.status !== 'open' &&
      now.success.status === 'open')
  );
}

/** The external-inquiry plugin's one row kind. */
export const EXTERNAL_INQUIRY_THREAD_ARM = {
  plugin: 'external-inquiry',
  kind: 'thread',
  version: 1,
  schema: InquiryThreadRowSchema,
  upcasters: [],
  admits: admitsThreadRow,
  supersedes: supersedesThreadRow,
} as const;

/** The fact that makes `summary` its thread's displayed state: an `ask`
 *  states it in its call's result, so it commits with the `tool.result`.
 *  The aggregate key carries the plugin's id, so no other plugin's key can
 *  collide with a thread's. */
export function inquiryThreadFact(
  summary: InquiryThreadSummary,
): ToolFact & { readonly aggregate: string } {
  const { parentRunId: _, ...value } = summary;
  return {
    plugin: EXTERNAL_INQUIRY_THREAD_ARM.plugin,
    kind: EXTERNAL_INQUIRY_THREAD_ARM.kind,
    version: EXTERNAL_INQUIRY_THREAD_ARM.version,
    value: Schema.decodeUnknownSync(InquiryThreadRowSchema)(value),
    aggregate: `${EXTERNAL_INQUIRY_THREAD_ARM.plugin}:${summary.threadId}`,
  };
}

/** The threads asked under `runId`, as their latest rows state them. */
export function inquiryThreadsUnder(
  view: Pick<SessionView, 'pluginFacts'>,
  runId: RunId,
): InquiryThreadSummary[] {
  return view.pluginFacts.flatMap((fact) =>
    fact.plugin === EXTERNAL_INQUIRY_THREAD_ARM.plugin &&
    fact.kind === EXTERNAL_INQUIRY_THREAD_ARM.kind &&
    fact.parent === runId
      ? [
          {
            ...Schema.decodeUnknownSync(InquiryThreadRowSchema)(fact.value),
            parentRunId: runId,
          },
        ]
      : [],
  );
}

/** The canonical thread records in the global database, independent of
 *  any project's display lifetime (`@texra/tools/inquiry/inquiryRecords`). */
export class InquiryRecords extends Context.Service<
  InquiryRecords,
  {
    readonly recordOpenQuestion: (params: {
      threadId?: InquiryThreadId;
      /** The asking run; continuations flow back to it. */
      parentRunId: RunId;
      question: string;
      context?: string;
      suggestSearch?: boolean;
      attachFiles?: string[];
    }) => Effect.Effect<InquiryThreadRecord, Error>;
    readonly recordAnswerForOpenTurn: (params: {
      threadId: InquiryThreadId;
      turnIndex: number;
      answer: string;
      sessionLinks?: string[] | null;
    }) => Effect.Effect<InquiryThreadRecord | null, Error>;
    readonly markDropped: (params: {
      threadId: InquiryThreadId;
      turnIndex: number;
    }) => Effect.Effect<InquiryThreadRecord | null, Error>;
    readonly readExternalInquiryThread: (
      threadId: string,
    ) => Effect.Effect<InquiryThreadRecord | null, Error>;
    readonly getThreadSummary: (
      threadId: InquiryThreadId,
    ) => Effect.Effect<InquiryThreadSummary | null, Error>;
    readonly listThreadsByStatus: (params: {
      status: InquiryThreadStatus | 'any';
      /** `'run'` narrows to `runId`'s own threads; `'all'` spans every run. */
      scope: 'run' | 'all';
      runId?: RunId;
      limit?: number;
    }) => Effect.Effect<InquiryThreadSummary[], Error>;
  }
>()('@texra/InquiryRecords') {}
