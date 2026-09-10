/** Canonical global inquiry operations, independent of project display lifetimes. */
import { Context, type Effect } from 'effect';
import type {
  RunId,
  InquiryThreadId,
  InquiryThreadRecord,
  InquiryThreadStatus,
  InquiryThreadSummary,
} from '@shared/schemas';

export class InquiryRecords extends Context.Service<
  InquiryRecords,
  {
    readonly recordOpenQuestion: (params: {
      threadId?: InquiryThreadId;
      /** The asking run; continuations flow back to it. */
      parentStreamId: RunId;
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
      scope: 'stream' | 'all';
      streamId?: RunId;
      limit?: number;
    }) => Effect.Effect<InquiryThreadSummary[], Error>;
  }
>()('@texra/InquiryRecords') {}
