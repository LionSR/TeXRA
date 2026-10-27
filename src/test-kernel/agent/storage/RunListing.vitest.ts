import { it } from '@effect/vitest';
import { Effect, Schema } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

import { listRuns } from '@agent/storage/runListing';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { DatabaseReadFailed } from '@shared/session/database';
import {
  AgentConfigSchema,
  qualifyAggregateId,
  type RunId,
  type RunIdentity,
} from '@shared/schemas';
import { createProcessSession } from '@test/support/sessionTestUtils';
import { setupPlatform } from '@test/support/setupPlatform';
import { seedRunRecord } from '@test/support/runRecordSeeds';

function config(agent: string): AgentConfig {
  return Schema.decodeUnknownSync(AgentConfigSchema)({
    agent,
    model: 'deepseek/deepseek-v4-flash',
    instruction: 'Test run listing.',
    workingDirectory: '/workspace',
  });
}

let session: SessionHandle;

/** Commit the run's `run.start`, the fact its listing row is built from. */
const startRun = (id: RunId, identity: RunIdentity) =>
  session.log.transact([
    {
      type: 'run.start',
      aggregateId: qualifyAggregateId('run', id),
      identity,
      userFollowUpSupport: 'unsupported',
      parent: null,
      provenance: null,
    },
  ]);

/** An agent run: its start and its configuration record. */
const writeRun = (id: RunId, agent: string) =>
  Effect.andThen(
    startRun(id, { kind: 'agent', agent }),
    seedRunRecord(session, id, config(agent)),
  );

describe('run listing normalization', () => {
  setupPlatform({ workspacePath: '/workspace' });

  beforeEach(async () => {
    session = await Effect.runPromise(createProcessSession());
  });

  // A row is dropped only when the facts it is built from are unreadable. The
  // resumability read is not one of them: it decides an advertisement, so an
  // unreadable run record costs the row its Resume affordance, never its
  // place in history.
  it.effect('keeps a row whose resumability read fails, not resumable', () =>
    Effect.gen(function* () {
      const id = 'eee556' as RunId;
      yield* writeRun(id, 'assistant');
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

  it.effect('lists agent runs only, not process storage rows', () =>
    Effect.gen(function* () {
      const processId = 'bbb222' as RunId;
      const customBashAgentId = 'ccc333' as RunId;
      yield* startRun(processId, { kind: 'process', tool: 'assistant' });
      yield* seedRunRecord(session, processId, config('assistant'));
      yield* writeRun(customBashAgentId, 'bash');

      expect(yield* listRuns(session)).toEqual([
        expect.objectContaining({
          id: customBashAgentId,
          identity: { kind: 'agent', agent: 'bash' },
          record: expect.objectContaining({ agent: 'bash' }),
        }),
      ]);
    }),
  );
});
