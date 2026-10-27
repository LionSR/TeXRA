import { it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { describe, expect } from 'vitest';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  AgentConfigSchema,
  qualifyAggregateId,
  emptyRunEndOutput,
  LOG_LEVELS,
  MESSAGE_TYPES,
  type RunId,
  USER_FOLLOW_UP_SUPPORT,
} from '@shared/schemas';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import {
  createTestSession,
  publishTestRunStart,
  publishTestRows,
} from '@test/support/sessionTestUtils';
import {
  createTempDirPlatform,
  useTempDirs,
} from '@test/support/tempDirPlatform';
import { setupPlatform } from '@test/support/setupPlatform';
import { seedRunRecord } from '@test/support/runRecordSeeds';
import { assembleTrace } from '@transcript/traceAssembler';
import { parseTraceData } from '../../../packages/trace-viewer/src/traceDataSchema';

const tempDirs = useTempDirs();

describe('assembleTrace', () => {
  setupPlatform(() => createTempDirPlatform('texra-trace-', tempDirs));

  it.effect('assembles a full trace document for a run', () =>
    Effect.gen(function* () {
      const session: SessionHandle = yield* createTestSession({
        roots: testWorkspaceRoots(),
      });
      const runId = 'aa11bb22cc33' as RunId;
      const aggregateId = qualifyAggregateId('run', runId);
      const plan = { objective: 'Check the argument' };

      publishTestRunStart(session, runId);
      yield* session.log.settled;
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
      yield* session.log.transact([
        {
          type: 'run.end',
          aggregateId,
          outcome: 'completed',
          output: emptyRunEndOutput(),
        },
      ]);
      yield* session.log.transact([
        {
          type: 'log',
          aggregateId,
          level: LOG_LEVELS.INFO,
          messageType: MESSAGE_TYPES.DEFAULT,
          message: 'hello',
        },
      ]);
      publishTestRows(session, [
        { type: 'run.fact', aggregateId, fact: { key: 'plan', plan } },
      ]);
      yield* session.log.settled;

      const result = yield* assembleTrace(runId, session);
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
        expect.objectContaining({
          type: 'run.fact',
          fact: { key: 'plan', plan },
        }),
      );
      // The trace viewer reads the same document the export writes.
      expect(() => parseTraceData(trace)).not.toThrow();
    }),
  );
});
