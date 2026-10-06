/**
 * The external-inquiry plugin's rows (`PLUGIN_EVENT_ARMS` in
 * `@tools/pluginArms`): each thread is an aggregate the plugin owns,
 * `('plugin', 'external-inquiry:<threadId>')`, and its latest `plugin.fact`
 * of kind `thread` is the summary the Background Tasks panel lists under the
 * run that asked, the row's `parent`. The thread's full record stays in the
 * global database (`InquiryRecords`); this row only displays it. Core folds
 * the row without reading it (`SessionView.pluginFacts`); this module is its
 * schema, its writer and its one reader, beside the service over the
 * thread records. Browser-safe: it imports only schemas, `zod` and `effect`.
 */
import { Context, type Effect } from 'effect';
import { z } from 'zod';

import {
  aggregateId,
  ExternalInquiryTurnRecordSchema,
  InquiryThreadIdSchema,
  InquiryThreadSummarySchema,
  RunIdSchema,
  type InquiryThreadId,
  type InquiryThreadStatus,
  type InquiryThreadSummary,
  type JsonValue,
  type RunId,
  type SessionEventDraft,
} from '@shared/schemas';
import type { SessionView } from '@shared/session/sessionView';
import type { ValueFamily } from '@shared/session/valueFamily';

/** A thread's full record: its turns, explicit `status` and the asking run. */
const InquiryThreadRecordSchema = z.object({
  threadId: InquiryThreadIdSchema,
  /** The run the last question was asked under; a continuation is addressed
   *  to it. Kept beside the row's `parent` edge because the global record
   *  spans projects, and listing a run's threads reads it here. */
  parentRunId: RunIdSchema.nullable(),
  status: InquiryThreadSummarySchema.shape.status,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  turns: z.array(ExternalInquiryTurnRecordSchema),
});
/** A thread's full record, as the global database stores it. */
export type InquiryThreadRecord = z.infer<typeof InquiryThreadRecordSchema>;

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
const InquiryThreadRowSchema = InquiryThreadSummarySchema.omit({
  parentRunId: true,
});

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
  const after = InquiryThreadRowSchema.safeParse(next.value);
  if (!after.success) return 'Unreadable inquiry thread row';
  if (previous === undefined) return null;
  const before = InquiryThreadRowSchema.safeParse(previous.value);
  if (!before.success)
    return `Unreadable inquiry history: ${after.data.threadId}`;
  const was = before.data;
  const now = after.data;
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

/** The external-inquiry plugin's one row kind. */
export const EXTERNAL_INQUIRY_THREAD_ARM = {
  plugin: 'external-inquiry',
  kind: 'thread',
  version: 1,
  schema: InquiryThreadRowSchema,
  upcasters: [],
  admits: admitsThreadRow,
} as const;

/** The row that makes `summary` its thread's displayed state, for the one
 *  publisher. The aggregate key carries the plugin's id, so no other
 *  plugin's key can collide with a thread's. */
export function inquiryThreadRow(
  summary: InquiryThreadSummary,
): SessionEventDraft {
  const { parentRunId, ...value } = summary;
  return {
    type: 'plugin.fact',
    aggregateId: aggregateId(
      'plugin',
      `${EXTERNAL_INQUIRY_THREAD_ARM.plugin}:${summary.threadId}`,
    ),
    plugin: EXTERNAL_INQUIRY_THREAD_ARM.plugin,
    kind: EXTERNAL_INQUIRY_THREAD_ARM.kind,
    version: EXTERNAL_INQUIRY_THREAD_ARM.version,
    parent: parentRunId,
    value: InquiryThreadRowSchema.parse(value),
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
      ? [{ ...InquiryThreadRowSchema.parse(fact.value), parentRunId: runId }]
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
