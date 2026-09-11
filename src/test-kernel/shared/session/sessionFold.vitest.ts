// The pure fold over a recorded fan-out session: a workflow-script root, one
// child agent run with a grandchild of its own, a background process run.
// The scenario (`fanOutScenario.ts`) is the commit-ordered event log a
// publisher would replay; every assertion compares the fold's output to the
// existing shared folds it must reproduce, so the two can never drift.

import { describe, expect, it } from 'vitest';

import {
  aggregateId as qualifyAggregateId,
  AgentCategory,
  emptyRunEndOutput,
  MESSAGE_TYPES,
  isTranscriptEvent,
  STREAM_LOG_ENTRY_TYPES,
  RUN_PHASE,
  runIdentityDisplayName,
  type FoldInput,
  type StreamLogEntry,
  type RunId,
  type TaskGroup,
} from '@shared/schemas';
import { projectTranscriptRow, type TranscriptRow } from '@shared/transcript';
import { fold } from '@shared/session/sessionFold';
import {
  emptySessionView,
  type SessionView,
  type RunView,
} from '@shared/session/sessionView';
import { compareByNewestCreationTime } from '@shared/runs/runOrdering';
import { upsertTaskGroupFromStreamLog } from '@shared/runs/taskGroupProjection';
import {
  workflowRunModel,
  type ChildRunProgress,
} from '@shared/runs/workflowRunModel';

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

function runView(view: SessionView, id: RunId): RunView {
  const found = view.runs.get(id);
  if (!found) throw new Error(`run ${id} missing from the view`);
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
const nobody = local({ dead: [OWNER] });

describe('sessionFold', () => {
  const scenario = buildScenario();

  it('projects completed trace facts identically live and on replay without folding the listing as transcript', () => {
    const log = new Log();
    const start = log.emit(CHILD, 1000, {
      type: 'run.start',
      identity: CHILD_IDENTITY,
      userFollowUpSupport: 'unsupported',
      category: AgentCategory.ToolUse,
      isRemote: false,
      parent: null,
    });
    const stage = log.emit(CHILD, 1010, {
      type: 'stage.start',
      id: 'round',
      label: 'Round 1',
      kind: 'round',
    });
    const opened = log.emit(CHILD, 1020, {
      type: 'stream.start',
      id: 'response',
      kind: 'modelResponse',
      stageId: 'round',
    });
    const completed = log.emit(CHILD, 1030, {
      type: 'stream.end',
      id: 'response',
      finalText: 'The integral is zero.',
      stageId: 'round',
    });
    const completedText = 'The integral vanishes.\n'.repeat(3000);
    const final = log.emit(CHILD, 1040, {
      type: 'response.finalized',
      text: completedText,
      stageId: 'round',
    });
    const ended = log.emit(CHILD, 1050, {
      type: 'stage.end',
      id: 'round',
      status: 'completed',
    });
    const notice = log.emit(CHILD, 1060, {
      type: 'log',
      level: 'info',
      message: 'Calculation complete.',
      stageId: 'round',
    });
    const debug = log.emit(CHILD, 1070, {
      type: 'log',
      level: 'debug',
      message: 'Captured debug detail.',
      transcriptDebug: true,
    });
    const initial = () => foldAll([tail(start), subscribe(CHILD), alive]);
    const live = foldAll(
      [
        tail(stage),
        tail(opened),
        {
          _tag: 'chunk',
          runId: CHILD,
          rowId: 'response',
          from: 0,
          to: 12,
          text: 'The integral',
        },
        ...[completed, final, ended, notice, debug].map(tail),
      ],
      initial(),
    );
    const listing = fold(initial(), {
      _tag: 'event',
      read: 'listing',
      event: stage,
    });
    expect(runView(listing, CHILD).transcript.rows).toEqual([]);
    expect(listing.folded.get(qualifyAggregateId('run', CHILD))).toBe(0);
    const replay = foldAll(
      log.events.map((event) => ({ _tag: 'event', read: 'aggregate', event })),
      listing,
    );
    expect(runView(replay, CHILD).transcript).toEqual(
      runView(live, CHILD).transcript,
    );
    expect(runView(replay, CHILD).transcript.rows).toHaveLength(3);
    expect(runView(replay, CHILD).transcript.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'assistant',
          text: expect.objectContaining({ full: completedText }),
        }),
      ]),
    );
    const hidden = log.emit(CHILD, 1080, {
      type: 'log',
      level: 'debug',
      message: 'Hidden debug detail.',
      transcriptDebug: false,
    });
    const filtered = fold(live, tail(hidden));
    expect(filtered.runs).toBe(live.runs);
    expect(filtered.folded.get(qualifyAggregateId('run', CHILD))).toBe(
      hidden.seq,
    );
  });

  it('reproduces topology, order, labels, and launch facts from run.start', () => {
    const view = foldAll(scenario.events);
    const root = runView(view, ROOT);
    const child = runView(view, CHILD);

    expect(view.key).toBe('paper');
    const expectedOrder = [...view.runs.values()]
      .filter((s) => s.parentId === null)
      .map((s) => ({ name: s.id, creationTimestamp: s.createdAt }))
      .sort(compareByNewestCreationTime)
      .map((s) => s.name);
    expect(view.order).toStrictEqual(expectedOrder);
    expect(view.order).toStrictEqual([PROCESS, ROOT]);

    expect(root.label).toBe(runIdentityDisplayName(ROOT_IDENTITY));
    expect(root.category).toBe(AgentCategory.Workflow);
    expect(root.worktree).toStrictEqual({
      workingDirectory: '/paper',
      branch: 'main',
    });
    expect(root.inputFiles).toStrictEqual(['draft.tex']);
    expect(root.childIds).toStrictEqual([CHILD]);
    // The commit ordinal of the run's run.start, never a clock.
    expect(root.createdAt).toBe(1);
    // The initial snapshot rides run.start; a child without one has no entry.
    expect(view.policy.get(ROOT)).toStrictEqual(ROOT_POLICY);
    expect(view.policy.has(CHILD)).toBe(false);
    expect(child.parentId).toBe(ROOT);
    expect(child.ancestors).toStrictEqual([{ id: ROOT, label: 'review' }]);
    expect(child.childIds).toStrictEqual([GRANDCHILD]);
    expect(runView(view, GRANDCHILD).ancestors).toStrictEqual([
      { id: ROOT, label: 'review' },
      { id: CHILD, label: child.label },
    ]);
    expect(runView(view, GRANDCHILD)).toMatchObject({ outputs: {} });
    expect(child.label).toBe(runIdentityDisplayName(CHILD_IDENTITY));
    expect(child.model).toBe('claude-sonnet-4-5');
    expect(child.followUpSupport).toBe('nativeInteractive');
    expect(child.ownerId).toBe(OWNER);
    // Process runs carry the command, never a model.
    expect(runView(view, PROCESS).command).toBe('npm test');
    expect(runView(view, PROCESS).model).toBeNull();
    expect(runView(view, PROCESS).category).toBe(AgentCategory.ToolUse);
    // The tail advanced the cursor to the last commit.
    expect(view.cursor).toBe(scenario.log.events.length);
  });

  it('folds the transcript through the shared row, group, and run reducers', () => {
    const view = foldAll(scenario.events);
    const root = runView(view, ROOT);
    const child = runView(view, CHILD);

    expect(root.transcript.taskGroups).toStrictEqual(
      taskGroupsOf(scenario.rootEntries),
    );
    expect(root.transcript.rows).toStrictEqual(rowsOf(scenario.rootEntries));
    // The transcript tier retained the rows: the aggregate's newest seq.
    expect(view.folded.get(qualifyAggregateId('run', ROOT))).toBe(
      Math.max(
        ...scenario.log.events
          .filter(
            (e) =>
              e.aggregateId === qualifyAggregateId('run', ROOT) &&
              (e.type === 'transcript.entry' ||
                e.type === 'status' ||
                e.type === 'run.end' ||
                isTranscriptEvent(e)),
          )
          .map((e) => e.seq),
      ),
    );
    // A settled run has printed every row; its newest card is the status line.
    expect(root.transcript.settledRows).toBe(root.transcript.rows.length);
    expect(root.latestLine).toBe('Finished: inspect');

    const childProgress = new Map<RunId, ChildRunProgress>([
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
        runPhase: root.status,
        // No local snapshot in this scenario: nobody holds the owner, so the
        // ended run is durably final.
        runDurablyFinal: true,
        childProgress,
      }),
    );
    expect(root.transcript.run?.childRunOf.get('call-1')).toBe(CHILD);
    expect(child.transcript.run).toBeNull();
    // A frame derives each board once at its end and lands the same model.
    const batched = fold(emptySessionView('paper'), scenario.events);
    expect(runView(batched, ROOT).transcript.run).toStrictEqual(
      root.transcript.run,
    );
  });

  it('settles status copy, rollups, groups, and the durable outcome from status and result', () => {
    const pending = foldAll([...scenario.pending, alive]);
    const rootPending = runView(pending, ROOT);
    expect(rootPending.status).toBe(RUN_PHASE.RUNNING);
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
    expect(runView(pending, CHILD).rollup).toStrictEqual({
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
    const root = runView(settled, ROOT);
    expect(root.status).toBe(RUN_PHASE.COMPLETED);
    expect(root.statusLabel).toBe('Completed');
    expect(root.tone).toBe('success');
    expect(root.group).toBe('recent');
    expect(root.forceExpanded).toBe(false);
    expect(root.rollup).toStrictEqual({ total: 2, running: 0, finished: 2 });
    expect(runView(settled, CHILD).runStartedAt).toBeNull();
    expect(settled.approvals).toStrictEqual([]);
    // No liveness verdict: the current process-run claimant is unprovable.
    expect(settled.rollup).toStrictEqual({
      running: 0,
      waiting: 0,
      interrupted: 0,
    });

    // The durable outcome: for a run this process owns, the `run.end` row
    // settles it. A user stop publishes no terminal status row of its own, so
    // until `run.end` folds the run is still in flight.
    expect(runView(pending, CHILD).status).toBe(RUN_PHASE.RUNNING);
    expect(runView(pending, CHILD).durableOutcome).toBeNull();
    const ended = fold(
      pending,
      tail(
        scenario.log.emit(CHILD, 1851, {
          type: 'run.end',
          outcome: 'cancelled',
          output: emptyRunEndOutput(AgentCategory.ToolUse),
        }),
      ),
    );
    expect(runView(ended, CHILD).status).toBe(RUN_PHASE.CANCELLED);
    expect(runView(ended, CHILD).runStartedAt).toBeNull();
    expect(runView(ended, CHILD).durableOutcome).toBe('cancelled');
    // For a run this process does not own, the terminal phase is the story.
    expect(runView(foldAll(scenario.events), CHILD).durableOutcome).toBe(
      'completed',
    );
    expect(runView(pending, GRANDCHILD).durableOutcome).toBe('completed');
  });

  it('folds a pending approval to waiting only with a held owner', () => {
    const withOwner = foldAll([...scenario.pending, alive]);
    expect(runView(withOwner, CHILD).group).toBe('waiting');
    expect(runView(withOwner, CHILD).approval).toBe('own');
    expect(runView(withOwner, CHILD).forceExpanded).toBe(true);
    expect(runView(withOwner, CHILD).readOnly).toBe(false);
    expect(runView(withOwner, CHILD).statusLabel).toBe('Running');
    expect(runView(withOwner, CHILD).statusDetail).toBeNull();
    expect(runView(withOwner, ROOT).approval).toBe('descendant');
    expect(runView(withOwner, ROOT).group).toBe('running');
    // The path to the decision is forced open.
    expect(runView(withOwner, ROOT).forceExpanded).toBe(true);
    expect(withOwner.approvals.map((a) => a.requestId)).toStrictEqual([
      'req-1',
    ]);

    // The same log with nobody holding the owner: every in-flight run is
    // interrupted, never waiting. The phase stays running and the request
    // stays listed, so a resume can re-ask; the copy is what says
    // interrupted, and the interrupted path is forced open too.
    const interrupted = foldAll([...scenario.pending, nobody]);
    const child = runView(interrupted, CHILD);
    expect(child.group).toBe('interrupted');
    expect(child.approval).toBe('none');
    expect(child.status).toBe(RUN_PHASE.RUNNING);
    expect(child.statusLabel).toBe('Interrupted');
    expect(child.tone).toBe('warning');
    expect(child.statusDetail).toMatch(/resume/i);
    expect(child.readOnly).toBe(false);
    expect(child.forceExpanded).toBe(true);
    expect(runView(interrupted, ROOT).group).toBe('interrupted');
    expect(runView(interrupted, ROOT).approval).toBe('none');
    expect(runView(interrupted, ROOT).forceExpanded).toBe(true);
    expect(interrupted.approvals).toHaveLength(1);
    // A run with only its run.start (its process died before the first
    // status) is non-terminal and ownerless: interrupted, and resumable.
    expect(runView(interrupted, PROCESS).status).toBe('ready');
    expect(runView(interrupted, PROCESS).group).toBe('interrupted');
    expect(runView(withOwner, PROCESS).group).toBe('recent');
    expect(interrupted.rollup).toStrictEqual({
      running: 0,
      waiting: 0,
      interrupted: 3,
    });

    // A current claim without a liveness verdict remains held as unprovable.
    const unknown = foldAll(scenario.pending);
    expect(runView(unknown, CHILD).group).toBe('waiting');
    expect(runView(unknown, CHILD).readOnly).toBe(true);
  });

  it('reads another live process as held and read-only, and an unreadable run as an overlay', () => {
    const held = foldAll([...scenario.pending, local({ dead: [] })]);
    const child = runView(held, CHILD);
    // Somebody holds the run: waiting, not interrupted; but not ours to act on.
    expect(child.group).toBe('waiting');
    expect(child.readOnly).toBe(true);
    expect(child.statusDetail).toContain('pid 4242');
    expect(runView(held, ROOT).readOnly).toBe(true);
    expect(runView(held, ROOT).group).toBe('running');
    // The holder becomes us: the same owner, still held, now ours to act on.
    const taken = fold(held, local({ self: [OWNER] }));
    expect(runView(taken, CHILD).readOnly).toBe(false);
    expect(runView(taken, ROOT).readOnly).toBe(false);

    const unreadable = foldAll([
      ...scenario.pending,
      local({
        self: [OWNER],
        unreadable: [{ runId: PROCESS, detail: 'meta.json is unreadable' }],
      }),
    ]);
    expect(runView(unreadable, PROCESS).readOnly).toBe(true);
    expect(runView(unreadable, PROCESS).statusDetail).toBe(
      'meta.json is unreadable',
    );
    expect(runView(unreadable, CHILD).readOnly).toBe(false);

    // The overlay lifts with the next snapshot; the owner change touches
    // exactly the runs that owner holds.
    const lifted = fold(unreadable, local({ self: [OWNER] }));
    expect(runView(lifted, PROCESS).readOnly).toBe(false);
    expect(runView(lifted, PROCESS).statusDetail).toBeNull();
    const foreign = fold(lifted, local({ self: [OTHER_OWNER] }));
    expect(runView(foreign, CHILD).group).toBe('waiting');
    expect(runView(foreign, CHILD).readOnly).toBe(true);
    const dead = fold(foreign, local({ self: [OTHER_OWNER], dead: [OWNER] }));
    expect(runView(dead, CHILD).group).toBe('interrupted');
  });

  it('keeps live text by offsets and joins it to its row whichever arrives first', () => {
    const log = new Log();
    log.emit(CHILD, 1500, {
      type: 'run.start',
      identity: CHILD_IDENTITY,
      category: AgentCategory.ToolUse,
      isRemote: false,
      userFollowUpSupport: 'unsupported',
      parent: null,
    });
    const chunk = (
      rowId: string,
      from: number,
      to: number,
      text: string,
    ): FoldInput => ({ _tag: 'chunk', runId: CHILD, rowId, from, to, text });
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
    const child = runView(streaming, CHILD);
    const [first] = child.transcript.rows;
    expect(child.transcript.rows).toHaveLength(1);
    expect(first.kind === 'assistant' && first.text.full).toBe('Hello');
    expect(first.kind === 'assistant' && first.streaming).toBe(true);
    // A streaming reply is not settled and not yet the latest line.
    expect(child.transcript.settledRows).toBe(0);
    expect(child.latestLine).toBeNull();
    // The row that arrives after its chunks projects with them.
    const view = fold(streaming, response('response-2', '', 'running'));
    const second = runView(view, CHILD).transcript.rows[1];
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
    const third = runView(buffered, CHILD).transcript.rows[2];
    expect(third.kind === 'assistant' && third.text.full).toBe('Buffer');

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
    const rows = runView(settled, CHILD).transcript.rows;
    expect(rows[0].kind === 'assistant' && rows[0].text.full).toBe(
      'Hello world',
    );
    expect(rows[1].kind === 'assistant' && rows[1].text.full).toBe('Late');
    // The run's end closes every live row: a later chunk reaches none.
    const done = fold(
      settled,
      tail(
        log.emit(CHILD, 1502, {
          type: 'run.end',
          outcome: 'completed',
          output: emptyRunEndOutput(AgentCategory.ToolUse),
        }),
      ),
    );
    expect(fold(done, chunk('response-2', 4, 5, '!'))).toBe(done);
  });

  it('keeps listing facts in commit order and transcript rows in seq order, whichever read delivers them', () => {
    const settled = foldAll(scenario.events);
    const rootStatus = scenario.log.events.find(
      (e) =>
        e.aggregateId === qualifyAggregateId('run', ROOT) &&
        e.type === 'status',
    )!;
    const rootStart = scenario.log.events.find(
      (e) =>
        e.aggregateId === qualifyAggregateId('run', ROOT) &&
        e.type === 'run.start',
    )!;
    const rootEntry = scenario.log.events.find(
      (e) =>
        e.aggregateId === qualifyAggregateId('run', ROOT) &&
        e.type === 'transcript.entry',
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
    expect(listed.runs.has(ROOT)).toBe(true);
  });

  it('folds transcript rows only for subscribed aggregates and evicts them on unsubscribe', () => {
    // Nothing subscribed: listing facts fold, rows do not, and `folded`
    // never learns a dropped row.
    const listingOnly = foldAll(scenario.events.slice(1));
    expect(runView(listingOnly, ROOT).status).toBe(RUN_PHASE.COMPLETED);
    expect(runView(listingOnly, ROOT).transcript.rows).toStrictEqual([]);
    expect(listingOnly.folded.size).toBe(0);

    // The replay every transcript is subscribed to, then a narrower
    // subscription set: only the aggregates it names keep their rows.
    const full = foldAll(scenario.events);
    const evicted = fold(full, subscribe(CHILD));
    expect(evicted.folded.has(qualifyAggregateId('run', ROOT))).toBe(false);
    expect(evicted.folded.has(qualifyAggregateId('run', CHILD))).toBe(true);
    const root = runView(evicted, ROOT);
    expect(root.transcript.rows).toStrictEqual([]);
    expect(root.transcript.taskGroups).toStrictEqual([]);
    expect(root.transcript.run?.phases).toStrictEqual([]);
    expect(root.transcript.settledRows).toBe(0);
    // Listing facts stay exactly as they were.
    expect(root.status).toBe(RUN_PHASE.COMPLETED);
    expect(root.childIds).toStrictEqual([CHILD]);
    expect(evicted.policy.get(ROOT)).toStrictEqual(ROOT_POLICY);
  });

  it('re-roots the children of a tombstoned run, keeps the tombstone final, and closes the listing at the marker', () => {
    const removed = scenario.log.emit(ROOT, 3000, {
      type: 'run.removed',
      runIds: [],
    });
    const view = foldAll([tail(removed)], foldAll(scenario.events));
    expect(view.runs.has(ROOT)).toBe(false);
    expect(view.policy.has(ROOT)).toBe(false);
    expect(view.folded.has(qualifyAggregateId('run', ROOT))).toBe(false);
    expect(view.order).toStrictEqual([PROCESS, CHILD]);
    expect(runView(view, CHILD).parentId).toBeNull();
    expect(runView(view, CHILD).ancestors).toStrictEqual([]);
    expect(runView(view, GRANDCHILD).ancestors).toStrictEqual([
      { id: CHILD, label: runView(view, CHILD).label },
    ]);

    // A read replaying the run.start beneath the tombstone does not
    // recreate the run: the lifecycle pair shares one latest entry.
    const rootStart = scenario.log.events.find(
      (e) =>
        e.aggregateId === qualifyAggregateId('run', ROOT) &&
        e.type === 'run.start',
    )!;
    const replayed = fold(view, {
      _tag: 'event',
      read: 'aggregate',
      event: rootStart,
    });
    expect(replayed.runs.has(ROOT)).toBe(false);

    // Listing hydration is authoritative: at the marker, a run no
    // listing row named is gone with everything a tombstone clears.
    const processStart = scenario.log.events.find(
      (e) =>
        e.aggregateId === qualifyAggregateId('run', PROCESS) &&
        e.type === 'run.start',
    )!;
    const pruned = foldAll(
      [
        { _tag: 'event', read: 'listing', event: processStart },
        {
          _tag: 'replay.complete',
          existence: {
            checkedAggregateIds: [processStart.aggregateId],
            removedAggregateIds: [],
            claims: [{ aggregateId: processStart.aggregateId, ownerId: OWNER }],
          },
        },
      ],
      foldAll(scenario.pending),
    );
    expect([...pruned.runs.keys()]).toStrictEqual([PROCESS]);
    expect(pruned.order).toStrictEqual([PROCESS]);
    expect(pruned.approvals).toStrictEqual([]);
    expect(pruned.policy.size).toBe(0);
  });

  it('mints a run from run.start alone', () => {
    const ghost = 'eeeeeeeeeeee' as RunId;
    const settled = foldAll(scenario.events);
    const stamp = { seq: 1, commit: 99, ownerId: OWNER, at: 4000 };
    const facts: FoldInput[] = [
      tail({
        ...stamp,
        aggregateId: qualifyAggregateId('run', ghost),
        type: 'run.description',
        description: 'boo',
      }),
      tail({
        ...stamp,
        aggregateId: qualifyAggregateId('run', CHILD),
        seq: settled.folded.get(qualifyAggregateId('run', CHILD))! + 1,
        commit: 200,
        type: 'run.detach',
      }),
    ];
    // The run.start alone states resume eligibility: a plain tool-use agent
    // can be resumed natively; a workflow root and a process child cannot.
    expect(runView(settled, CHILD).resumeEligible).toBe(true);
    expect(runView(settled, ROOT).resumeEligible).toBe(false);
    expect(runView(settled, PROCESS).resumeEligible).toBe(false);
    // A fact alone cannot advance the finite-read cursor, and it mints
    // nothing; severing the edge leaves the child top-level.
    const ignored = fold(settled, facts[0]);
    expect(ignored.runs).toBe(settled.runs);
    expect(ignored.cursor).toBe(settled.cursor);
    const detached = fold(settled, facts[1]);
    expect(detached.runs.has(ghost)).toBe(false);
    expect(runView(detached, CHILD).parentId).toBeNull();
    expect(runView(detached, CHILD).ancestors).toStrictEqual([]);
    // Promoted to top level, the detached child takes its creation-time
    // place in the listing rather than being appended to the end.
    expect(detached.order).toStrictEqual([PROCESS, CHILD, ROOT]);
  });

  it('publishes an immutable level and shares its untouched branches with the next (D5)', () => {
    const before = foldAll(scenario.events);
    const childBefore = runView(before, CHILD);
    const rowsBefore = childBefore.transcript.rows;
    const rowCount = rowsBefore.length;
    const after = fold(before, [
      tail({
        aggregateId: qualifyAggregateId('run', CHILD),
        seq: before.folded.get(qualifyAggregateId('run', CHILD))! + 1,
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
        runId: CHILD,
        rowId: 'late',
        from: 4,
        to: 6,
        text: '!!',
      },
    ]);
    // The older level reads what it did when it was published.
    expect(before.runs.get(CHILD)).toBe(childBefore);
    expect(childBefore.transcript.rows).toBe(rowsBefore);
    expect(rowsBefore).toHaveLength(rowCount);
    // The next level holds the writes ...
    const childAfter = runView(after, CHILD);
    expect(childAfter.transcript.rows).toHaveLength(rowCount + 1);
    const late = childAfter.transcript.rows.find((row) => row.id === 'late');
    expect(late?.kind === 'assistant' && late.text.full).toBe('Late!!');
    expect(after.runs).not.toBe(before.runs);
    // ... and shares every branch it did not touch by reference.
    expect(after.runs.get(PROCESS)).toBe(before.runs.get(PROCESS));
    expect(runView(after, PROCESS).transcript.rows).toBe(
      runView(before, PROCESS).transcript.rows,
    );
    expect(after.policy).toBe(before.policy);
    expect(after.queuedFollowUps).toBe(before.queuedFollowUps);
    // A copy belongs to a write, not to an entry: a settled log row projects
    // a row and nothing else, so the touched run's own task groups keep
    // theirs.
    const logged = fold(
      after,
      tail({
        aggregateId: qualifyAggregateId('run', CHILD),
        seq: before.folded.get(qualifyAggregateId('run', CHILD))! + 2,
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
    const childLogged = runView(logged, CHILD);
    expect(childLogged.transcript.rows).not.toBe(childAfter.transcript.rows);
    expect(childLogged.transcript.taskGroups).toBe(
      childAfter.transcript.taskGroups,
    );
  });
});
