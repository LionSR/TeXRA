/**
 * The external-inquiry plugin's rows (its `arms`, `@tools/plugins`): each thread is an aggregate the plugin owns,
 * `('plugin', 'external-inquiry:<threadId>')`, and its latest `plugin.fact`
 * of kind `thread` is the summary the Background Tasks panel lists under the
 * run that asked, the row's `parent`. The thread's full record stays in the
 * global database (`InquiryRecords`); this row only displays it. Core applies
 * the row without reading it (`SessionView.pluginFacts`); this module is its
 * schema, its writer and its one reader, beside the service over the
 * thread records. Browser-safe: it imports only schemas and `effect`.
 */
import {
  Context,
  type Effect,
  Result,
  Schema,
  SchemaGetter,
  Struct,
} from 'effect';

import {
  RunIdSchema,
  type JsonValue,
  type RunId,
  type ToolFact,
} from '@texra-ai/harness/schemas';
import type { ValueFamily } from '@texra-ai/harness/host';
import type { SessionView } from '@texra-ai/harness/schemas';

/** The links a person cites beside an answer. */
const InquirySessionLinksSchema = Schema.Array(
  Schema.Trim.check(Schema.isMinLength(1)),
);

// The inquiry record service mints the 12-hex suffix. The explicit bound
// rejects truncated or extended identifiers at storage and tool-input
// boundaries.
export const InquiryThreadIdSchema = Schema.String.check(
  Schema.isPattern(/^ei_[0-9a-f]{12}$/i),
).pipe(
  Schema.decodeTo(Schema.String, {
    decode: SchemaGetter.transform((value) => value.toLowerCase()),
    encode: SchemaGetter.passthrough(),
  }),
);
export type InquiryThreadId = typeof InquiryThreadIdSchema.Type;

/** One turn of a thread, as its full record keeps it. */
const InquiryTurnBaseShape = {
  turnIndex: Schema.Int.check(Schema.isGreaterThan(0)),
  timestamp: Schema.String.check(Schema.isMinLength(1)),
  question: Schema.String,
  context: Schema.optional(Schema.NullOr(Schema.String)),
  suggestSearch: Schema.optional(Schema.NullOr(Schema.Boolean)),
  attachFiles: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
};

/** A turn awaiting the person's answer. Panel drafts belong to view state. */
const OpenInquiryTurnSchema = Schema.Struct({
  ...InquiryTurnBaseShape,
  kind: Schema.Literal('open'),
});
export type OpenInquiryTurn = typeof OpenInquiryTurnSchema.Type;

/** A turn with its answer recorded. */
const AnsweredInquiryTurnSchema = Schema.Struct({
  ...InquiryTurnBaseShape,
  kind: Schema.Literal('answered'),
  answer: Schema.String,
  answeredAt: Schema.String.check(Schema.isMinLength(1)),
  sessionLinks: Schema.optional(Schema.NullOr(InquirySessionLinksSchema)),
});
export type AnsweredInquiryTurn = typeof AnsweredInquiryTurnSchema.Type;

const InquiryTurnRecordSchema = Schema.Union([
  OpenInquiryTurnSchema,
  AnsweredInquiryTurnSchema,
]);

/**
 * What an inquiry's request holds (its `data`): the question and the thread
 * it continues. First and follow-up turns carry one field set, told apart
 * by `transcript` (the thread's turns so far, the last one this question).
 */
export const InquiryRequestSchema = Schema.Struct({
  requestId: Schema.String,
  runId: RunIdSchema,
  question: Schema.String,
  threadId: InquiryThreadIdSchema,
  context: Schema.optional(Schema.NullOr(Schema.String)),
  suggestSearch: Schema.optional(Schema.NullOr(Schema.Boolean)),
  attachFiles: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  sessionLinks: Schema.optional(Schema.NullOr(InquirySessionLinksSchema)),
  transcript: Schema.optional(
    Schema.NullOr(Schema.Array(InquiryTurnRecordSchema)),
  ),
});
export type InquiryRequest = typeof InquiryRequestSchema.Type;

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
  lastActivityIso: Schema.String.check(
    Schema.makeFilter((value) => !Number.isNaN(Date.parse(value)), {
      expected: 'an ISO date-time',
    }),
  ),
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
  turns: Schema.Array(InquiryTurnRecordSchema),
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

/** The inquiry's request, declared once: its `ask` returns at once, so the
 *  run never waits on it, and it is answered or skipped. Each `ask` posts
 *  it with an {@link InquiryRequest} as its data. */
export const INQUIRY_REQUEST = {
  kind: 'plugin',
  plugin: EXTERNAL_INQUIRY_THREAD_ARM.plugin,
  blocksCaller: false,
  answers: ['answer', 'skip'],
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
      attachFiles?: readonly string[];
    }) => Effect.Effect<InquiryThreadRecord, Error>;
    readonly recordAnswerForOpenTurn: (params: {
      threadId: InquiryThreadId;
      turnIndex: number;
      answer: string;
      sessionLinks?: readonly string[] | null;
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
    }) => Effect.Effect<InquiryThreadSummary[], Error>;
  }
>()('@texra/InquiryRecords') {}
