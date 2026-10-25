import { it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

import { getRunRecords } from '@agent/storage/runRecords';
import { listRuns } from '@agent/storage/runListing';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { DatabaseReadFailed } from '@shared/session/database';
import {
  AgentConfigSchema,
  qualifyAggregateId,
  emptyRunEndOutput,
  type RunId,
  type RunIdentity,
  type RunOutcome,
} from '@shared/schemas';
import { createProcessSession } from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { seedRunRecord } from '@test/support/runRecordSeeds';

function config(
  agent: string,
  inputFiles: readonly string[] = [],
): AgentConfig {
  return Schema.decodeUnknownSync(AgentConfigSchema)({
    agent,
    model: 'deepseek/deepseek-v4-flash',
    instruction: 'Test run listing.',
    workingDirectory: '/workspace',
    inputFiles,
  });
}

let session: SessionHandle;
/** The run facts a listing row is built from, as the rows that carry them. */
type SeededRunFacts = {
  readonly timestamp: string;
  readonly identity: RunIdentity;
  readonly parentRunId?: RunId;
  readonly description?: string;
  readonly outcome?: RunOutcome;
};
async function writeMetadata(id: RunId, meta: SeededRunFacts): Promise<void> {
  const existing = await Effect.runPromise(getRunRecords(session, id).exists());
  if (!existing) {
    const clock = vi
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse(meta.timestamp));
    try {
      await Effect.runPromise(
        session.log.transact([
          {
            type: 'run.start',
            aggregateId: qualifyAggregateId('run', id),
            identity: meta.identity,
            userFollowUpSupport: 'unsupported',
            parent:
              meta.parentRunId === undefined
                ? null
                : { id: meta.parentRunId, callId: null },
            provenance: null,
          },
        ]),
      );
    } finally {
      clock.mockRestore();
    }
  }
  if (meta.description)
    await Effect.runPromise(
      session.log.transact([
        {
          type: 'run.description',
          by: 'model',
          aggregateId: qualifyAggregateId('run', id),
          description: meta.description,
        },
      ]),
    );
  if (meta.outcome)
    await Effect.runPromise(
      session.log.transact([
        {
          type: 'run.end',
          aggregateId: qualifyAggregateId('run', id),
          outcome: meta.outcome,
          output: emptyRunEndOutput(),
        },
      ]),
    );
}
async function writeRun(
  id: RunId,
  timestamp: string,
  agentConfig: AgentConfig,
  parentRunId?: RunId,
): Promise<void> {
  await writeMetadata(id, {
    timestamp,
    parentRunId,
    identity: { kind: 'agent', agent: agentConfig.agent },
  });
  await Effect.runPromise(seedRunRecord(session, id, agentConfig));
}

describe('run listing normalization', () => {
  setupPlatform({ workspacePath: '/workspace' });

  beforeEach(async () => {
    session = await Effect.runPromise(createProcessSession());
  });

  it.effect('sees runs written by another host after an earlier listing', () =>
    Effect.gen(function* () {
      expect(yield* listRuns(session)).toEqual([]);

      const id = 'eee555' as RunId;
      yield* Effect.promise(() =>
        writeRun(id, '2026-07-15T11:00:00.000Z', config('assistant')),
      );

      expect(yield* listRuns(session)).toEqual([
        expect.objectContaining({
          id,
          identity: { kind: 'agent', agent: 'assistant' },
        }),
      ]);
    }),
  );

  // A row is dropped only when the facts it is built from are unreadable. The
  // resumability read is not one of them: it decides an advertisement, so an
  // unreadable run record costs the row its Resume affordance, never its
  // place in history.
  it.effect('keeps a row whose resumability read fails, not resumable', () =>
    Effect.gen(function* () {
      const id = 'eee556' as RunId;
      yield* Effect.promise(() =>
        writeRun(id, '2026-07-15T11:00:00.000Z', config('assistant')),
      );
      vi.spyOn(session.log, 'records').mockReturnValue(
        Effect.fail(
          new DatabaseReadFailed({
            path: 'session.db',
            cause: new Error('record read failed'),
          }),
        ),
      );

      expect(yield* listRuns(session)).toEqual([
        expect.objectContaining({
          id,
          resumable: false,
        }),
      ]);
    }),
  );

  it.effect(
    'sees metadata replaced by another host after an earlier listing',
    () =>
      Effect.gen(function* () {
        const id = 'fff666' as RunId;
        yield* Effect.promise(() =>
          writeRun(id, '2026-07-15T12:00:00.000Z', config('assistant')),
        );
        expect(yield* listRuns(session)).toEqual([
          expect.not.objectContaining({ description: expect.any(String) }),
        ]);

        yield* Effect.promise(() =>
          writeMetadata(id, {
            timestamp: '2026-07-15T12:00:00.000Z',
            identity: { kind: 'agent', agent: 'assistant' },
            description: 'Updated by another host',
            outcome: 'completed',
          }),
        );

        expect(yield* listRuns(session)).toEqual([
          expect.objectContaining({
            id,
            description: 'Updated by another host',
            status: 'completed',
          }),
        ]);
      }),
  );

  it.effect(
    'uses the config as the canonical source for visible agent fields',
    () =>
      Effect.gen(function* () {
        const id = 'aaa111' as RunId;
        const agentConfig = config('assistant');
        yield* Effect.promise(() =>
          writeRun(id, '2026-07-15T10:00:00.000Z', agentConfig),
        );

        const entries = yield* listRuns(session);

        expect(entries).toEqual([
          {
            id,
            timestamp: '2026-07-15T10:00:00.000Z',
            identity: { kind: 'agent', agent: 'assistant' },
            record: agentConfig,
            status: 'ready',
            // The model the run is on is the view's (its newest config's),
            // not a second copy of the record's.
            model: agentConfig.model,
            // A loop-driven run continues from its rows: it is born with its
            // opening, so the standing never asks for one.
            resumable: true,
          },
        ]);
        expect(entries[0]).not.toHaveProperty('agent');
        expect(entries[0]).not.toHaveProperty('category');
      }),
  );

  it.effect('lists agent runs only, not process storage rows', () =>
    Effect.gen(function* () {
      const processId = 'bbb222' as RunId;
      const customBashAgentId = 'ccc333' as RunId;
      yield* Effect.promise(() =>
        writeMetadata(processId, {
          timestamp: '2026-07-15T09:00:00.000Z',
          identity: { kind: 'process', tool: 'assistant' },
        }),
      );
      yield* seedRunRecord(session, processId, config('assistant'));
      yield* Effect.promise(() =>
        writeRun(customBashAgentId, '2026-07-15T08:00:00.000Z', config('bash')),
      );

      expect(yield* listRuns(session)).toEqual([
        expect.objectContaining({
          id: customBashAgentId,
          identity: { kind: 'agent', agent: 'bash' },
          record: expect.objectContaining({ agent: 'bash' }),
        }),
      ]);
    }),
  );

  it.effect('keeps agent-spawned child runs out of history listings', () =>
    Effect.gen(function* () {
      const rootId = 'eee111' as RunId;
      const childId = 'fff222' as RunId;
      yield* Effect.promise(() =>
        writeRun(rootId, '2026-07-15T10:00:00.000Z', config('orchestrator')),
      );
      yield* Effect.promise(() =>
        writeRun(childId, '2026-07-15T10:05:00.000Z', config('search'), rootId),
      );

      // A child belongs to its parent's transcript, not to the history list.
      expect((yield* listRuns(session)).map(({ id }) => id)).toEqual([rootId]);
    }),
  );
});
