/**
 * The session graph's durable boundary (PRD one-fold-three-renderers, 7.1
 * and 7.2, acceptance for lane 2): replay framing and the live-owner
 * waiting rule.
 *
 * Framing: the log a graph is built over is history under the plane's
 * anchor. The fold publishes nothing before the replay marker, so the first
 * state a mounting reader sees already holds the listing, the aggregate
 * history, and the local snapshot; the tail then publishes every commit in
 * order. The waiting rule: a pending approval on a run whose owner this
 * process holds (`self`) or whose owner is alive (`heldBy`) folds to
 * `waiting`; the same log with the owner gone folds to `interrupted`.
 */
import '@test/support/sessionGraphTestSetup';

// Node imports
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Third-party imports
import { it } from '@effect/vitest';
import { Effect, Fiber, Layer, Stream, SubscriptionRef } from 'effect';
import { afterAll, describe, expect, vi } from 'vitest';
import { z } from 'zod';

import {
  SessionEventLog,
  sessionEventsLayer,
} from '@agent/runtime/SessionEvents';
import {
  forEachLiveSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { closeSession, openSession } from '@agent/runtime/sessionGraph';
import { Database, SESSION_DATABASE_FILE } from '@controllers/session/Database';
import {
  LocalRuntimeSource,
  TextChunkSource,
  TranscriptSubscriptions,
} from '@controllers/session/sessionSources';
import { SessionViewService } from '@controllers/session/SessionView';
import { sessionInputsLayer } from '@controllers/session/sessionInputs';
import { WorkspaceRoots } from '@controllers/session/WorkspaceRoots';
import { SHUTDOWN_PHASE_DEADLINE_MS } from '@platform/defaults/lifecycleHost';
import {
  AgentCategory,
  eventFromRow,
  EventRowSchema,
  EventSequenceRowSchema,
  STREAM_PHASE,
  type ExecutionId,
  type SessionEventDraft,
  type StreamTabId,
} from '@shared/schemas';
import { ProcessIdentity, SessionEvents } from '@shared/session/sessionEvents';
import { DownMessageSchema } from '@shared/session/sessionFrames';
import type { SessionView } from '@shared/session/sessionView';
import { testExecutionHandle } from '@test/support/executionHandleFixtures';
import { createFakeWorkspaceRoots } from '@test/support/FakePlatform';
import { StreamLogStore } from '@transcript/StreamLogStore';

const SELF = '4242:self-start';
const OTHER = '4343:other-start';
const STREAM = 'stream:framing' as StreamTabId;
const EXECUTION = 'ab12cd' as ExecutionId;
const OLDER = 'stream:older' as StreamTabId;
const NEWER = 'stream:newer' as StreamTabId;

/** A store holding two finished streams' summaries, as a reopened
 *  workspace does before any graph is built over it. */
function storeWithHistory(): StreamLogStore {
  const store = StreamLogStore.ephemeral('session events history');
  store.recordSummaryMeta(OLDER, {
    executionId: 'a1b2c3' as ExecutionId,
    agentCategory: AgentCategory.ToolUse,
  });
  store.recordSummaryMeta(NEWER, {
    executionId: 'b2c3d4' as ExecutionId,
    agentCategory: AgentCategory.Workflow,
    description: 'the newer run',
  });
  return store;
}

/** Wait on the fold's level until it holds a view `ready` accepts: the ref
 *  replays its current value on subscribe, so a view already there ends the
 *  wait at once and a later one ends it when the fold publishes it. */
const settle = (
  view: SubscriptionRef.SubscriptionRef<SessionView>,
  ready: (view: SessionView) => boolean,
) =>
  SubscriptionRef.changes(view).pipe(Stream.takeUntil(ready), Stream.runDrain);

const runStart: SessionEventDraft = {
  type: 'run.start',
  aggregateId: STREAM,
  executionId: EXECUTION,
  identity: { kind: 'agent', agent: 'chat' },
  userFollowUpSupport: 'unsupported',
  category: AgentCategory.ToolUse,
  isRemote: false,
};

const waiting: SessionEventDraft = {
  type: 'status',
  aggregateId: STREAM,
  phase: STREAM_PHASE.WAITING,
  cause: 'wait',
};

const requested: SessionEventDraft = {
  type: 'approval.requested',
  aggregateId: STREAM,
  requestId: 'req-1',
  payload: {
    kind: 'bash',
    data: {
      requestId: 'req-1',
      command: 'lake build',
      allowBypass: true,
      streamId: STREAM,
    },
  },
};

/** The graph under test, as `sessionLayer` composes it without the runtime
 *  bits: the log seeded with `history` before the plane reads its anchor
 *  (the pre-cutover importer's position), the plane, the fold, and the
 *  three local sources. */
const graph = (
  history: readonly SessionEventDraft[],
  transcripts = StreamLogStore.ephemeral('session events test'),
) => {
  const roots = createFakeWorkspaceRoots({ storagePath: '/workspace/framing' });
  const seeded = Layer.effectDiscard(
    Effect.gen(function* () {
      const log = yield* SessionEventLog;
      yield* log.appendAll(history);
    }),
  );
  return SessionViewService.layer.pipe(
    Layer.provideMerge(sessionInputsLayer),
    Layer.provideMerge(
      sessionEventsLayer.pipe(
        Layer.provideMerge(
          seeded.pipe(
            Layer.provideMerge(SessionEventLog.memoryLayer(transcripts, roots)),
          ),
        ),
      ),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        LocalRuntimeSource.layer,
        TextChunkSource.layer,
        TranscriptSubscriptions.layer,
      ),
    ),
    Layer.provide(Layer.succeed(WorkspaceRoots)(roots)),
    Layer.provide(ProcessIdentity.layer(SELF)),
  );
};

/** What a renderer would draw of each state: the stream's status and the
 *  outstanding approvals, at the state's cursor. */
function drawn(view: SessionView) {
  return {
    cursor: view.cursor,
    status: view.streams.get(STREAM)?.status ?? null,
    approvals: view.approvals.map((a) => a.requestId),
  };
}

/** The drawn states with the stream present, consecutive repeats
 *  collapsed: a local-snapshot replay publishes a state nothing drawn
 *  differs in. */
function drawnSequence(states: Iterable<ReturnType<typeof drawn>>) {
  const seen: ReturnType<typeof drawn>[] = [];
  for (const next of states) {
    if (next.status === null) continue;
    const last = seen.at(-1);
    if (last && JSON.stringify(last) === JSON.stringify(next)) continue;
    seen.push(next);
  }
  return seen;
}

describe('session events and view', () => {
  it.effect(
    'publishes nothing before the marker, then every commit in order',
    () =>
      Effect.gen(function* () {
        const events = yield* SessionEvents;
        const view = yield* SessionViewService;
        // Every state the fold publishes, from before its marker until the
        // tail has folded both live publishes, drawn as it is published: a
        // view's stream index is shared with the views after it. `changes`
        // replays the state it holds on subscribe: the empty view before the
        // marker, or the marker's state when the fold got there first.
        const states = yield* Effect.forkScoped(
          SubscriptionRef.changes(view.ref).pipe(
            Stream.map(drawn),
            Stream.takeUntil((next) => next.cursor >= 5),
            Stream.runCollect,
          ),
        );
        // The marker is out before the tail rows below are published, so
        // they reach the fold as the tail and not as part of its cold read.
        yield* settle(view.ref, (v) => v.streams.has(STREAM));
        yield* events.publish([
          {
            type: 'approval.resolved',
            aggregateId: STREAM,
            requestId: 'req-1',
          },
        ]);
        yield* events.publish([
          {
            type: 'status',
            aggregateId: STREAM,
            phase: STREAM_PHASE.RUNNING,
            previousPhase: STREAM_PHASE.WAITING,
            cause: 'resume',
          },
        ]);
        // The first state with the stream in it has all of the history: no
        // state with the run started but not yet waiting, or waiting with
        // no approval, is ever published. The anchor is the seeded log's
        // level, so the history is under it and the tail repeats none of it.
        expect(drawnSequence(yield* Fiber.join(states))).toEqual([
          { cursor: 3, status: STREAM_PHASE.WAITING, approvals: ['req-1'] },
          { cursor: 4, status: STREAM_PHASE.WAITING, approvals: [] },
          { cursor: 5, status: STREAM_PHASE.RUNNING, approvals: [] },
        ]);
      }).pipe(Effect.provide(graph([runStart, waiting, requested]))),
  );

  it.effect(
    'folds a pending approval to waiting only while its owner is live',
    () =>
      Effect.gen(function* () {
        const view = yield* SessionViewService;
        const local = yield* LocalRuntimeSource;
        yield* settle(view.ref, (v) => v.streams.has(STREAM));
        // This process owns the run: it waits on the user.
        const own = yield* SubscriptionRef.get(view.ref);
        expect(own.streams.get(STREAM)?.group).toBe('waiting');
        expect(own.rollup).toMatchObject({ waiting: 1, interrupted: 0 });
        // The owner is another process that is gone: nothing can answer.
        yield* SubscriptionRef.set(local.ref, {
          self: [OTHER],
          heldBy: [],
          unreadable: [],
        });
        yield* settle(
          view.ref,
          (v) => v.streams.get(STREAM)?.group === 'interrupted',
        );
        const orphaned = yield* SubscriptionRef.get(view.ref);
        expect(orphaned.streams.get(STREAM)?.group).toBe('interrupted');
        expect(orphaned.streams.get(STREAM)?.readOnly).toBe(false);
        // The owner is another process that is alive: held, waiting on it.
        yield* SubscriptionRef.set(local.ref, {
          self: [OTHER],
          heldBy: [SELF],
          unreadable: [],
        });
        yield* settle(
          view.ref,
          (v) => v.streams.get(STREAM)?.readOnly === true,
        );
        const held = yield* SubscriptionRef.get(view.ref);
        expect(held.streams.get(STREAM)?.group).toBe('waiting');
        expect(held.streams.get(STREAM)?.readOnly).toBe(true);
      }).pipe(Effect.provide(graph([runStart, waiting, requested]))),
  );
  it.effect(
    'lists the streams the store held at build below the log, in order and on the wire',
    () =>
      Effect.gen(function* () {
        const events = yield* SessionEvents;
        const log = yield* SessionEventLog;
        const view = yield* SessionViewService;
        yield* settle(view.ref, (v) => v.streams.size === 2);
        const listed = yield* SubscriptionRef.get(view.ref);
        const older = listed.streams.get(OLDER);
        const newer = listed.streams.get(NEWER);
        // Distinct commits in the store's order, so the roster keeps the
        // transcript's creation order rather than falling back to the id.
        expect(older?.createdAt).toBeGreaterThanOrEqual(1);
        expect(newer?.createdAt).toBeGreaterThan(older?.createdAt ?? 0);
        expect(newer?.description).toBe('the newer run');
        // Every listing row is a wire-valid event: the webview parses the
        // replay frame whole and drops it on one bad seq.
        const rows = yield* Stream.runCollect(log.readListing());
        const frame = DownMessageSchema.safeParse({
          kind: 'events',
          session: 'k',
          generation: 0,
          cursor: 0,
          events: rows.map((event) => ({
            _tag: 'event',
            read: 'listing',
            event,
          })),
          chunks: [],
          local: null,
          host: null,
          replayComplete: true,
        });
        expect(
          frame.success,
          frame.success ? '' : JSON.stringify(frame.error.issues, null, 1),
        ).toBe(true);
        // A stream born after the build enters through its own row alone,
        // above the reserved space, so a renderer attached at open sees it
        // as new.
        yield* events.publish([{ ...runStart, aggregateId: STREAM }]);
        yield* settle(view.ref, (v) => v.streams.has(STREAM));
        const live = yield* SubscriptionRef.get(view.ref);
        expect(live.streams.get(STREAM)?.createdAt).toBeGreaterThan(
          newer?.createdAt ?? 0,
        );
        expect(live.streams.size).toBe(3);
      }).pipe(Effect.provide(graph([], storeWithHistory()))),
  );
});

/**
 * The session owner (proposal 2026-09-05, sections 3 and 9): `closeSession`
 * is how a session the `Sessions` map holds behind `openSession` ends.
 */
describe('Sessions owner', () => {
  const open = (storagePath: string) =>
    openSession({
      roots: createFakeWorkspaceRoots({ storagePath }),
      transcripts: StreamLogStore.ephemeral('sessions owner test'),
    });
  const isLive = (session: SessionHandle): boolean => {
    let live = false;
    forEachLiveSession((candidate) => {
      live ||= candidate === session;
    });
    return live;
  };
  const track = (session: SessionHandle, executionId: string) =>
    session.executions.track(
      testExecutionHandle({
        executionId,
        parentStreamId: `stream:${executionId}` as StreamTabId,
        agent: 'chat',
      }),
    );

  it('close reports settled once the run ended, and releases the session', async () => {
    const session = open('/workspace/owner/settled');
    track(session, 'exec:settled');
    // The run completes: its driver untracks it as it unwinds.
    session.executions.untrack('exec:settled');
    // A native child between turns, detached from its stopped parent: its
    // activation is its only record, so the close must stop it itself, and
    // wait for the loop to release the activation after its last delivery.
    let releaseChild = (): void => {};
    const interrupt = vi.fn(() => releaseChild());
    releaseChild = session.executions.reserveChildActivation({
      executionId: 'exec:child' as ExecutionId,
      parentStreamId: 'stream:exec:settled' as StreamTabId,
      childStreamId: 'stream:exec:child' as StreamTabId,
      interrupt,
      detach: () => {},
      isDetached: () => true,
    });

    await expect(closeSession('/workspace/owner/settled')).resolves.toEqual({
      settled: true,
      abandoned: [],
    });
    expect(interrupt).toHaveBeenCalledOnce();
    expect(isLive(session)).toBe(false);
  });

  it('close reports a run still live past the budget as abandoned, and releases the session at its settlement', async () => {
    const session = open('/workspace/owner/abandoned');
    // A run that ignores its interrupt: no handler, no driver to unwind it.
    track(session, 'exec:slow');
    vi.useFakeTimers();
    try {
      const closing = closeSession('/workspace/owner/abandoned');
      await vi.advanceTimersByTimeAsync(SHUTDOWN_PHASE_DEADLINE_MS);
      await expect(closing).resolves.toEqual({
        settled: false,
        abandoned: ['exec:slow'],
      });
    } finally {
      vi.useRealTimers();
    }
    expect(isLive(session)).toBe(true);
    session.executions.untrack('exec:slow');
    await vi.waitFor(() => expect(isLive(session)).toBe(false));
  });
});

/**
 * The cutover substrate (persistence-substrate-decision 6.1, stage 1): the
 * C1 tables and the C6 write path. Nothing production reads them yet, so
 * these assertions are the whole acceptance for the schema and the publisher.
 */
describe('the C1 event table and the C6 publisher', () => {
  const roots: string[] = [];
  const workspace = (): string => {
    const root = mkdtempSync(join(tmpdir(), 'texra-substrate-'));
    roots.push(root);
    return root;
  };
  afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  const substrate = (storage: string) =>
    Database.layer.pipe(
      Layer.provide(Layer.succeed(WorkspaceRoots)({ storage })),
      Layer.provide(ProcessIdentity.layer(SELF)),
    );

  const olderStart: SessionEventDraft = { ...runStart, aggregateId: OLDER };

  /** A connection of the kind another host process would open. */
  const reader = (storage: string): DatabaseSync => {
    const db = new DatabaseSync(join(storage, SESSION_DATABASE_FILE));
    db.exec('PRAGMA busy_timeout = 5000');
    return db;
  };

  it.effect(
    'assigns a dense seq per aggregate and one commit order across them',
    () => {
      const storage = workspace();
      return Effect.gen(function* () {
        const db = yield* Database;
        const first = yield* db.appendAll([runStart, olderStart, waiting], 17);
        const second = yield* db.appendAll([requested], 18);

        expect(
          [...first, ...second].map((e) => [e.aggregateId, e.seq, e.commit]),
        ).toEqual([
          [STREAM, 1, 1],
          [OLDER, 1, 2],
          [STREAM, 2, 3],
          [STREAM, 3, 4],
        ]);
        // The writer is the process, stamped by the layer (C5): no caller
        // passes it, and `at` is the publish clock the batch was given.
        expect(first.every((e) => e.ownerId === SELF && e.at === 17)).toBe(
          true,
        );
        // The wake level is the last commit, and carries no payload (C6).
        expect(yield* SubscriptionRef.get(db.level)).toBe(4);
      }).pipe(Effect.provide(substrate(storage)));
    },
  );

  it.effect(
    'commits rows another process reads back, on a verified WAL connection',
    () => {
      const storage = workspace();
      return Effect.gen(function* () {
        const db = yield* Database;
        yield* db.appendAll([runStart, olderStart], 17);

        // Both tables are read back through their declared row schemas, so
        // a column that drifted from `@shared/schemas/eventRow` fails here
        // rather than at the first read of a real workspace.
        const observed = yield* Effect.sync(() => {
          const raw = reader(storage);
          try {
            return {
              journal: raw.prepare('PRAGMA journal_mode').get()?.journal_mode,
              foreignKeys: raw.prepare('PRAGMA foreign_keys').get()
                ?.foreign_keys,
              events: z.array(EventRowSchema).parse(
                raw
                  .prepare(
                    `SELECT "commit" AS "commit", aggregate_id AS aggregateId,
                            seq, type, owner_id AS ownerId, at, data
                     FROM event ORDER BY "commit"`,
                  )
                  .all(),
              ),
              sequences: z.array(EventSequenceRowSchema).parse(
                raw
                  .prepare(
                    `SELECT aggregate_id AS aggregateId, seq,
                            owner_id AS ownerId, parent_id AS parentId, closed
                     FROM event_sequence ORDER BY aggregate_id`,
                  )
                  .all(),
              ),
              integrity: raw.prepare('PRAGMA integrity_check').get()
                ?.integrity_check,
            };
          } finally {
            raw.close();
          }
        });

        expect(observed.journal).toBe('wal');
        expect(observed.foreignKeys).toBe(1);
        expect(observed.integrity).toBe('ok');
        expect(
          observed.events.map((row) => [row.aggregateId, row.seq, row.type]),
        ).toEqual([
          [STREAM, 1, 'run.start'],
          [OLDER, 1, 'run.start'],
        ]);
        // The payload column holds the arm and nothing the envelope columns
        // already carry, and decodes back to the event that was published.
        expect(eventFromRow(observed.events[0]!)).toMatchObject({
          type: 'run.start',
          aggregateId: STREAM,
          seq: 1,
          commit: 1,
          ownerId: SELF,
          at: 17,
          executionId: EXECUTION,
        });
        // A sequence row per aggregate, claimed by its creator, an independent
        // root, and open (C9's closure is stage 6).
        expect(observed.sequences).toEqual([
          {
            aggregateId: STREAM,
            seq: 1,
            ownerId: SELF,
            parentId: null,
            closed: 0,
          },
          {
            aggregateId: OLDER,
            seq: 1,
            ownerId: SELF,
            parentId: null,
            closed: 0,
          },
        ]);
      }).pipe(Effect.provide(substrate(storage)));
    },
  );

  it.effect(
    'rejects a batch before it opens a transaction, leaving nothing behind',
    () => {
      const storage = workspace();
      return Effect.gen(function* () {
        const db = yield* Database;
        yield* db.appendAll([runStart], 17);
        // The publish clock must be whole milliseconds: C1 stores it in an
        // INTEGER column of a STRICT table, and validation happens before
        // BEGIN IMMEDIATE so a rejected batch never holds the write lock.
        const failure = yield* Effect.flip(db.appendAll([waiting], 17.5));

        expect(failure._tag).toBe('DatabaseWriteFailed');
        const rows = yield* Effect.sync(() => {
          const raw = reader(storage);
          try {
            return raw.prepare('SELECT seq FROM event').all();
          } finally {
            raw.close();
          }
        });
        expect(rows).toEqual([{ seq: 1 }]);
        expect(yield* SubscriptionRef.get(db.level)).toBe(1);
      }).pipe(Effect.provide(substrate(storage)));
    },
  );

  it.effect('reopens at the committed ordinal and never reuses one', () => {
    const storage = workspace();
    const append = Effect.gen(function* () {
      const db = yield* Database;
      return yield* db.appendAll([runStart, waiting], 17);
    }).pipe(Effect.provide(substrate(storage)));
    return Effect.gen(function* () {
      yield* append;
      // A second host process deletes the whole aggregate: the C1 cascade
      // takes its events with it, and the AUTOINCREMENT high-water mark
      // stays where it was, so no cursor already handed out is invalidated.
      yield* Effect.sync(() => {
        const raw = reader(storage);
        try {
          raw.exec('PRAGMA foreign_keys = ON');
          raw
            .prepare('DELETE FROM event_sequence WHERE aggregate_id = ?')
            .run(STREAM);
          expect(raw.prepare('SELECT COUNT(*) AS n FROM event').get()?.n).toBe(
            0,
          );
        } finally {
          raw.close();
        }
      });

      const reopened = yield* Effect.gen(function* () {
        const db = yield* Database;
        return {
          level: yield* SubscriptionRef.get(db.level),
          next: yield* db.appendAll([runStart], 18),
        };
      }).pipe(Effect.provide(substrate(storage)));

      expect(reopened.level).toBe(2);
      expect(reopened.next.map((e) => e.commit)).toEqual([3]);
    });
  });

  it.effect('answers the three C7 reads from the C1 indexes', () => {
    const storage = workspace();
    return Effect.gen(function* () {
      const db = yield* Database;
      yield* db.appendAll([runStart, olderStart, waiting], 17);

      const plans = yield* Effect.sync(() => {
        const raw = reader(storage);
        const plan = (sql: string): string =>
          raw
            .prepare(`EXPLAIN QUERY PLAN ${sql}`)
            .all()
            .map((row) => String(row.detail))
            .join(' | ');
        try {
          return {
            latestOfType: plan(
              'SELECT * FROM event WHERE aggregate_id = ? AND type = ? ORDER BY seq DESC LIMIT 1',
            ),
            fromCommit: plan(
              'SELECT * FROM event WHERE aggregate_id = ? AND "commit" > ?',
            ),
            listing: plan(
              'SELECT * FROM event WHERE type = ? ORDER BY "commit"',
            ),
            aggregateFromSeq: plan(
              'SELECT * FROM event WHERE aggregate_id = ? AND seq >= ? ORDER BY seq',
            ),
          };
        } finally {
          raw.close();
        }
      });

      expect(plans.latestOfType).toContain('event_agg_type_seq');
      expect(plans.fromCommit).toContain('event_agg_commit');
      expect(plans.listing).toContain('event_type_commit');
      // The UNIQUE(aggregate_id, seq) constraint is also the index one
      // aggregate's history reads from its seq.
      expect(plans.aggregateFromSeq).toContain('sqlite_autoindex_event_1');
    }).pipe(Effect.provide(substrate(storage)));
  });
});
