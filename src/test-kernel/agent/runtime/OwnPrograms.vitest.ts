/**
 * A program an agent writes for itself, over a real store on the validation
 * model (`GOLDEN-OWN`, `validationModel.ts`): in one run the model writes
 * `/memories/programs/greet.js` with the memory tool, its next step's
 * script starts `own:greet`, and that program starts a child.
 *
 * Failure modes:
 * - the file is a program only after a restart: the step after the write
 *   does not load it, and `program('own:greet')` names no program;
 * - the step loads the file as the memory tool stored it, under a header
 *   that is not JavaScript, or loads it without recording its source;
 * - the program's run is offered a tool its `uses` does not name;
 * - the agent the program starts runs with nobody asked, as the child of a
 *   program a plugin ships would.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { layer } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { assert, describe, expect } from 'vitest';

import { decideRequest } from '@agent/runtime/requests';
import { rootRun } from '@agent/runtime/rootLaunch';
import {
  AgentConfigSchema,
  generateRunId,
  RunIdSchema,
  type RunId,
} from '@texra-ai/worldline/schemas';
import {
  persistentTestSession,
  REAL_RUN_TIMEOUT,
  storedRows,
  type StoredRow,
  untilStored,
  validationHost,
} from '@test/support/storeFaults';
import { FakeHost, SessionGraph } from '@test/support/testKernel';

const decodeRow = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      requestId: Schema.optional(Schema.String),
      payload: Schema.optional(
        Schema.Struct({
          kind: Schema.optional(Schema.String),
          data: Schema.optional(
            Schema.Struct({ label: Schema.optional(Schema.String) }),
          ),
          tools: Schema.optional(
            Schema.Array(Schema.Struct({ name: Schema.String })),
          ),
          modules: Schema.optional(Schema.Record(Schema.String, Schema.String)),
          digest: Schema.optional(Schema.String),
          value: Schema.optional(Schema.Unknown),
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

/** The string `runId` stored under `digest`: a `context.blob` row holds
 *  its value as JSON text. */
const storedText = (
  rows: readonly StoredRow[],
  runId: string,
  digest: string,
): string =>
  Schema.decodeUnknownSync(Schema.fromJsonString(Schema.String))(
    rowsOf(rows, runId, 'context.blob').find(
      (row) => row.payload?.digest === digest,
    )?.payload?.value,
  );

describe(
  'a program an agent wrote for itself',
  { timeout: REAL_RUN_TIMEOUT },
  () => {
    layer(SessionGraph.hosted, { excludeTestServices: true })((it) => {
      it.layer(validationHost('texra-own-program-'), { buildPerTest: true })(
        (it) => {
          it.effect(
            'starts by name at the step after its file is written, on the tools it names, and asks before it starts an agent',
            () =>
              Effect.gen(function* () {
                const { roots } = yield* FakeHost;
                const { storage } = roots;
                const session = yield* persistentTestSession();
                const root: RunId = generateRunId();
                yield* rootRun({
                  runId: root,
                  config: Schema.decodeUnknownSync(AgentConfigSchema)({
                    label: 'golden_own',
                    system: 'GOLDEN-OWN: write a program, then start it.',
                    tools: ['memory', 'script', 'program'],
                    model: 'openai/gpt-5.6-sol',
                    instruction: 'Write yourself a program and start it.',
                  }),
                }).pipe(Effect.provide(session));
                /** Wait for a row of `type` that `holds`, or for the root's
                 *  end, past which none comes. */
                const untilRow = (
                  type: string,
                  holds: (row: StoredRow) => boolean,
                ) =>
                  untilStored(storage, (rows) =>
                    rows.some(
                      (row) =>
                        (row.type === type && holds(row)) ||
                        (row.type === 'run.end' && row.run === root),
                    ),
                  );
                /** The one request `runId` opened, once it has. */
                const requestOf = (runId: RunId) =>
                  Effect.gen(function* () {
                    yield* untilRow(
                      'request.opened',
                      (row) => row.run === runId,
                    );
                    const [opened, ...more] = rowsOf(
                      storedRows(storage),
                      runId,
                      'request.opened',
                    );
                    assert(
                      opened?.requestId !== undefined && more.length === 0,
                      `one request of ${runId}`,
                    );
                    return { ...opened, requestId: opened.requestId };
                  });
                const approve = (runId: RunId, requestId: string) =>
                  decideRequest(runId, requestId, { action: 'approve' }).pipe(
                    Effect.provide(session),
                  );

                // The script's `program('own:greet')` is asked about, as any
                // launch a model's script makes; the person approves it.
                const launch = yield* requestOf(root);
                expect(launch.payload).toMatchObject({
                  kind: 'proposal',
                  data: { label: 'own:greet' },
                });
                expect(yield* approve(root, launch.requestId)).toBe(true);

                // The program's `agent()` call asks too, on the program's
                // run, and its child does not start meanwhile.
                yield* untilRow('run.start', (row) => row.parent === root);
                const program = Schema.decodeUnknownSync(RunIdSchema)(
                  storedRows(storage).find(
                    (row) => row.parent === root && row.type === 'run.start',
                  )?.run,
                );
                const delegation = yield* requestOf(program);
                expect(delegation.payload).toMatchObject({
                  kind: 'proposal',
                  data: { label: 'Own child' },
                });
                expect(
                  storedRows(storage).filter((row) => row.parent === program),
                ).toStrictEqual([]);
                expect(yield* approve(program, delegation.requestId)).toBe(
                  true,
                );

                yield* untilRow('run.end', (row) => row.run === root);
                const rows = storedRows(storage);

                // The program ran in its own run, offered its script, the
                // script's own function and the two tools `uses` names, and
                // the script that started it returns its value.
                const programTools = rowsOf(rows, program, 'tools.offered').map(
                  (row) =>
                    (row.payload?.tools ?? [])
                      .map(({ name }) => name)
                      .toSorted(),
                );
                expect(programTools).toStrictEqual([
                  ['agent', 'read_file', 'script', 'self'],
                ]);
                expect(
                  rowsOf(rows, root, 'tool.result').map(
                    (row) => row.payload?.result?.value,
                  ),
                ).toContainEqual('own program ran; child said: Child result.');

                // The run's first step offered no such module; the step
                // after the write records it, by the address of the module
                // the file holds under the memory tool's header.
                const offers = rowsOf(rows, root, 'tools.offered').map(
                  (row) => row.payload?.modules?.['own:greet'],
                );
                expect(offers.at(0)).toBeUndefined();
                const pinned = offers.at(-1);
                assert(pinned !== undefined, 'the later step pins own:greet');
                expect(
                  rowsOf(rows, program, 'tools.offered').map(
                    (row) => row.payload?.modules?.['own:greet'],
                  ),
                ).toStrictEqual([pinned]);
                const source = storedText(rows, root, pinned);
                const file = readFileSync(
                  join(storage, 'memories', 'programs', 'greet.js'),
                  'utf8',
                );
                expect(file.startsWith('---\nmodifiedBy: golden_own\n')).toBe(
                  true,
                );
                expect(
                  source.startsWith(
                    '// Asks a child and reports its answer.\nexport const description = ',
                  ),
                ).toBe(true);
                expect(file.endsWith(`---\n${source}`)).toBe(true);
              }),
          );
        },
      );
    });
  },
);
