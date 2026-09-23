// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Exit } from 'effect';
import { describe, expect, vi } from 'vitest';

// Local imports
import { settleRun, type RunCell } from '@agent/runtime/loop/runProgram';
import { Runs } from '@agent/runtime/runRegistry';
import { RUN_OUTCOME, RUN_PHASE, type RunId } from '@shared/schemas';
import { DatabaseWriteFailed } from '@shared/session/database';
import { RunLedgerRefused } from '@shared/session/runLedger';
import type { RunState } from '@shared/session/runStateFold';
import { generateRunId } from '@utils/core';

describe('settleRun', () => {
  it.effect(
    'warns on refusal but propagates a halt database write failure',
    () =>
      Effect.gen(function* () {
        const runId = generateRunId() as RunId;
        const state = {
          family: 'toolUse',
          phase: RUN_PHASE.RUNNING,
          round: 2,
          turn: 3,
          continuationIndex: 1,
        } as unknown as RunState;
        const exit = Exit.succeed({ state, outcome: RUN_OUTCOME.COMPLETED });
        const warn = vi.fn();
        const release = vi.fn();
        const logger = { warn } as never;
        const lease = { release } as never;
        const runs = { hasActiveChildren: () => false } as never;
        const makeCell = (failure: RunLedgerRefused | DatabaseWriteFailed) => {
          const append = vi.fn(() => Effect.fail(failure));
          const cell = {
            runId,
            current: Effect.succeed(state),
            append,
            adopt: (next: RunState) => Effect.succeed(next),
            fold: () => Effect.succeed(state),
          } as RunCell;
          return { cell, append };
        };

        const refusal = new RunLedgerRefused({
          reason: 'not-owner',
          runId,
          detail: 'claim moved',
        });
        const refused = makeCell(refusal);
        yield* settleRun(
          refused.cell,
          logger,
          lease,
        )(exit).pipe(Effect.provideService(Runs, runs));
        expect(refused.append).toHaveBeenCalledOnce();
        expect(warn).toHaveBeenCalledWith('Failed to record the run halt', {
          data: refusal,
        });
        expect(release).toHaveBeenCalledWith('terminal');

        warn.mockClear();
        release.mockClear();
        const failure = new DatabaseWriteFailed({
          path: 'session.db',
          cause: new Error('disk full'),
        });
        const failed = makeCell(failure);
        expect(
          yield* Effect.flip(
            settleRun(
              failed.cell,
              logger,
              lease,
            )(exit).pipe(Effect.provideService(Runs, runs)),
          ),
        ).toBe(failure);
        expect(failed.append).toHaveBeenCalledOnce();
        expect(warn).not.toHaveBeenCalled();
        expect(release).toHaveBeenCalledWith('terminal');
      }),
  );
});
