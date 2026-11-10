/**
 * The run history over the real publisher and the real (in-memory) store:
 * no second `RunHistory`, no hand-written `SessionEvents`, so a schema
 * mistake fails here rather than in the PR that turns the writes on.
 */
// Third-party imports
import { layer } from '@effect/vitest';
import { Cause, Context, Effect, Exit, Schema } from 'effect';
import { expect } from 'vitest';

// Local imports - harness
import { qualifyAggregateId, RunIdSchema } from '@shared/schemas';
import {
  RunHistory,
  RunHistoryRefused,
  type RunCell,
  SessionLog,
} from '@shared/session/runHistory';
import type { RunHistoryDraft } from '@shared/session/runState';

// Local imports - test support
import { runStart, toolUseTurn } from '@test/support/sessionRows';
import { publishTestRows } from '@test/support/sessionTestUtils';
import { isolatedTestSession, SessionGraph } from '@test/support/testKernel';

/** The run every case here is about; one id, the key of its one aggregate. */
const RUN = Schema.decodeUnknownSync(RunIdSchema)('ab12cd');

layer(SessionGraph.hosted, { excludeTestServices: true })(
  'RunHistory',
  (it) => {
    const AGGREGATE = qualifyAggregateId('run', RUN);
    const SECRET = 'sk-abcdefghijklmnopqrstuvwxyz0123';
    const turn = toolUseTurn(RUN);
    const snapshot = (): RunHistoryDraft => ({
      type: 'run.position',
      aggregateId: AGGREGATE,
      payload: { at: 'turn.ready', turn: 0 },
    });
    const refusalOf = (error: unknown): RunHistoryRefused | null =>
      error instanceof RunHistoryRefused ? error : null;
    /** The approval a barrier call waits on. */
    const approvalRequested: RunHistoryDraft = {
      type: 'request.opened',
      aggregateId: AGGREGATE,
      requestId: 'req-1',
      payload: {
        kind: 'bash',
        data: {
          requestId: 'req-1',
          command: 'ls',
          offersGrant: true,
          runId: RUN,
        },
      },
    };
    const toolEnd = (callId: string): RunHistoryDraft => ({
      type: 'tool.end',
      aggregateId: AGGREGATE,
      logId: callId,
      status: 'completed',
    });
    /** The batches of one turn, in order, up to and excluding the delivery. */
    const openTurn = (cell: RunCell) =>
      Effect.gen(function* () {
        yield* cell.append([turn.append, snapshot()]);
        yield* cell.append([turn.attempt]);
        yield* cell.append([turn.identified]);
        return yield* cell.append([turn.response, turn.intent]);
      });

    it.effect(
      'holds the batch contract: a mismatched delivery dies, a loose-keyed attachment is accepted',
      () =>
        Effect.gen(function* () {
          const session = yield* isolatedTestSession();
          const run = Context.get(session, RunHistory);
          const log = Context.get(session, SessionLog);
          /** The run's committed rows, as a cold read finds them. */
          const committed = Effect.map(
            log.history(AGGREGATE),
            (rows) => rows.length,
          );
          yield* publishTestRows(session, [runStart(RUN)]);
          const cell = yield* run.open(RUN);
          let state = yield* openTurn(cell);
          // Delivering before the settlements committed is a caller defect.
          const early = yield* cell.append([turn.delivery]).pipe(Effect.exit);
          expect(Exit.isFailure(early) && Cause.hasDies(early.cause)).toBe(
            true,
          );
          // A batch the fold rejects commits nothing: the refusal has to mean
          // "not written", or every later `load` meets the orphan row.
          const written = yield* committed;
          const orphan = yield* cell
            .append([turn.result('call-z'), toolEnd('call-z')])
            .pipe(Effect.flip);
          expect(refusalOf(orphan)?.reason).toBe('inconsistent');
          expect(yield* committed).toBe(written);
          expect(yield* run.load(RUN)).toEqual(state);
          // Same rule for the history the batch assembles: an append that leaves
          // a tool group with no calling assistant is refused before publishing,
          // not discovered on the next cold load.
          const orphanGroup = yield* cell
            .append([
              {
                type: 'model.message',
                aggregateId: AGGREGATE,
                payload: {
                  kind: 'append',
                  sourceResponse: null,
                  messages: [
                    {
                      role: 'tool',
                      results: [
                        {
                          callOrdinal: 0,
                          status: 'success',
                          content: [{ kind: 'text', text: 'ok' }],
                        },
                      ],
                    },
                  ],
                },
              },
            ])
            .pipe(Effect.flip);
          expect(refusalOf(orphanGroup)?.reason).toBe('unprepared-history');
          expect(yield* committed).toBe(written);
          state = yield* cell.append([approvalRequested]);
          expect(state.requests['req-1']?.decision).toBeNull();
          expect(state.pendingResponse?.records['call-a']?.status).toEqual({
            kind: 'started',
            attempt: 1,
          });
          // A real attachment carries loose keys and binary fields: accepted, and
          // the binary fields never reach the row.
          state = yield* cell.append([
            turn.result('call-a', {
              result: {
                status: 'executed',
                output: 'ok',
                files: [
                  {
                    path: 'out/plot.png',
                    mimeType: 'image/png',
                    base64Data: 'AAAA',
                    // cast: not part of the row shape; the decode must drop it.
                    bytes: new Uint8Array([1, 2]) as never,
                    sourceTool: 'bash',
                  },
                ],
              },
            }),
            toolEnd('call-a'),
          ]);
          const settledA = state.pendingResponse?.records['call-a']?.status;
          const file =
            settledA?.kind === 'settled'
              ? settledA.result.files?.[0]
              : undefined;
          expect(file).toEqual({
            path: 'out/plot.png',
            mimeType: 'image/png',
            sourceTool: 'bash',
          });
          // A credential-bearing endpoint is refused before anything is written,
          // and the refusal carries the permitted components only: the rejected
          // query string is the credential this check exists to keep out.
          const unsafe = yield* cell
            .append([
              {
                type: 'model.message',
                aggregateId: AGGREGATE,
                payload: {
                  kind: 'attempt',
                  request: '0'.repeat(64),
                  invocation: { ...turn.invocation, attempt: 2 },
                  origin: {
                    ...turn.origin,
                    deployment: {
                      ...turn.origin.deployment,
                      endpoint: `https://api.example.test/v1?api-key=${SECRET}`,
                    },
                  },
                },
              },
            ])
            .pipe(Effect.flip);
          expect(unsafe).toBeInstanceOf(RunHistoryRefused);
          expect(refusalOf(unsafe)?.reason).toBe('unsafe-endpoint');
          expect(refusalOf(unsafe)?.detail).not.toContain(SECRET);
          expect(refusalOf(unsafe)?.detail).toContain(
            'https://api.example.test/v1',
          );
        }),
    );
  },
);
