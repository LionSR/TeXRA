/** Event-backed transcript reads fold the same entries the live recorder does. */
import { it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { describe, expect } from 'vitest';

import { databaseLayer } from '@controllers/session/Database';
import { WorkspaceRoots } from '@controllers/session/WorkspaceRoots';
import {
  aggregateId,
  isTranscriptEvent,
  type RunId,
  type SessionEventDraft,
} from '@shared/schemas';
import { Database } from '@shared/session/database';
import { ProcessIdentity } from '@shared/session/sessionEvents';
import { StreamLog } from '@shared/session/traceEntries';
import { createTranscriptFold } from '@shared/session/traceFold';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { StreamLogStore } from '@transcript/StreamLogStore';

const RUN = 'ab12cd' as RunId;
const start: SessionEventDraft = {
  type: 'run.start',
  aggregateId: aggregateId('run', RUN),
  identity: { kind: 'agent', agent: 'chat' },
  userFollowUpSupport: 'unsupported',
  category: 'toolUse',
  isRemote: false,
  parent: null,
};
const substrate = databaseLayer('ephemeral').pipe(
  Layer.provide(
    Layer.succeed(WorkspaceRoots)({ storage: '/transcript-read-test' }),
  ),
  Layer.provide(ProcessIdentity.layer('["test-host",4242,"self-start"]')),
  Layer.provide(nodePlatformLayer),
);

const history: SessionEventDraft[] = [
  start,
  {
    type: 'stage.start',
    aggregateId: start.aggregateId,
    id: 'round',
    label: 'Round 1',
    kind: 'round',
  },
  {
    type: 'stream.start',
    aggregateId: start.aggregateId,
    id: 'response',
    kind: 'modelResponse',
    stageId: 'round',
  },
  {
    type: 'stream.end',
    aggregateId: start.aggregateId,
    id: 'response',
    finalText: 'The integral vanishes.',
  },
  {
    type: 'stage.end',
    aggregateId: start.aggregateId,
    id: 'round',
    status: 'completed',
  },
];

describe('StreamLogStore event reads', () => {
  it.effect('folds cold reads identically to live entries', () =>
    Effect.gen(function* () {
      const database = yield* Database;
      const rows = yield* database.appendAll(history);
      const store = StreamLogStore.open(database);
      const live = new StreamLog();
      const fold = createTranscriptFold(live);
      for (const row of rows) {
        if (isTranscriptEvent(row))
          fold.record(row, {
            at: row.at,
            id: JSON.stringify([row.aggregateId, row.seq]),
            debug: false,
          });
      }
      expect(yield* store.readEntries(RUN)).toEqual(live.toJSON());
    }).pipe(Effect.provide(substrate)),
  );

  it.effect('observes a committed deletion', () =>
    Effect.gen(function* () {
      const database = yield* Database;
      yield* database.appendAll(history);
      const store = StreamLogStore.open(database);
      yield* database.appendAll([
        { type: 'run.removed', aggregateId: start.aggregateId },
      ]);
      expect(yield* store.readEvents(RUN)).toEqual([]);
      expect(yield* store.readEntries(RUN)).toEqual([]);
    }).pipe(Effect.provide(substrate)),
  );
});
