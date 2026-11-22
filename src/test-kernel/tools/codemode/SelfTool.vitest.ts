/**
 * A script's `self()` children under what their calls name, over a real
 * store on the validation model (`GOLDEN-LIMITS`, `validationModel.ts`): one
 * script whose first child passes its spend cap on its first reply and is
 * never answered again, and whose second is a fork on a named model, under
 * a cap it never reaches.
 *
 * Failure modes:
 * - a child past its `maxCostUsd` runs on (here, forever), or its
 *   call rejects while the run is left without a stop and an end;
 * - the script's `await` rejects under another name than `BudgetExceeded`;
 * - a child that stays under its cap is stopped, or its call never returns;
 * - `self()` drops `model`, and the child runs on its caller's.
 */
import { layer } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { assert, describe, expect } from 'vitest';

import { rootRun } from '@agent/runtime/rootLaunch';
import {
  AgentConfigSchema,
  generateRunId,
  type RunId,
} from '@texra-ai/harness/schemas';
import {
  persistentTestSession,
  REAL_RUN_TIMEOUT,
  storedRows,
  type StoredRow,
  untilStored,
  validationHost,
} from '@test/support/storeFaults';
import { FakeHost, SessionGraph } from '@test/support/testKernel';

const MODEL = 'openai/gpt-5.6-sol';
/** The model the script's second `self()` call names. */
const NAMED_MODEL = 'openai/gpt-6.1-sol';

const decodeRow = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      outcome: Schema.optional(Schema.String),
      reason: Schema.optional(Schema.String),
      config: Schema.optional(
        Schema.Struct({ model: Schema.optional(Schema.String) }),
      ),
      payload: Schema.optional(
        Schema.Struct({
          result: Schema.optional(
            Schema.Struct({ value: Schema.optional(Schema.Unknown) }),
          ),
        }),
      ),
    }),
  ),
);

/** The decoded rows of `type` that `runId` stored, in commit order. */
const rowsOf = (rows: readonly StoredRow[], runId: string, type: string) =>
  rows
    .filter((row) => row.run === runId && row.type === type)
    .map((row) => decodeRow(row.data));

/**
 * Run the limits script to its root's end. Returns the store's rows, the
 * root, and its two children in the order the script started them.
 */
const limitsRun = Effect.gen(function* () {
  const { roots } = yield* FakeHost;
  const session = yield* persistentTestSession();
  const root: RunId = generateRunId();
  yield* rootRun({
    runId: root,
    config: Schema.decodeUnknownSync(AgentConfigSchema)({
      label: 'golden_limits',
      system: 'GOLDEN-LIMITS: one script, two self() children.',
      tools: ['script', 'executions'],
      model: MODEL,
      instruction: 'Run the limits script.',
    }),
  }).pipe(Effect.provide(session));
  yield* untilStored(roots.storage, (rows) =>
    rows.some((row) => row.run === root && row.type === 'run.end'),
  );
  const rows = storedRows(roots.storage);
  const [capped, named] = rows
    .filter((row) => row.parent === root && row.type === 'run.start')
    .map((row) => row.run);
  assert(capped !== undefined && named !== undefined, 'two children started');
  return { rows, root, capped, named };
});

describe("a script's self() children", { timeout: REAL_RUN_TIMEOUT }, () => {
  layer(SessionGraph.hosted, { excludeTestServices: true })((it) => {
    it.layer(validationHost('texra-self-limits-'), { buildPerTest: true })(
      (it) => {
        it.effect(
          'stops a child at its spend cap and rejects its call as BudgetExceeded',
          () =>
            Effect.gen(function* () {
              const { rows, root, capped } = yield* limitsRun;
              expect(rowsOf(rows, capped, 'run.stop')).toMatchObject([
                { reason: 'cap' },
              ]);
              expect(rowsOf(rows, capped, 'run.end')).toMatchObject([
                { outcome: 'cancelled' },
              ]);
              const returned = rowsOf(rows, root, 'tool.result').map(
                (row) => row.payload?.result?.value,
              );
              expect(returned).toContainEqual({
                capped: 'BudgetExceeded',
                named: 'Named model answered.',
              });
            }),
        );

        it.effect('runs a child on the model its call names', () =>
          Effect.gen(function* () {
            const { rows, root, named } = yield* limitsRun;
            expect(
              rowsOf(rows, root, 'run.config').map((row) => row.config?.model),
            ).toStrictEqual([MODEL]);
            const models = rowsOf(rows, named, 'run.config').map(
              (row) => row.config?.model,
            );
            expect(new Set(models)).toStrictEqual(new Set([NAMED_MODEL]));
            expect(rowsOf(rows, named, 'run.end')).toMatchObject([
              { outcome: 'completed' },
            ]);
          }),
        );
      },
    );
  });
});
