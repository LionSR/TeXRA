import { layer } from '@effect/vitest';
import { Effect, Schema, Context } from 'effect';
import { assert, expect } from 'vitest';

import {
  AgentConfigSchema,
  MESSAGE_TYPES,
  RunIdSchema,
} from '@texra-ai/harness/schemas';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { emptyRunEndOutput, LOG_LEVELS } from '@shared/schemas';
import { SessionLog } from '@shared/session/runHistory';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { seedRunRecord } from '@test/support/runRecordSeeds';
import {
  SessionGraph,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';
import { assembleTrace } from '@agent/storage/traceAssembler';
import { parseTraceData } from '../../../../packages/trace-viewer/src/traceDataSchema';

// The block's graph keeps the global store open until the block ends, so
// the store lies under the default host's storage, which outlasts the block.
// A directory removed after each test would still hold the open database
// file, and Windows refuses to delete one.
layer(SessionGraph.hosted, { excludeTestServices: true })(
  'assembleTrace',
  (it) => {
    it.effect('assembles a full trace document for a run', () =>
      Effect.gen(function* () {
        // An ephemeral session over the host's own roots.
        const session: Context.Context<SessionServices> =
          yield* sessionHandleOf(yield* TestSession.open());
        const runId = Schema.decodeSync(RunIdSchema)('aa11bb22cc33');
        const aggregateId = runId;
        const planFact = {
          plugin: 'goal',
          kind: 'plan',
          version: 1,
          value: { objective: 'Check the argument' },
        };

        yield* publishTestRunStart(session, runId);
        yield* Context.get(session, SessionLog).drained;
        yield* seedRunRecord(
          session,
          runId,
          Schema.decodeUnknownSync(AgentConfigSchema)({
            agent: 'review',
            model: 'anthropic/claude-sonnet-5-5',
            instruction: 'Solve the problem.',
            workingDirectory: '/workspace',
          }),
        );
        // The terminal fact is `run.end`; the view's outcome is folded from it.
        yield* Context.get(session, SessionLog).transact([
          {
            type: 'run.end',
            aggregateId,
            outcome: 'completed',
            output: emptyRunEndOutput(),
          },
        ]);
        yield* Context.get(session, SessionLog).transact([
          {
            type: 'log',
            aggregateId,
            level: LOG_LEVELS.INFO,
            messageType: MESSAGE_TYPES.DEFAULT,
            message: 'hello',
          },
        ]);
        yield* Context.get(session, SessionLog).transact([
          { type: 'plugin.fact', aggregateId, parent: null, ...planFact },
        ]);

        const result = yield* assembleTrace(runId).pipe(
          Effect.provide(session),
        );
        assert(
          result.status === 'ok',
          `expected an ok trace, got ${result.status}`,
        );
        const { trace, record } = result;

        expect(trace.runId).toBe(runId);
        expect(record).toMatchObject({
          agent: 'review',
          model: 'anthropic/claude-sonnet-5-5',
        });
        // The creation row is authored, not copied: an exported file has no
        // producer, no siblings and no writable host.
        expect(trace.events[0]).toMatchObject({
          type: 'run.start',
          parent: null,
          provenance: null,
          takesFollowUps: false,
        });
        expect(trace.events).toContainEqual(
          expect.objectContaining({ type: 'log', message: 'hello' }),
        );
        expect(trace.events).toContainEqual(
          expect.objectContaining({ type: 'run.end', outcome: 'completed' }),
        );
        expect(trace.events).toContainEqual(
          expect.objectContaining({ type: 'plugin.fact', ...planFact }),
        );
        // The trace viewer reads the same document the export writes.
        expect(() => parseTraceData(trace)).not.toThrow();
        // A stage an earlier build exported, with its retired `kind`, fails the
        // parse instead of reading as this build's stage with the field dropped.
        const logRow = trace.events.find((event) => event.type === 'log');
        assert(logRow?.type === 'log', 'expected a log row');
        const { level: _l, message: _m, messageType: _t, ...envelope } = logRow;
        const earlier = {
          ...trace,
          events: [
            ...trace.events,
            {
              ...envelope,
              type: 'stage.start',
              id: 'run-stage',
              label: 'Run: review',
              kind: 'run',
            },
          ],
        };
        expect(() => parseTraceData(earlier)).toThrow(/kind/);
      }),
    );
  },
);
