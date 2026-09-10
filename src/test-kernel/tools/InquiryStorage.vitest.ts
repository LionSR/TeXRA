import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from '@effect/vitest';
import { Effect, Layer, Result } from 'effect';
import { afterEach, beforeEach, describe, expect } from 'vitest';

import { inquiryRecordsLayer } from '@controllers/session/inquiryRecords';
import { processOwnerId } from '@platform/defaults/nodeProcesses';
import {
  ExternalInquiryPermissionSchema,
  RunIdSchema,
  ToolError,
} from '@shared/schemas';
import { InquiryRecords } from '@shared/session/inquiryRecords';
import { ProcessIdentity } from '@shared/session/sessionEvents';
import { inquiryRecordToTranscript } from '@tools/inquiry/inquiryRecordFormatting';

const RUN_A = RunIdSchema.parse('1a1a1a1a1a1a');
const RUN_B = RunIdSchema.parse('1b1b1b1b1b1b');

describe('InquiryStorage', () => {
  let storage: string;
  beforeEach(() => {
    storage = mkdtempSync(join(tmpdir(), 'texra-inquiry-sql-'));
  });
  afterEach(() => rmSync(storage, { recursive: true, force: true }));
  const layer = Layer.unwrap(
    Effect.sync(() =>
      inquiryRecordsLayer(() => storage).pipe(
        Layer.provide(ProcessIdentity.layer(processOwnerId(undefined))),
      ),
    ),
  );
  it.live('treats a fresh global database as empty', () =>
    Effect.gen(function* () {
      const records = yield* InquiryRecords;
      expect(
        yield* records.listThreadsByStatus({ status: 'any', scope: 'all' }),
      ).toEqual([]);
    }).pipe(Effect.provide(layer)),
  );
  it.live('opens, answers, and resolves a thread end-to-end', () =>
    Effect.gen(function* () {
      const records = yield* InquiryRecords;
      const opened = yield* records.recordOpenQuestion({
        parentRunId: RUN_A,
        question: 'What is the Sobolev constant?',
        context: 'Use the sharp Euclidean inequality.',
        suggestSearch: false,
      });

      expect(opened.status).toBe('open');
      expect(opened.parentRunId).toBe(RUN_A);
      expect(opened.turns).toHaveLength(1);
      expect(opened.turns.at(-1)?.suggestSearch).toBe(false);

      const open = yield* records.listThreadsByStatus({
        status: 'open',
        scope: 'all',
      });
      expect(open).toHaveLength(1);
      expect(open[0].status).toBe('open');

      const answers = yield* Effect.all(
        [1, 2].map(() =>
          records.recordAnswerForOpenTurn({
            threadId: opened.threadId,
            turnIndex: 1,
            answer: 'C = (n(n-2))^{-1} * ω_n^{2/n}',
          }),
        ),
        { concurrency: 'unbounded' },
      );
      expect(answers.filter((answer) => answer !== null)).toHaveLength(1);
      const answered = yield* records.readExternalInquiryThread(
        opened.threadId,
      );
      expect(answered).not.toBeNull();
      expect(answered!.status).toBe('answered');
      expect(answered!.turns.at(-1)).toMatchObject({
        answer: 'C = (n(n-2))^{-1} * ω_n^{2/n}',
      });

      const stillOpen = yield* records.listThreadsByStatus({
        status: 'open',
        scope: 'all',
      });
      expect(stillOpen).toHaveLength(0);
    }).pipe(Effect.provide(layer)),
  );

  it.live.each([
    {
      name: 'rejects re-dispatch on an open thread',
      drop: false,
    },
    {
      name: 'rejects ask on a dropped thread',
      drop: true,
    },
  ])('$name', ({ drop }) =>
    Effect.gen(function* () {
      const records = yield* InquiryRecords;
      const opened = yield* records.recordOpenQuestion({
        parentRunId: RUN_A,
        question: 'Q1',
      });
      if (drop)
        yield* records.markDropped({ threadId: opened.threadId, turnIndex: 1 });

      const rejection = yield* Effect.result(
        records.recordOpenQuestion({
          threadId: opened.threadId,
          parentRunId: RUN_A,
          question: 'Q2',
        }),
      );
      expect(Result.isFailure(rejection) && rejection.failure).toBeInstanceOf(
        ToolError,
      );
    }).pipe(Effect.provide(layer)),
  );

  it.live(
    'allows ask follow-up on an answered thread; status flips back to open',
    () =>
      Effect.gen(function* () {
        const records = yield* InquiryRecords;
        const t = yield* records.recordOpenQuestion({
          parentRunId: RUN_A,
          question: 'Q1',
        });
        yield* records.recordAnswerForOpenTurn({
          threadId: t.threadId,
          turnIndex: 1,
          answer: 'A1',
        });

        const followUp = yield* records.recordOpenQuestion({
          threadId: t.threadId,
          parentRunId: RUN_A,
          question: 'Q2 (follow-up)',
        });

        expect(followUp.status).toBe('open');
        expect(followUp.turns).toHaveLength(2);
        expect(followUp.turns.at(-1)?.question).toBe('Q2 (follow-up)');
        expect(
          yield* records.recordAnswerForOpenTurn({
            threadId: t.threadId,
            turnIndex: 1,
            answer: 'A delayed answer to Q1',
          }),
        ).toBeNull();
        expect(
          yield* records.markDropped({ threadId: t.threadId, turnIndex: 1 }),
        ).toBeNull();
        expect(yield* records.readExternalInquiryThread(t.threadId)).toEqual(
          followUp,
        );
      }).pipe(Effect.provide(layer)),
  );

  it.live('updates parentRunId on cross-run follow-up', () =>
    Effect.gen(function* () {
      const records = yield* InquiryRecords;
      const t = yield* records.recordOpenQuestion({
        parentRunId: RUN_A,
        question: 'Q1',
      });
      yield* records.recordAnswerForOpenTurn({
        threadId: t.threadId,
        turnIndex: 1,
        answer: 'A1',
      });

      const fromB = yield* records.recordOpenQuestion({
        threadId: t.threadId,
        parentRunId: RUN_B,
        question: 'Q2 from B',
      });
      expect(fromB.parentRunId).toBe(RUN_B);

      const openOnA = yield* records.listThreadsByStatus({
        status: 'open',
        scope: 'stream',
        runId: RUN_A,
      });
      const openOnB = yield* records.listThreadsByStatus({
        status: 'open',
        scope: 'stream',
        runId: RUN_B,
      });
      expect(openOnA).toHaveLength(0);
      expect(openOnB).toHaveLength(1);
    }).pipe(Effect.provide(layer)),
  );

  it.live('listThreadsByStatus filters by status and scope', () =>
    Effect.gen(function* () {
      const records = yield* InquiryRecords;
      const t1 = yield* records.recordOpenQuestion({
        parentRunId: RUN_A,
        question: 'Q1',
      });
      yield* records.recordAnswerForOpenTurn({
        threadId: t1.threadId,
        turnIndex: 1,
        answer: 'A1',
      });

      const t2 = yield* records.recordOpenQuestion({
        parentRunId: RUN_A,
        question: 'Q2',
      });

      const t3 = yield* records.recordOpenQuestion({
        parentRunId: RUN_B,
        question: 'Q3',
      });
      yield* records.markDropped({ threadId: t3.threadId, turnIndex: 1 });

      const openOnA = yield* records.listThreadsByStatus({
        status: 'open',
        scope: 'stream',
        runId: RUN_A,
      });
      expect(openOnA.map((t) => t.threadId)).toEqual([t2.threadId]);

      const allDropped = yield* records.listThreadsByStatus({
        status: 'dropped',
        scope: 'all',
      });
      expect(allDropped.map((t) => t.threadId)).toEqual([t3.threadId]);

      const answered = yield* records.listThreadsByStatus({
        status: 'answered',
        scope: 'all',
      });
      expect(answered.map((t) => t.threadId)).toEqual([t1.threadId]);
    }).pipe(Effect.provide(layer)),
  );
});
