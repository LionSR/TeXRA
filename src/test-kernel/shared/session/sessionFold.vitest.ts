// The pure fold over a recorded fan-out session: a workflow-script root, one
// child agent run with a grandchild of its own, a background process stream.
// The scenario (`fanOutScenario.ts`) is the commit-ordered event log a
// publisher would replay; every assertion compares the fold's output to the
// existing shared folds it must reproduce, so the two can never drift.

import { describe, expect, it } from 'vitest';

import {
  AgentCategory,
  MESSAGE_TYPES,
  STREAM_LOG_ENTRY_TYPES,
  STREAM_PHASE,
  runIdentityDisplayName,
  type FoldInput,
  type StreamLogEntry,
  type StreamTabId,
  type TaskGroup,
} from '@shared/schemas';
import { projectTranscriptRow, type TranscriptRow } from '@shared/transcript';
import { fold } from '@shared/session/sessionFold';
import {
  emptySessionView,
  type SessionView,
  type StreamView,
} from '@shared/session/sessionView';
import { compareByNewestCreationTime } from '@shared/streams/streamOrdering';
import { upsertTaskGroupFromStreamLog } from '@shared/streams/taskGroupProjection';
import {
  workflowRunModel,
  type ChildRunProgress,
} from '@shared/streams/workflowRunModel';

import {
  CHILD,
  CHILD_IDENTITY,
  GRANDCHILD,
  Log,
  OTHER_OWNER,
  OWNER,
  PROCESS,
  ROOT,
  ROOT_IDENTITY,
  ROOT_POLICY,
  buildScenario,
  foldAll,
  local,
  subscribe,
  tail,
} from './fanOutScenario';

function stream(view: SessionView, id: StreamTabId): StreamView {
  const found = view.streams.get(id);
  if (!found) throw new Error(`stream ${id} missing from the view`);
  return found;
}

/** Full replay through the production reducer (the resync path). */
function taskGroupsOf(entries: readonly StreamLogEntry[]): TaskGroup[] {
  const taskGroups: TaskGroup[] = [];
  const index = new Map<string, number>();
  for (const entry of entries) {
    upsertTaskGroupFromStreamLog(taskGroups, index, entry);
  }
  return taskGroups;
}

/** Sequential projection keyed by id, the way a host upserts rows. */
function rowsOf(entries: readonly StreamLogEntry[]): TranscriptRow[] {
  const byId = new Map<string, TranscriptRow>();
  for (const entry of entries) {
    const row = projectTranscriptRow(entry, {
      previousRow: byId.get(entry.id),
      projectLifecycleToTaskGroups: true,
    });
    if (row) byId.set(entry.id, row);
  }
  return [...byId.values()];
}

const alive = local({ self: [OWNER] });
const nobody = local({});

describe('sessionFold', () => {
  const scenario = buildScenario();

  it('reproduces topology, order, labels, and launch facts from run.start', () => {
    const view = foldAll(scenario.events);
    const root = stream(view, ROOT);
    const child = stream(view, CHILD);

    expect(view.key).toBe('paper');
    const expectedOrder = [...view.streams.values()]
      .filter((s) => s.parentId === null)
      .map((s) => ({ name: s.id, creationTimestamp: s.createdAt }))
      .sort(compareByNewestCreationTime)
      .map((s) => s.name);
    expect(view.order).toStrictEqual(expectedOrder);
    expect(view.order).toStrictEqual([PROCESS, ROOT]);

    expect(root.label).toBe(runIdentityDisplayName(ROOT_IDENTITY));
    expect(root.category).toBe(AgentCategory.Workflow);
    expect(root.executionId).toBe('aaaaaaaaaaaa');
    expect(root.worktree).toStrictEqual({
      workingDirectory: '/paper',
      branch: 'main',
    });
    expect(root.inputFiles).toStrictEqual(['draft.tex']);
    expect(root.childIds).toStrictEqual([CHILD]);
    // The commit ordinal of the stream's run.start, never a clock.
    expect(root.createdAt).toBe(1);
    // The initial snapshot rides run.start; a child without one has no entry.
    expect(view.policy.get(ROOT)).toStrictEqual(ROOT_POLICY);
    expect(view.policy.has(CHILD)).toBe(false);
    expect(child.parentId).toBe(ROOT);
    expect(child.ancestors).toStrictEqual([{ id: ROOT, label: 'review' }]);
    expect(child.childIds).toStrictEqual([GRANDCHILD]);
    expect(stream(view, GRANDCHILD).ancestors).toStrictEqual([
      { id: ROOT, label: 'review' },
      { id: CHILD, label: child.label },
    ]);
    expect(stream(view, GRANDCHILD)).toMatchObject({ outputs: {} });
    expect(child.label).toBe(runIdentityDisplayName(CHILD_IDENTITY));
    expect(child.model).toBe('claude-sonnet-4-5');
    expect(child.followUpSupport).toBe('nativeInteractive');
    expect(child.ownerId).toBe(OWNER);
    // Process streams carry the command, never a model.
    expect(stream(view, PROCESS).command).toBe('npm test');
    expect(stream(view, PROCESS).model).toBeNull();
    expect(stream(view, PROCESS).category).toBe(AgentCategory.ToolUse);
    // The tail advanced the cursor to the last commit.
    expect(view.cursor).toBe(scenario.log.events.length);
  });

  it('folds the transcript through the shared row, group, and run reducers', () => {
    const view = foldAll(scenario.events);
    const root = stream(view, ROOT);
    const child = stream(view, CHILD);

    expect(root.transcript.taskGroups).toStrictEqual(
      taskGroupsOf(scenario.rootEntries),
    );
    expect(root.transcript.rows).toStrictEqual(rowsOf(scenario.rootEntries));
    // The transcript tier retained the rows: the aggregate's newest seq.
    expect(view.folded.get(ROOT)).toBe(
      Math.max(
        ...scenario.log.events
          .filter(
            (e) => e.aggregateId === ROOT && e.type === 'transcript.entry',
          )
          .map((e) => e.seq),
      ),
    );
    // A settled run has printed every row; its newest card is the status line.
    expect(root.transcript.settledRows).toBe(root.transcript.rows.length);
    expect(root.latestLine).toBe('Finished: inspect');

    const childProgress = new Map<StreamTabId, ChildRunProgress>([
      [CHILD, { toolCallCount: 3, outputTokens: 0, costUsd: 0 }],
    ]);
    expect(root.transcript.run).toStrictEqual(
      workflowRunModel({
        taskGroups: root.transcript.taskGroups,
        rows: root.transcript.rows.filter(
          (row) => row.kind === 'workflowTask' || row.kind === 'phase',
        ),
        workflowAttemptId: undefined,
        plan: undefined,
        streamPhase: root.status,
        // No local snapshot in this scenario: nobody holds the owner, so the
        // ended run is durably final.
        runDurablyFinal: true,
        childProgress,
      }),
    );
    expect(root.transcript.run?.childStreamOf.get('call-1')).toBe(CHILD);
    expect(child.transcript.run).toBeNull();
    // A frame derives each board once at its end and lands the same model.
    const batched = fold(emptySessionView('paper'), scenario.events);
    expect(stream(batched, ROOT).transcript.run).toStrictEqual(
      root.transcript.run,
    );
  });

  it('settles status copy, rollups, groups, and the durable outcome from status and result', () => {
    const pending = foldAll([...scenario.pending, alive]);
    const rootPending = stream(pending, ROOT);
    expect(rootPending.status).toBe(STREAM_PHASE.RUNNING);
    expect(rootPending.statusLabel).toBe('Running');
    expect(rootPending.tone).toBe('running');
    expect(rootPending.stage).toStrictEqual({
      kind: 'phase',
      label: 'Map',
      index: 0,
      total: 1,
    });
    expect(rootPending.rollup).toStrictEqual({
      total: 2,
      running: 1,
      finished: 1,
    });
    expect(stream(pending, CHILD).rollup).toStrictEqual({
      total: 1,
      running: 0,
      finished: 1,
    });
    expect(pending.rollup).toStrictEqual({
      running: 1,
      waiting: 1,
      interrupted: 0,
    });

    const settled = foldAll(scenario.events);
    const root = stream(settled, ROOT);
    expect(root.status).toBe(STREAM_PHASE.COMPLETED);
    expect(root.statusLabel).toBe('Completed');
    expect(root.tone).toBe('success');
    expect(root.group).toBe('recent');
    expect(root.forceExpanded).toBe(false);
    expect(root.rollup).toStrictEqual({ total: 2, running: 0, finished: 2 });
    expect(stream(settled, CHILD).runStartedAt).toBeNull();
    expect(settled.approvals).toStrictEqual([]);
    // No snapshot: nobody holds the process stream, which never ran.
    expect(settled.rollup).toStrictEqual({
      running: 0,
      waiting: 0,
      interrupted: 1,
    });

    // The durable outcome: for a run this process owns, the lifecycle's
    // `result` settles it, never the terminal phase alone (a user stop
    // publishes CANCELLED while the flow still writes its closing rows).
    const stopped = fold(
      pending,
      tail(
        scenario.log.emit(CHILD, 1850, {
          type: 'status',
          phase: STREAM_PHASE.CANCELLED,
          previousPhase: STREAM_PHASE.RUNNING,
          cause: 'user',
        }),
      ),
    );
    expect(stream(stopped, CHILD).status).toBe(STREAM_PHASE.CANCELLED);
    expect(stream(stopped, CHILD).durableOutcome).toBeNull();
    const ended = fold(
      stopped,
      tail(
        scenario.log.emit(CHILD, 1851, {
          type: 'result',
          outcome: 'cancelled',
          executionId: 'bbbbbbbbbbbb',
          category: AgentCategory.ToolUse,
          isSubagent: true,
        }),
      ),
    );
    expect(stream(ended, CHILD).durableOutcome).toBe('cancelled');
    // For a run this process does not own, the terminal phase is the story.
    expect(stream(foldAll(scenario.events), CHILD).durableOutcome).toBe(
      'completed',
    );
    expect(stream(pending, GRANDCHILD).durableOutcome).toBe('completed');
  });

  it('folds a pending approval to waiting only with a held owner', () => {
    const withOwner = foldAll([...scenario.pending, alive]);
    expect(withOwner.local.self).toStrictEqual([OWNER]);
    expect(stream(withOwner, CHILD).group).toBe('waiting');
    expect(stream(withOwner, CHILD).approval).toBe('own');
    expect(stream(withOwner, CHILD).forceExpanded).toBe(true);
    expect(stream(withOwner, CHILD).readOnly).toBe(false);
    expect(stream(withOwner, CHILD).statusLabel).toBe('Running');
    expect(stream(withOwner, CHILD).statusDetail).toBeNull();
    expect(stream(withOwner, ROOT).approval).toBe('descendant');
    expect(stream(withOwner, ROOT).group).toBe('running');
    // The path to the decision is forced open.
    expect(stream(withOwner, ROOT).forceExpanded).toBe(true);
    expect(withOwner.approvals.map((a) => a.requestId)).toStrictEqual([
      'req-1',
    ]);

    // The same log with nobody holding the owner: every in-flight run is
    // interrupted, never waiting. The phase stays running and the request
    // stays listed, so a resume can re-ask; the copy is what says
    // interrupted, and the interrupted path is forced open too.
    const interrupted = foldAll([...scenario.pending, nobody]);
    const child = stream(interrupted, CHILD);
    expect(child.group).toBe('interrupted');
    expect(child.approval).toBe('none');
    expect(child.status).toBe(STREAM_PHASE.RUNNING);
    expect(child.statusLabel).toBe('Interrupted');
    expect(child.tone).toBe('warning');
    expect(child.statusDetail).toMatch(/resume/i);
    expect(child.readOnly).toBe(false);
    expect(child.forceExpanded).toBe(true);
    expect(stream(interrupted, ROOT).group).toBe('interrupted');
    expect(stream(interrupted, ROOT).approval).toBe('none');
    expect(stream(interrupted, ROOT).forceExpanded).toBe(true);
    expect(interrupted.approvals).toHaveLength(1);
    // A stream with only its run.start (its process died before the first
    // status) is non-terminal and ownerless: interrupted, and resumable.
    expect(stream(interrupted, PROCESS).status).toBe('ready');
    expect(stream(interrupted, PROCESS).group).toBe('interrupted');
    expect(stream(withOwner, PROCESS).group).toBe('recent');
    expect(interrupted.rollup).toStrictEqual({
      running: 0,
      waiting: 0,
      interrupted: 3,
    });

    // A replay that never received a snapshot folds the same way.
    const unknown = foldAll(scenario.pending);
    expect(stream(unknown, CHILD).group).toBe('interrupted');
    expect(stream(unknown, CHILD).statusLabel).toBe('Interrupted');
  });

  it('reads another live process as held and read-only, and an unreadable run as an overlay', () => {
    const held = foldAll([...scenario.pending, local({ heldBy: [OWNER] })]);
    const child = stream(held, CHILD);
    // Somebody holds the run: waiting, not interrupted; but not ours to act on.
    expect(child.group).toBe('waiting');
    expect(child.readOnly).toBe(true);
    expect(child.statusDetail).toContain('pid 4242');
    expect(stream(held, ROOT).readOnly).toBe(true);
    expect(stream(held, ROOT).group).toBe('running');
    // The holder becomes us: the same owner, still held, now ours to act on.
    const taken = fold(held, local({ self: [OWNER] }));
    expect(stream(taken, CHILD).readOnly).toBe(false);
    expect(stream(taken, ROOT).readOnly).toBe(false);

    const unreadable = foldAll([
      ...scenario.pending,
      local({
        self: [OWNER],
        unreadable: [{ streamId: PROCESS, detail: 'meta.json is unreadable' }],
      }),
    ]);
    expect(stream(unreadable, PROCESS).readOnly).toBe(true);
    expect(stream(unreadable, PROCESS).statusDetail).toBe(
      'meta.json is unreadable',
    );
    expect(stream(unreadable, CHILD).readOnly).toBe(false);

    // The overlay lifts with the next snapshot; the owner change touches
    // exactly the streams that owner holds.
    const lifted = fold(unreadable, local({ self: [OWNER] }));
    expect(stream(lifted, PROCESS).readOnly).toBe(false);
    expect(stream(lifted, PROCESS).statusDetail).toBeNull();
    const foreign = fold(lifted, local({ self: [OTHER_OWNER] }));
    expect(stream(foreign, CHILD).group).toBe('interrupted');
  });

  it('keeps live text in inflight by offsets and joins it to its row whichever arrives first', () => {
    const log = new Log();
    log.emit(CHILD, 1500, {
      type: 'run.start',
      executionId: 'bbbbbbbbbbbb',
      identity: CHILD_IDENTITY,
      category: AgentCategory.ToolUse,
      isRemote: false,
      userFollowUpSupport: 'unsupported',
    });
    const chunk = (
      rowId: string,
      from: number,
      to: number,
      text: string,
    ): FoldInput => ({ _tag: 'chunk', streamId: CHILD, rowId, from, to, text });
    const response = (
      id: string,
      text: string,
      status: 'running' | 'completed',
    ): FoldInput => {
      log.entry(CHILD, 1501, {
        id,
        type: STREAM_LOG_ENTRY_TYPES.LOG,
        messageType: MESSAGE_TYPES.MODEL_RESPONSE,
        text,
        data: { status },
      });
      return tail(log.events.at(-1)!);
    };
    const started = log.events.map(tail);
    // A chunk can reach the fold before its row; a redelivered chunk and a
    // chunk below the text held are no-ops.
    const streaming = foldAll([
      subscribe(CHILD),
      ...started,
      chunk('response-2', 0, 3, 'Ear'),
      response('response-1', '', 'running'),
      chunk('response-1', 0, 3, 'Hel'),
      chunk('response-1', 3, 5, 'lo'),
      chunk('response-1', 0, 3, 'Hel'),
    ]);
    const child = stream(streaming, CHILD);
    const [first] = child.transcript.rows;
    expect(child.transcript.rows).toHaveLength(1);
    expect(first.kind === 'assistant' && first.text.full).toBe('Hello');
    expect(first.kind === 'assistant' && first.streaming).toBe(true);
    expect(streaming.inflight.get(`${CHILD}/response-1`)).toBe('Hello');
    expect(streaming.inflight.get(`${CHILD}/response-2`)).toBe('Ear');
    // A streaming reply is not settled and not yet the latest line.
    expect(child.transcript.settledRows).toBe(0);
    expect(child.latestLine).toBeNull();
    // The row that arrives after its chunks projects with them.
    const view = fold(streaming, response('response-2', '', 'running'));
    const second = stream(view, CHILD).transcript.rows[1];
    expect(second.kind === 'assistant' && second.text.full).toBe('Ear');
    // An entry that folds carrying buffered text seeds the held text, so the
    // bridge's re-delivery of that text from offset zero is a no-op and a
    // later chunk extends it.
    const buffered = foldAll(
      [
        response('response-3', 'Buf', 'running'),
        chunk('response-3', 0, 3, 'Buf'),
        chunk('response-3', 3, 6, 'fer'),
      ],
      view,
    );
    const third = stream(buffered, CHILD).transcript.rows[2];
    expect(third.kind === 'assistant' && third.text.full).toBe('Buffer');
    expect(buffered.inflight.get(`${CHILD}/response-3`)).toBe('Buffer');

    // Durable text wins: the finalizing row drops its entry and a late chunk
    // cannot reopen it; a replacement chunk truncates at `from`.
    const settled = foldAll(
      [
        response('response-1', 'Hello world', 'completed'),
        chunk('response-1', 5, 7, '!!'),
        chunk('response-2', 0, 4, 'Late'),
      ],
      view,
    );
    const rows = stream(settled, CHILD).transcript.rows;
    expect(rows[0].kind === 'assistant' && rows[0].text.full).toBe(
      'Hello world',
    );
    expect(rows[1].kind === 'assistant' && rows[1].text.full).toBe('Late');
    expect(settled.inflight.has(`${CHILD}/response-1`)).toBe(false);
    // A terminal status ends every live row.
    const done = fold(
      settled,
      tail(
        log.emit(CHILD, 1502, {
          type: 'status',
          phase: STREAM_PHASE.COMPLETED,
          previousPhase: STREAM_PHASE.RUNNING,
          cause: 'lifecycle',
        }),
      ),
    );
    expect(done.inflight.size).toBe(0);
  });

  it('keeps listing facts in commit order and transcript rows in seq order, whichever read delivers them', () => {
    const settled = foldAll(scenario.events);
    const rootStatus = scenario.log.events.find(
      (e) => e.aggregateId === ROOT && e.type === 'status',
    )!;
    const rootStart = scenario.log.events.find(
      (e) => e.aggregateId === ROOT && e.type === 'run.start',
    )!;
    const rootEntry = scenario.log.events.find(
      (e) => e.aggregateId === ROOT && e.type === 'transcript.entry',
    )!;
    // An aggregate read replaying an older status, start, or row after the
    // tail folded the current one changes nothing, and the cursor stays.
    const replayed = foldAll(
      [
        { _tag: 'event', read: 'aggregate', event: rootStatus },
        { _tag: 'event', read: 'aggregate', event: rootStart },
        { _tag: 'event', read: 'aggregate', event: rootEntry },
      ],
      settled,
    );
    expect(replayed).toBe(settled);
    expect(replayed.cursor).toBe(settled.cursor);
    // A listing or history row never advances the cursor.
    const listed = fold(emptySessionView('paper', 5), {
      _tag: 'event',
      read: 'listing',
      event: rootStart,
    });
    expect(listed.cursor).toBe(5);
    expect(listed.streams.has(ROOT)).toBe(true);
  });

  it('folds transcript rows only for subscribed aggregates and evicts them on unsubscribe', () => {
    // Nothing subscribed: listing facts fold, rows do not, and `folded`
    // never learns a dropped row.
    const listingOnly = foldAll(scenario.events.slice(1));
    expect(stream(listingOnly, ROOT).status).toBe(STREAM_PHASE.COMPLETED);
    expect(stream(listingOnly, ROOT).transcript.rows).toStrictEqual([]);
    expect(listingOnly.folded.size).toBe(0);

    // Subscribing later reopens from the seq the subscription names.
    const full = foldAll(scenario.events);
    const evicted = fold(full, subscribe(CHILD));
    expect(evicted.folded.has(ROOT)).toBe(false);
    expect(evicted.folded.has(CHILD)).toBe(true);
    const root = stream(evicted, ROOT);
    expect(root.transcript.rows).toStrictEqual([]);
    expect(root.transcript.taskGroups).toStrictEqual([]);
    expect(root.transcript.run?.phases).toStrictEqual([]);
    expect(root.transcript.settledRows).toBe(0);
    // Listing facts stay exactly as they were.
    expect(root.status).toBe(STREAM_PHASE.COMPLETED);
    expect(root.childIds).toStrictEqual([CHILD]);
    expect(evicted.policy.get(ROOT)).toStrictEqual(ROOT_POLICY);
  });

  it('re-roots the children of a tombstoned stream, keeps the tombstone final, and closes the listing at the marker', () => {
    const removed = scenario.log.emit(ROOT, 3000, { type: 'stream.removed' });
    const view = foldAll([tail(removed)], foldAll(scenario.events));
    expect(view.streams.has(ROOT)).toBe(false);
    expect(view.policy.has(ROOT)).toBe(false);
    expect(view.folded.has(ROOT)).toBe(false);
    expect(view.order).toStrictEqual([PROCESS, CHILD]);
    expect(stream(view, CHILD).parentId).toBeNull();
    expect(stream(view, CHILD).ancestors).toStrictEqual([]);
    expect(stream(view, GRANDCHILD).ancestors).toStrictEqual([
      { id: CHILD, label: stream(view, CHILD).label },
    ]);

    // A read replaying the run.start beneath the tombstone does not
    // recreate the stream: the lifecycle pair shares one latest entry.
    const rootStart = scenario.log.events.find(
      (e) => e.aggregateId === ROOT && e.type === 'run.start',
    )!;
    const replayed = fold(view, {
      _tag: 'event',
      read: 'aggregate',
      event: rootStart,
    });
    expect(replayed.streams.has(ROOT)).toBe(false);

    // Listing hydration is authoritative: at the marker, a stream no
    // listing row named is gone with everything a tombstone clears.
    const processStart = scenario.log.events.find(
      (e) => e.aggregateId === PROCESS && e.type === 'run.start',
    )!;
    const pruned = foldAll(
      [
        { _tag: 'event', read: 'listing', event: processStart },
        { _tag: 'replay.complete' },
      ],
      foldAll(scenario.pending),
    );
    expect([...pruned.streams.keys()]).toStrictEqual([PROCESS]);
    expect(pruned.order).toStrictEqual([PROCESS]);
    expect(pruned.approvals).toStrictEqual([]);
    expect(pruned.policy.size).toBe(0);
  });

  it('mints a stream from run.start alone', () => {
    const ghost = 'ghost#eeeeeeeeeeee' as StreamTabId;
    const settled = foldAll(scenario.events);
    const stamp = { seq: 1, commit: 99, ownerId: OWNER, at: 4000 };
    const facts: FoldInput[] = [
      tail({
        ...stamp,
        aggregateId: ghost,
        type: 'updateStreamDescription',
        description: 'boo',
      }),
      tail({
        ...stamp,
        aggregateId: PROCESS,
        seq: 3,
        commit: 100,
        type: 'setParentStream',
        parentStreamId: ghost,
      }),
    ];
    // The run.start alone states resume eligibility: a plain tool-use agent
    // can be resumed natively; a workflow root and a process child cannot.
    expect(stream(settled, CHILD).resumeEligible).toBe(true);
    expect(stream(settled, ROOT).resumeEligible).toBe(false);
    expect(stream(settled, PROCESS).resumeEligible).toBe(false);
    // A fact for a stream with no run.start changes nothing but the cursor;
    // a parent edge to one leaves the child top-level with no dangling edge.
    const ignored = fold(settled, facts[0]);
    expect(ignored.streams).toBe(settled.streams);
    expect(ignored.cursor).toBe(99);
    const reparented = fold(settled, facts[1]);
    expect(reparented.streams.has(ghost)).toBe(false);
    expect(reparented.order).toStrictEqual([PROCESS, ROOT]);
    expect(stream(reparented, PROCESS).parentId).toBeNull();
    expect(stream(reparented, PROCESS).ancestors).toStrictEqual([]);
  });

  it('publishes an immutable level and shares its untouched branches with the next (D5)', () => {
    const before = foldAll(scenario.events);
    const childBefore = stream(before, CHILD);
    const rowsBefore = childBefore.transcript.rows;
    const rowCount = rowsBefore.length;
    const key = `${CHILD}/late`;
    const after = fold(before, [
      tail({
        aggregateId: CHILD,
        seq: before.folded.get(CHILD)! + 1,
        commit: 200,
        ownerId: OWNER,
        at: 4000,
        type: 'transcript.entry',
        entry: {
          id: 'late',
          type: STREAM_LOG_ENTRY_TYPES.LOG,
          messageType: MESSAGE_TYPES.MODEL_RESPONSE,
          text: 'Late',
          data: { status: 'running' },
          seqNo: 999,
          timestamp: 4000,
          level: 'info',
        },
      }),
      {
        _tag: 'chunk',
        streamId: CHILD,
        rowId: 'late',
        from: 4,
        to: 6,
        text: '!!',
      },
    ]);
    // The older level reads what it did when it was published.
    expect(before.streams.get(CHILD)).toBe(childBefore);
    expect(childBefore.transcript.rows).toBe(rowsBefore);
    expect(rowsBefore).toHaveLength(rowCount);
    expect(before.inflight.has(key)).toBe(false);
    // The next level holds the writes ...
    const childAfter = stream(after, CHILD);
    expect(childAfter.transcript.rows).toHaveLength(rowCount + 1);
    expect(after.inflight.get(key)).toBe('Late!!');
    expect(after.streams).not.toBe(before.streams);
    // ... and shares every branch it did not touch by reference.
    expect(after.streams.get(PROCESS)).toBe(before.streams.get(PROCESS));
    expect(stream(after, PROCESS).transcript.rows).toBe(
      stream(before, PROCESS).transcript.rows,
    );
    expect(after.policy).toBe(before.policy);
    expect(after.latest).toBe(before.latest);
    expect(after.queuedFollowUps).toBe(before.queuedFollowUps);
    // A copy belongs to a write, not to an entry: a settled log row projects
    // a row and nothing else, so the touched stream's own task groups and
    // the session's in-flight map (which never held its key) keep theirs.
    const logged = fold(
      after,
      tail({
        aggregateId: CHILD,
        seq: before.folded.get(CHILD)! + 2,
        commit: 201,
        ownerId: OWNER,
        at: 4100,
        type: 'transcript.entry',
        entry: {
          id: 'settled',
          type: STREAM_LOG_ENTRY_TYPES.LOG,
          messageType: MESSAGE_TYPES.MODEL_RESPONSE,
          text: 'Done',
          data: { status: 'completed' },
          seqNo: 1000,
          timestamp: 4100,
          level: 'info',
        },
      }),
    );
    const childLogged = stream(logged, CHILD);
    expect(childLogged.transcript.rows).not.toBe(childAfter.transcript.rows);
    expect(childLogged.transcript.taskGroups).toBe(
      childAfter.transcript.taskGroups,
    );
    expect(logged.inflight).toBe(after.inflight);
  });
});
