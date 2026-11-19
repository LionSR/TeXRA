/**
 * A process child's run (`launchProcessChild`): its one turn, and the end
 * the run programs share, over a real store.
 *
 * Failure modes:
 * - a process run whose output rows the store refused ends with its own
 *   verdict, where a native run whose rows the store refused ends failed;
 * - its end says failed while its parent is delivered the turn's clean
 *   result, and no view shows the loss.
 */
import { layer } from '@effect/vitest';
import { Context, Effect } from 'effect';
import { expect } from 'vitest';

import { RunRegistry } from '@agent/runtime/runRegistry';
import { ChildRuns } from '@agent/runtime/ToolServices';
import { getRunRecords } from '@agent/storage/runOwnership';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import {
  persistentTestSession,
  sessionStoreFaults,
} from '@test/support/storeFaults';
import { FakeHost, SessionGraph } from '@test/support/testKernel';

layer(SessionGraph.hosted, { excludeTestServices: true })(
  'process run',
  (it) => {
    it.layer(FakeHost.layer({}), { buildPerTest: true })((it) => {
      it.effect('ends failed when the store refused a row of its output', () =>
        Effect.gen(function* () {
          const { roots } = yield* FakeHost;
          const session = yield* persistentTestSession();
          const parentId = yield* publishTestRunStart(session);
          const faults = yield* sessionStoreFaults(roots.storage);
          yield* faults.failNext('appendAll', 'process.output');
          const runId = yield* Effect.flatMap(ChildRuns, (children) =>
            children.launchProcess({
              identity: { kind: 'process', tool: 'echo' },
              config: { name: 'echo', instruction: 'echo done' },
              description: 'Echo',
              turn: ({ logger, runId }) => ({
                run: Effect.sync(() => {
                  logger.output('stdout', 'done\n');
                  return {
                    report: {
                      family: 'background',
                      runId,
                      response: 'Echoed.',
                    },
                  };
                }),
                reportError: (error) => ({
                  family: 'background',
                  runId,
                  message: error.message,
                }),
              }),
            }),
          ).pipe(
            Effect.provide(
              nativeToolTestLayer({
                run: { session, runId: parentId, toolPolicy: {} },
              }),
            ),
          );
          yield* (
            Context.get(session, RunRegistry).get(runId)?.drained ?? Effect.void
          );

          const records = getRunRecords(runId);
          const end = yield* records.readRunEnd().pipe(Effect.provide(session));
          expect(end).toMatchObject({
            outcome: 'failed',
            error: {
              kind: 'result-lost',
              message: expect.stringContaining(
                'Rows this run published were not written',
              ),
            },
          });
          // Its parent reads the same end: the delivery is an error, not
          // the turn's clean result.
          const report = yield* records
            .readReport()
            .pipe(Effect.provide(session));
          expect(report).toContain('<background-error');
          expect(report).toContain('Rows this run published were not written');
        }),
      );
    });
  },
);
