import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeEach, describe, expect } from 'vitest';
import { finalizeRun, getRunRecords } from '@agent/storage';
import { appendRow, rowAggregate, snapshotRow } from '@agent/runtime/loop/rows';
import { aggregateId, type RunId } from '@shared/schemas';
import { freshRunState } from '@shared/session/runStateFold';
import {
  createTestSession,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';

setupPlatform({ workspacePath: '/workspace' });
let session: ReturnType<typeof createTestSession>;
const id = 'bbb001' as RunId;
beforeEach(async () => {
  session = createTestSession();
  publishTestRunStart(session, id);
  await Effect.runPromise(session.settlePublications());
});

describe('run metadata updates', () => {
  it.effect(
    'preserves description and outcome when independent facts overlap',
    () =>
      Effect.gen(function* () {
        yield* Effect.all(
          [
            session.commit([
              {
                type: 'run.description',
                aggregateId: aggregateId('run', id),
                description: 'A described session',
              },
            ]),
            finalizeRun(session, {
              runId: id,
              outcome: 'completed',
            }),
          ],
          { concurrency: 'unbounded' },
        );
        expect((yield* session.readView([id])).runs.get(id)).toMatchObject({
          description: 'A described session',
          status: 'completed',
        });
      }),
  );
  it.effect('keeps a driver outcome when host-exit finalization follows', () =>
    Effect.gen(function* () {
      yield* finalizeRun(session, {
        runId: id,
        outcome: 'completed',
      });
      expect(
        yield* finalizeRun(session, {
          runId: id,
          outcome: 'cancelled',
          keepExistingOutcome: true,
        }),
      ).toEqual({ ok: true, outcome: 'completed' });
      expect(yield* getRunRecords(session, id).readRunEnd()).toMatchObject({
        outcome: 'completed',
      });
    }),
  );
  // A run resumed in a new process holds its earlier rounds' spend only in
  // its ledger; ending it before a round here must still bill them.
  it.effect(
    'carries the ledger usage on a run ended before its next round',
    () =>
      Effect.gen(function* () {
        const invocation = {
          invocationId: '0f1e2d3c-4b5a-4a9b-8c7d-6e5f4a3b2c1d',
          attempt: 1,
        } as const;
        const origin = {
          protocol: 'openai-chat',
          codecVersion: 1,
          requestedModel: 'gpt-test',
          deployment: {
            endpoint: 'https://api.example.test/v1',
            credentialScope: 'openai',
          },
        } as const;
        yield* session.ledger.acquire(id);
        const opening = {
          ...freshRunState(0),
          family: 'toolUse' as const,
          modelId: 'gpt54',
          modelCompatibilityKey: 'OpenAI' as const,
        };
        const opened = yield* session.ledger.appendBatch(id, null, [
          appendRow(id, [
            { role: 'user', content: [{ kind: 'text', text: 'go' }] },
          ]),
          snapshotRow(id, opening, {
            phase: 'initial',
            state: {
              stateSlices: null,
              offeredTools: [],
              toolsetHash: '0'.repeat(64),
            },
          }),
        ]);
        yield* session.ledger.appendBatch(id, opened, [
          {
            type: 'model.message',
            aggregateId: rowAggregate(id),
            payload: {
              kind: 'attempt',
              invocation,
              origin,
              delivery: 'stream',
            },
          },
          {
            type: 'model.message',
            aggregateId: rowAggregate(id),
            payload: {
              kind: 'response',
              responseId: '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d',
              invocation,
              turn: {
                kind: 'http',
                providerResponseId: 'resp-1',
                requestedOrigin: origin,
                returnedModel: null,
                modelFingerprint: null,
                content: [
                  { kind: 'message', content: [{ kind: 'text', text: 'ok' }] },
                ],
                finishReason: 'stop',
                usage: null,
              },
              calls: [],
              usage: {
                inputTokens: 120,
                outputTokens: 30,
                cost: 0.25,
                responseTimeMs: 40,
                provider: 'openai-chat',
              },
            },
          },
        ]);

        yield* finalizeRun(session, { runId: id, outcome: 'failed' });

        expect(yield* getRunRecords(session, id).readRunEnd()).toMatchObject({
          outcome: 'failed',
          usage: {
            totalInputTokens: 120,
            totalOutputTokens: 30,
            totalCost: 0.25,
          },
        });
      }),
  );
});
