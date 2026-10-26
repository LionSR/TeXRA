import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from '@effect/vitest';
import { Effect, Layer, Result, Schema } from 'effect';
import { afterEach, beforeEach, describe, expect } from 'vitest';

import { globalDatabaseLayer } from '@controllers/session/Database';
import { processOwnerId } from '@platform/defaults/nodeProcesses';
import { RunIdSchema, ToolError } from '@shared/schemas';
import { ProcessIdentity } from '@shared/session/sessionEvents';
import { globalValuesOver } from '@test/support/setupPlatform';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { InquiryRecords } from '@texra/shared/plugins/externalInquiry';
import { inquiryRecordsLayer } from '@texra/tools/inquiry/inquiryRecords';

const RUN_A = Schema.decodeUnknownSync(RunIdSchema)('1a1a1a1a1a1a');
const RUN_B = Schema.decodeUnknownSync(RunIdSchema)('1b1b1b1b1b1b');

describe('InquiryStorage', () => {
  let storage: string;
  beforeEach(() => {
    storage = mkdtempSync(join(tmpdir(), 'texra-inquiry-sql-'));
  });
  afterEach(() => rmSync(storage, { recursive: true, force: true }));
  const layer = Layer.unwrap(
    Effect.sync(() =>
      inquiryRecordsLayer.pipe(
        Layer.provide(
          globalValuesOver(
            globalDatabaseLayer(storage).pipe(
              Layer.provide(ProcessIdentity.layer(processOwnerId(undefined))),
              Layer.provide(nodePlatformLayer),
              Layer.orDie,
            ),
          ),
        ),
      ),
    ),
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
        scope: 'run',
        runId: RUN_A,
      });
      const openOnB = yield* records.listThreadsByStatus({
        status: 'open',
        scope: 'run',
        runId: RUN_B,
      });
      expect(openOnA).toHaveLength(0);
      expect(openOnB).toHaveLength(1);
    }).pipe(Effect.provide(layer)),
  );
});
