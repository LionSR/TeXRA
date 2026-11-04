import { layer } from '@effect/vitest';
import { Effect, Layer, Schema, Context } from 'effect';
import { expect } from 'vitest';

import {
  AgentConfigSchema,
  emptyRunEndOutput,
  MESSAGE_TYPES,
  qualifyAggregateId,
  type RunId,
} from '@texra-ai/harness/schemas';
import type { SessionServices } from '@agent/runtime/rootLaunch';
import { LOG_LEVELS, USER_FOLLOW_UP_SUPPORT } from '@shared/schemas';
import { SessionLog } from '@shared/session/runHistory';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import {
  createTempDirPlatform,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import { seedRunRecord } from '@test/support/runRecordSeeds';
import {
  FakeHost,
  SessionGraph,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';
import { assembleTrace } from '@transcript/traceAssembler';
import { parseTraceData } from '../../../packages/trace-viewer/src/traceDataSchema';

const tempDirs = useTempDirs();

layer(
  SessionGraph.layer.pipe(
    Layer.provideMerge(
      FakeHost.layer(() => createTempDirPlatform('texra-trace-', tempDirs)),
    ),
  ),
  { excludeTestServices: true },
)('assembleTrace', (it) => {
  it.effect('assembles a full trace document for a run', () =>
    Effect.gen(function* () {
      // An ephemeral session over the host's own roots.
      const session: Context.Context<SessionServices> = yield* sessionHandleOf(
        yield* TestSession.open(),
      );
      const runId = 'aa11bb22cc33' as RunId;
      const aggregateId = qualifyAggregateId('run', runId);
      const planFact = {
        plugin: 'goal',
        kind: 'plan',
        version: 1,
        value: { objective: 'Check the argument' },
      };

      publishTestRunStart(session, runId);
      yield* Context.get(session, SessionLog).settled;
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

      const result = yield* assembleTrace(runId).pipe(Effect.provide(session));
      if (result.status !== 'ok') {
        throw new Error(`expected an ok trace, got ${result.status}`);
      }
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
        origin: null,
        parent: null,
        provenance: null,
        userFollowUpSupport: USER_FOLLOW_UP_SUPPORT.UNSUPPORTED,
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
    }),
  );
});
