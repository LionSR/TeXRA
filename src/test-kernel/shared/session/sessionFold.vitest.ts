// The pure fold over a recorded fan-out session: a background script root, one
// child agent run with a grandchild of its own, a background process run.
// The scenario (`fanOutScenario.ts`) is the commit-ordered event log a
// publisher would replay; every assertion compares the fold's output to the
// existing shared folds it must reproduce, so the two can never drift.

import { describe, expect, it } from 'vitest';

import { Result } from 'effect';

import { ModelOriginSchema } from '@texra-ai/llm';
import { runHistoryRows, storedDraft } from '@agent/runtime/storedTurn';
import {
  qualifyAggregateId,
  emptyRunEndOutput,
  DISPLAY_EVENT_TYPES,
  listingTypeOf,
  MESSAGE_TYPES,
  isTranscriptEvent,
  RUN_PHASE,
  RunIdSchema,
  runIdentityDisplayName,
  SessionEventSchema,
  type CompileFailure,
  type DisplaySessionEvent,
  type FoldInput,
  type OutputFileInfo,
  type RunId,
} from '@shared/schemas';

import type { RunHistoryRow } from '@shared/session/historyTurns';
import { callRequestId } from '@shared/session/inFlight';
import {
  foldRunState,
  unboundRequests,
  type RunHistoryDraft,
} from '@shared/session/runStateFold';
import { fold } from '@shared/session/sessionFold';
import {
  acceptsFollowUp,
  emptySessionView,
  type SessionView,
  type RunView,
} from '@shared/session/sessionView';
import { compareByNewestCreationTime } from '@shared/runs/runOrdering';
import {
  loadSurface,
  persistSurface,
  PersistedSurfaceSchema,
} from '@shared/session/surface';
import { markShownRunSeen, unseenRuns } from '@shared/session/unseenRuns';
import { DOCUMENTS_OUTPUT_ARM, documentsOf } from '@shared/plugins/documents';

import { createExternalLocation } from '@utils/files/fileLocation';

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
  T,
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

/** The three round-keyed maps of a run's documents. */
function roundMapsOf(view: SessionView, id: RunId) {
  return documentsOf(runView(view, id));
}

const alive = local({ self: [OWNER] });
const nobody = local({ dead: [OWNER] });

describe('sessionFold', () => {
  const scenario = buildScenario();

  it.each(['cancelled', 'failed', 'completed'] as const)(
    'keeps the composer available for a %s conversation with saved history',
    (status) => {
      const run = {
        ...runView(foldAll([...scenario.events, nobody]), CHILD),
        parentId: null,
        status,
        durableOutcome: status,
      };
      const host = { terminalBacked: true };
      expect(acceptsFollowUp(run, host)).toBe(true);
      expect(acceptsFollowUp({ ...run, readOnly: true }, host)).toBe(false);
      expect(acceptsFollowUp({ ...run, documentTask: true }, host)).toBe(false);
      expect(
        acceptsFollowUp({ ...run, turn: null, forkPoint: null }, host),
      ).toBe(false);
    },
  );

  it('keeps read conversations read across history replay and restart while detecting later activity', () => {
    const log = new Log();
    const start = log.emit(ROOT, 1000, {
      type: 'run.start',
      identity: ROOT_IDENTITY,
      userFollowUpSupport: 'unsupported',
      parent: null,
      provenance: null,
    });
    const response = log.emit(ROOT, 2000, {
      type: 'response.finalized',
      text: 'Ready for review.',
    });
    const end = log.emit(ROOT, 3000, {
      type: 'run.end',
      outcome: 'completed',
      output: emptyRunEndOutput(),
    });
    const listing = foldAll(
      [start, end].map((event) => ({
        _tag: 'event',
        read: 'listing',
        event,
      })),
    );
    const history = foldAll(
      [subscribe(ROOT), ...log.events.map(tail)],
      listing,
    );
    const surface = loadSurface(
      'paper',
      PersistedSurfaceSchema.parse({ selected: ROOT }),
    );
    const read = markShownRunSeen(surface, history);
    const restarted = loadSurface('paper', persistSurface(read));
    expect(unseenRuns(restarted, listing)).toEqual(new Set());
    expect(runView(history, ROOT).lastTimestamp).toBe(end.at);

    // A partial replay must never move an existing read marker backwards.
    const partial = foldAll([tail(start), subscribe(ROOT), tail(response)]);
    expect(markShownRunSeen(restarted, partial)).toBe(restarted);
    const later = fold(
      history,
      tail(
        log.emit(ROOT, 4000, {
          type: 'run.end',
          outcome: 'completed',
          output: emptyRunEndOutput(),
        }),
      ),
    );
    expect(unseenRuns(restarted, later)).toEqual(new Set([ROOT]));
    expect(unseenRuns(markShownRunSeen(restarted, later), later)).toEqual(
      new Set(),
    );
  });

  it('projects completed trace facts identically live and on replay without folding the listing as transcript', () => {
    const log = new Log();
    const start = log.emit(CHILD, 1000, {
      type: 'run.start',
      identity: CHILD_IDENTITY,
      userFollowUpSupport: 'unsupported',
      parent: null,
      provenance: null,
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
    });
    // A verbose view: transcript verbosity is the view's own flag, read from
    // its config authority at open — never a property of a row.
    const initial = () =>
      foldAll(
        [tail(start), subscribe(CHILD), alive],
        emptySessionView('paper', 0, true),
      );
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
    });
    // The same rows on a quiet view: the debug row is dropped, its cursor
    // still advances.
    const quiet = foldAll(
      log.events
        .filter((event) => event !== hidden)
        .map((event) => ({ _tag: 'event', read: 'aggregate', event })),
      foldAll([subscribe(CHILD), alive], emptySessionView('paper', 0, false)),
    );
    const filtered = fold(quiet, tail(hidden));
    expect(filtered.runs).toBe(quiet.runs);
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
    expect(root.worktree).toStrictEqual({ workingDirectory: '/paper' });
    expect(root.inputFiles).toStrictEqual([]);
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
    expect(child.label).toBe(runIdentityDisplayName(CHILD_IDENTITY));
    expect(child.model).toBe('claude-sonnet-4-5');
    expect(child.followUpSupport).toBe('nativeInteractive');
    expect(child.ownerId).toBe(OWNER);
    // Process runs carry the command, never a model.
    expect(runView(view, PROCESS).command).toBe('npm test');
    expect(runView(view, PROCESS).model).toBeNull();
    // The tail advanced the cursor to the last commit.
    expect(view.cursor).toBe(scenario.log.events.length);
  });

  it('folds the transcript through the shared row, group, and run reducers', () => {
    const view = foldAll(scenario.events);
    const root = runView(view, ROOT);

    // The script stage the pair opened and closed, and the one `agent` call
    // card under it: what the shared group and row reducers make of the
    // root's trace.
    expect(root.transcript.taskGroups).toStrictEqual([
      {
        id: 'script-review',
        name: 'review',
        startTime: T.root + 1,
        status: 'completed',
        kind: 'script',
        endTime: T.childDone + 2,
      },
    ]);
    expect(root.transcript.rows).toMatchObject([
      { id: 'script-review', seqNo: 1, kind: 'log', settlementSeqNo: 1 },
      {
        id: 'call-1',
        seqNo: 2,
        timestamp: T.root + 2,
        settlementSeqNo: 2,
        groupId: 'script-review',
        kind: 'tool',
        toolUse: {
          toolName: 'agent',
          outputText: 'search done',
          headerSummary: "Completed 'custom:search'",
          status: 'completed',
        },
      },
    ]);
    expect(root.transcript.rows).toHaveLength(2);
    // The transcript tier retained the rows: the aggregate's newest seq.
    expect(view.folded.get(qualifyAggregateId('run', ROOT))).toBe(
      Math.max(
        ...scenario.log.events
          .filter(
            (e) =>
              e.aggregateId === qualifyAggregateId('run', ROOT) &&
              (e.type === 'run.activate' ||
                e.type === 'run.end' ||
                isTranscriptEvent(e)),
          )
          .map((e) => e.seq),
      ),
    );
    // A settled run has printed every row.
    expect(root.transcript.settledRows).toBe(root.transcript.rows.length);

    // A frame folds each transcript once at its end and lands the same rows.
    const batched = fold(emptySessionView('paper'), scenario.events);
    expect(runView(batched, ROOT).transcript).toStrictEqual(root.transcript);
  });

  it('settles status copy, rollups, groups, and the durable outcome from the activation and the end', () => {
    const pending = foldAll([...scenario.pending, alive]);
    const rootPending = runView(pending, ROOT);
    expect(rootPending.status).toBe(RUN_PHASE.RUNNING);
    expect(rootPending.statusLabel).toBe('Running');
    expect(rootPending.tone).toBe('running');
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
    expect(settled.requests).toStrictEqual([]);
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
          output: emptyRunEndOutput(),
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
    expect(runView(withOwner, CHILD).statusLabel).toBe('Waiting on you');
    expect(runView(withOwner, CHILD).tone).toBe('warning');
    expect(runView(withOwner, CHILD).statusDetail).toBeNull();
    expect(runView(withOwner, ROOT).approval).toBe('descendant');
    expect(runView(withOwner, ROOT).group).toBe('running');
    // The path to the decision is forced open.
    expect(runView(withOwner, ROOT).forceExpanded).toBe(true);
    expect(withOwner.requests.map((r) => r.requestId)).toStrictEqual(['req-1']);

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
    expect(interrupted.requests).toHaveLength(1);
    // A run with only its run.start (its process died before the first
    // activation) is non-terminal and ownerless: interrupted, and resumable.
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

  it('lists two runs requests of the same id side by side: identity is run and id', () => {
    // The projection dedupes a run's already-listed requests by id alone,
    // so the dedupe must stay scoped to that run: another run may legally
    // hold an open request of the same id, and shadowing it would leave
    // that request without a panel.
    const log = new Log();
    log.emit(CHILD, 1650, {
      type: 'run.start',
      identity: CHILD_IDENTITY,
      userFollowUpSupport: 'unsupported',
      parent: null,
      provenance: null,
    });
    log.emit(PROCESS, 1650, {
      type: 'run.start',
      identity: { kind: 'process', tool: 'bash' },
      parent: null,
      provenance: null,
      userFollowUpSupport: 'unsupported',
    });
    const open = (id: RunId) =>
      log.emit(id, 1651, {
        type: 'request.opened',
        requestId: 'req-1',
        payload: {
          kind: 'bash',
          data: {
            requestId: 'req-1',
            allowBypass: true,
            runId: id,
            command: 'latexmk -pdf main.tex',
          },
        },
      });
    open(CHILD);
    open(PROCESS);
    const view = foldAll([subscribe(CHILD, PROCESS), ...log.events.map(tail)]);
    expect(view.requests.map((r) => [r.runId, r.requestId])).toStrictEqual([
      [CHILD, 'req-1'],
      [PROCESS, 'req-1'],
    ]);
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

  it('projects a running card from its live output and lets the terminal row win', () => {
    const log = new Log();
    log.emit(CHILD, 1600, {
      type: 'run.start',
      identity: CHILD_IDENTITY,
      userFollowUpSupport: 'unsupported',
      parent: null,
      provenance: null,
    });
    const chunk = (from: number, to: number, text: string): FoldInput => ({
      _tag: 'chunk',
      runId: CHILD,
      rowId: 'card',
      from,
      to,
      text,
    });
    const outputOf = (view: SessionView) => {
      const [row] = runView(view, CHILD).transcript.rows;
      return row.kind === 'tool' ? row.toolUse.outputText : null;
    };
    // What the tool prints streams to the open card as transient text (C3),
    // never as a row; a later chunk extends it.
    const running = foldAll([
      subscribe(CHILD),
      ...log.events.map(tail),
      tail(
        log.emit(CHILD, 1601, {
          type: 'tool.start',
          logId: 'card',
          toolName: 'bash',
          input: { command: 'ls' },
        }),
      ),
      chunk(0, 3, 'Hel'),
      chunk(3, 5, 'lo'),
    ]);
    expect(outputOf(running)).toContain('Hello');
    // The terminal row carries the bounded capture and closes the card: a
    // late chunk reaches nothing.
    const settled = foldAll(
      [
        tail(
          log.emit(CHILD, 1602, {
            type: 'tool.end',
            logId: 'card',
            status: 'completed',
            result: { toolName: 'bash', output: { output: 'Hello, world' } },
          }),
        ),
        chunk(5, 9, ' bye'),
      ],
      running,
    );
    expect(outputOf(settled)).toContain('Hello, world');
    expect(outputOf(settled)).not.toContain('bye');
  });

  it('keeps live text by offsets and joins it to its row whichever arrives first', () => {
    const log = new Log();
    log.emit(CHILD, 1500, {
      type: 'run.start',
      identity: CHILD_IDENTITY,
      userFollowUpSupport: 'unsupported',
      parent: null,
      provenance: null,
    });
    const chunk = (
      rowId: string,
      from: number,
      to: number,
      text: string,
    ): FoldInput => ({ _tag: 'chunk', runId: CHILD, rowId, from, to, text });
    const opens = (id: string): FoldInput =>
      tail(
        log.emit(CHILD, 1501, {
          type: 'stream.start',
          id,
          kind: MESSAGE_TYPES.MODEL_RESPONSE,
        }),
      );
    const closes = (id: string, finalText: string): FoldInput =>
      tail(log.emit(CHILD, 1501, { type: 'stream.end', id, finalText }));
    const started = log.events.map(tail);
    // A chunk can reach the fold before its row; a redelivered chunk and a
    // chunk below the text held are no-ops.
    const streaming = foldAll([
      subscribe(CHILD),
      ...started,
      chunk('response-2', 0, 3, 'Ear'),
      opens('response-1'),
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
    const view = fold(streaming, opens('response-2'));
    const second = runView(view, CHILD).transcript.rows[1];
    expect(second.kind === 'assistant' && second.text.full).toBe('Ear');
    // A row's held text is the chunks' own: the first seeds it from offset
    // zero and a later chunk extends it.
    const buffered = foldAll(
      [
        opens('response-3'),
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
        closes('response-1', 'Hello world'),
        chunk('response-1', 5, 7, '!!'),
        chunk('response-2', 0, 4, 'Late'),
      ],
      buffered,
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
          output: emptyRunEndOutput(),
        }),
      ),
    );
    expect(fold(done, chunk('response-2', 4, 5, '!'))).toBe(done);
  });

  it('keeps listing facts in commit order and transcript rows in seq order, whichever read delivers them', () => {
    const settled = foldAll(scenario.events);
    const rootActivate = scenario.log.events.find(
      (e) =>
        e.aggregateId === qualifyAggregateId('run', ROOT) &&
        e.type === 'run.activate',
    )!;
    const rootStart = scenario.log.events.find(
      (e) =>
        e.aggregateId === qualifyAggregateId('run', ROOT) &&
        e.type === 'run.start',
    )!;
    const rootEntry = scenario.log.events.find(
      (e) =>
        e.aggregateId === qualifyAggregateId('run', ROOT) &&
        e.type === 'tool.start',
    )!;
    // An aggregate read replaying an older activation, start, or row after
    // the tail folded the current one changes nothing, and the cursor stays.
    const replayed = foldAll(
      [
        { _tag: 'event', read: 'aggregate', event: rootActivate },
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

  it("sums a run's priced turns once each, on a cold read and on replay", () => {
    // Each `usage` row a replay reads is one priced turn; the listing reads
    // the run's total, on its newest priced row. A turn the run's high-water
    // commit already covers counts nothing.
    const log = new Log();
    const start = log.emit(CHILD, 2000, {
      type: 'run.start',
      identity: CHILD_IDENTITY,
      userFollowUpSupport: 'unsupported',
      parent: null,
      provenance: null,
    });
    const rounds = [
      { inputTokens: 100, outputTokens: 10, cost: 0.25 },
      { inputTokens: 300, outputTokens: 25, cost: 0.5 },
      { inputTokens: 600, outputTokens: 45, cost: 1 },
    ].map((usage, index) =>
      log.emit(CHILD, 2010 + index, { type: 'usage', usage }),
    );
    const total = {
      inputTokens: 1000,
      outputTokens: 80,
      cost: 1.75,
      cacheReadInputTokens: 0,
      cacheMissInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningTokens: 0,
    };

    // The cold listing read: start plus the run's total.
    const listing = foldAll([
      { _tag: 'event', read: 'listing', event: start },
      {
        _tag: 'event',
        read: 'listing',
        event: { ...rounds[2]!, usage: total } as DisplaySessionEvent,
      },
    ]);
    expect(runView(listing, CHILD).usage).toStrictEqual(total);

    // The aggregate replay then brings all three rows back: each counts once.
    const replayed = foldAll(
      rounds.map((event) => ({ _tag: 'event', read: 'aggregate', event })),
      listing,
    );
    expect(runView(replayed, CHILD).usage).toStrictEqual(total);

    // And a replay with no listing read in front reaches the same total.
    const fromScratch = foldAll([
      { _tag: 'event', read: 'aggregate', event: start },
      ...rounds.map((event) => ({
        _tag: 'event' as const,
        read: 'aggregate' as const,
        event,
      })),
    ]);
    expect(runView(fromScratch, CHILD).usage).toStrictEqual(total);
  });

  it("folds each run's tree total once, grandchildren included", () => {
    // Failure modes: a total that adds direct children only; a listing
    // total and its replayed turns counted twice up the tree; a run's own
    // `usage` absorbing its children's.
    const log = new Log();
    const startOf = (id: RunId, parent: RunId | null) =>
      log.emit(id, 4000, {
        type: 'run.start',
        identity: id === ROOT ? ROOT_IDENTITY : CHILD_IDENTITY,
        userFollowUpSupport: 'unsupported',
        parent: parent === null ? null : log.parent(parent),
        provenance: null,
      });
    const starts = [
      startOf(ROOT, null),
      startOf(CHILD, ROOT),
      startOf(GRANDCHILD, CHILD),
    ];
    const turn = (id: RunId, cost: number) =>
      log.emit(id, 4010, {
        type: 'usage',
        usage: { inputTokens: 10, outputTokens: 1, cost },
      });
    const turns = [turn(ROOT, 0.25), turn(CHILD, 0.5), turn(GRANDCHILD, 1)];
    const view = foldAll(
      [...starts, ...turns].map((event) => ({
        _tag: 'event' as const,
        read: 'aggregate' as const,
        event,
      })),
    );
    expect(runView(view, ROOT).usage.cost).toBe(0.25);
    expect(runView(view, ROOT).treeUsage).toMatchObject({
      cost: 1.75,
      inputTokens: 30,
    });
    expect(runView(view, CHILD).treeUsage.cost).toBe(1.5);
    expect(runView(view, GRANDCHILD).treeUsage.cost).toBe(1);

    // A cold listing of the grandchild's total, then its replayed turn:
    // the root's total still counts that turn once.
    const listed = foldAll([
      ...starts.map((event) => ({
        _tag: 'event' as const,
        read: 'listing' as const,
        event,
      })),
      { _tag: 'event', read: 'listing', event: turns[2]! },
      { _tag: 'event', read: 'aggregate', event: turns[2]! },
    ]);
    expect(runView(listed, ROOT).treeUsage.cost).toBe(1);
  });

  it('takes each round map from the newest row, on a cold read and on replay', () => {
    // The documents row is a latest-only listing key, so a cold read hands
    // the fold one row per run. It carries the whole round collection, and
    // the fold replaces rather than merges the derived maps.
    const log = new Log();
    const start = log.emit(CHILD, 3000, {
      type: 'run.start',
      identity: CHILD_IDENTITY,
      userFollowUpSupport: 'unsupported',
      parent: null,
      provenance: null,
    });
    const outputOf = (round: number): OutputFileInfo => ({
      source: `paper_r${round}.tex`,
      location: createExternalLocation(`/tmp/paper_r${round}.tex`),
      round,
      lineage: null,
      diff: null,
    });
    const failureOf = (round: number): CompileFailure => ({
      round,
      displayName: `paper_r${round}.tex`,
      output: createExternalLocation(`/tmp/paper_r${round}.tex`),
      log: createExternalLocation(`/tmp/paper_r${round}.log`),
      logRelativePath: `compile/r${round}.log`,
    });
    const roundOutput = (round: number) => ({
      round,
      outputs: [outputOf(round)],
      compileFailures: round === 0 ? [failureOf(0)] : [],
      missingOutputs: round === 0 ? ['intro.tex'] : [],
    });
    const documentsRow = (rounds: ReturnType<typeof roundOutput>[]) => ({
      type: 'plugin.fact' as const,
      plugin: DOCUMENTS_OUTPUT_ARM.plugin,
      kind: DOCUMENTS_OUTPUT_ARM.kind,
      version: DOCUMENTS_OUTPUT_ARM.version,
      value: { rounds },
      parent: null,
    });
    const firstRound = [log.emit(CHILD, 3010, documentsRow([roundOutput(0)]))];
    const secondRound = [
      log.emit(CHILD, 3020, documentsRow([roundOutput(0), roundOutput(1)])),
    ];
    const bothRounds = {
      // An empty round is not a round the outputs tab shows, so each map
      // drops it.
      files: { 0: [outputOf(0)], 1: [outputOf(1)] },
      missingOutputs: { 0: ['intro.tex'] },
      compileFailures: { 0: [failureOf(0)] },
    };

    // The cold listing read: the start plus the newest row of each type.
    const listing = foldAll([
      { _tag: 'event', read: 'listing', event: start },
      ...secondRound.map((event) => ({
        _tag: 'event' as const,
        read: 'listing' as const,
        event,
      })),
    ]);
    expect(roundMapsOf(listing, CHILD)).toStrictEqual(bothRounds);

    // The aggregate replay then brings the first round's rows back under the
    // listing row; the commit guard drops them and the map stands.
    const replayed = foldAll(
      firstRound.map((event) => ({
        _tag: 'event' as const,
        read: 'aggregate' as const,
        event,
      })),
      listing,
    );
    expect(roundMapsOf(replayed, CHILD)).toStrictEqual(bothRounds);

    // And a replay with no listing read in front reaches the same maps.
    const fromScratch = foldAll(
      [start, ...firstRound, ...secondRound].map((event) => ({
        _tag: 'event' as const,
        read: 'aggregate' as const,
        event,
      })),
    );
    expect(roundMapsOf(fromScratch, CHILD)).toStrictEqual(bothRounds);

    // A row is the map, so a round it does not name is not in the run's
    // state: the newest row replaces what the view holds, never merges.
    const dropped = foldAll(
      [log.emit(CHILD, 3030, documentsRow([roundOutput(1)]))].map((event) => ({
        _tag: 'event' as const,
        read: 'all' as const,
        event,
      })),
      fromScratch,
    );
    expect(roundMapsOf(dropped, CHILD).files).toStrictEqual({
      1: [outputOf(1)],
    });
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
    expect(root.transcript.settledRows).toBe(0);
    // Listing facts stay exactly as they were.
    expect(root.status).toBe(RUN_PHASE.COMPLETED);
    expect(root.childIds).toStrictEqual([CHILD]);
    expect(evicted.policy.get(ROOT)).toStrictEqual(ROOT_POLICY);

    // A subscription can name a stream before its `run.start` commits: the
    // reader reports that aggregate as absent, having no sequence row for
    // it, and the tier must survive that reconciliation or the run's first
    // rows fold into nothing.
    const early = new Log();
    const id = qualifyAggregateId('run', PROCESS);
    const start = early.emit(PROCESS, 5000, {
      type: 'run.start',
      identity: { kind: 'process', tool: 'bash' },
      userFollowUpSupport: 'unsupported',
      parent: null,
      provenance: null,
    });
    const row = early.emit(PROCESS, 5010, {
      type: 'log',
      level: 'info',
      messageType: MESSAGE_TYPES.DEFAULT,
      message: 'the first row\n',
    });
    const started = foldAll([
      subscribe(PROCESS),
      {
        _tag: 'drained',
        cursor: 0,
        existence: {
          checkedAggregateIds: [id],
          claims: [],
        },
      },
      tail(start),
      tail(row),
    ]);
    expect(started.folded.get(id)).toBe(row.seq);
    expect(runView(started, PROCESS).transcript.rows).toHaveLength(1);
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
            claims: [{ aggregateId: processStart.aggregateId, ownerId: OWNER }],
          },
        },
      ],
      foldAll(scenario.pending),
    );
    expect([...pruned.runs.keys()]).toStrictEqual([PROCESS]);
    expect(pruned.order).toStrictEqual([PROCESS]);
    expect(pruned.requests).toStrictEqual([]);
    expect(pruned.policy.size).toBe(0);
  });

  it('lists a queued follow-up once, and not again when its delivery is replayed after consumption', () => {
    const settled = foldAll(scenario.events);
    const aggregateId = qualifyAggregateId('run', CHILD);
    let seq = settled.folded.get(aggregateId)!;
    const row = (commit: number, draft: Record<string, unknown>) =>
      tail({
        ...draft,
        aggregateId,
        seq: ++seq,
        commit,
        origin: OWNER,
        at: 5000,
      } as DisplaySessionEvent);
    const queued = (commit: number, followUpId: string, text: string) =>
      row(commit, {
        type: 'followup.queued',
        followUpId,
        content: {
          text,
          from: {
            kind: 'run' as const,
            runId: 'c41dc41dc41d' as RunId,
            relation: 'child' as const,
          },
        },
      });
    const view = foldAll(
      [
        queued(300, 'delivery-1', 'child result'),
        row(301, { type: 'followup.consumed', followUpId: 'delivery-1' }),
        // The producer replays the same delivery after a restart: a later
        // commit than the consumption, under an id this run already named.
        queued(302, 'delivery-1', 'child result'),
        queued(303, 'delivery-2', 'next result'),
      ],
      settled,
    );
    expect(view.queuedFollowUps.get(CHILD)).toStrictEqual([
      { followUpId: 'delivery-2', text: 'next result' },
    ]);
  });

  it("keeps a user's title over a later model title", () => {
    const settled = foldAll(scenario.events);
    const child = qualifyAggregateId('run', CHILD);
    const next = settled.folded.get(child)! + 1;
    const title = (seq: number, by: 'model' | 'user', description: string) =>
      tail({
        seq,
        commit: 300 + seq,
        origin: OWNER,
        at: 5000 + seq,
        aggregateId: child,
        type: 'run.description',
        by,
        description,
      });
    const renamed = [
      title(next, 'user', 'Renamed'),
      title(next + 1, 'model', 'Summary'),
    ].reduce(fold, settled);
    expect(runView(renamed, CHILD).description).toBe('Renamed');
    expect(runView(renamed, CHILD).title).toBe('Renamed');
    // An empty title names the run by its label, never by ''.
    const blank = fold(renamed, title(next + 2, 'user', ''));
    expect(runView(blank, CHILD).title).toBe(runView(blank, CHILD).label);
  });

  it('mints a run from run.start alone', () => {
    const ghost = 'eeeeeeeeeeee' as RunId;
    const settled = foldAll(scenario.events);
    const stamp = { seq: 1, commit: 99, origin: OWNER, at: 4000 };
    const facts: FoldInput[] = [
      tail({
        ...stamp,
        aggregateId: qualifyAggregateId('run', ghost),
        type: 'run.description',
        by: 'model',
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

  it('refuses a level it has already folded past', () => {
    // The indexes advance in place: a second branch off one level would see
    // the first branch's open card and paint a tool it never started.
    const { log, pending } = buildScenario();
    const base = foldAll(pending);
    const toolStart = (logId: string): FoldInput =>
      tail(
        log.emit(CHILD, T.childDone, {
          type: 'tool.start',
          logId,
          toolName: 'bash',
          input: {},
        }),
      );
    const started = fold(base, toolStart('first'));
    expect(() => fold(base, toolStart('second'))).toThrow('superseded');
    // The level it returned folds on.
    expect(() => fold(started, alive)).not.toThrow();
  });

  it('publishes an immutable level and shares its untouched branches with the next (D5)', () => {
    const before = foldAll(scenario.events);
    const childBefore = runView(before, CHILD);
    const rowsBefore = childBefore.transcript.rows;
    const rowCount = rowsBefore.length;
    const childSeq = before.folded.get(qualifyAggregateId('run', CHILD))!;
    // The settled child takes a follow-up turn: its activation reopens the
    // transcript boundary the terminal outcome closed, then one streaming
    // row opens and its chunks extend it.
    const after = fold(before, [
      tail({
        aggregateId: qualifyAggregateId('run', CHILD),
        seq: childSeq + 1,
        commit: 199,
        origin: OWNER,
        at: 3900,
        type: 'run.activate',
      }),
      tail({
        aggregateId: qualifyAggregateId('run', CHILD),
        seq: childSeq + 2,
        commit: 200,
        origin: OWNER,
        at: 4000,
        type: 'stream.start',
        id: 'late',
        kind: MESSAGE_TYPES.MODEL_RESPONSE,
      }),
      {
        _tag: 'chunk',
        runId: CHILD,
        rowId: 'late',
        from: 0,
        to: 4,
        text: 'Late',
      },
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
        seq: childSeq + 3,
        commit: 201,
        origin: OWNER,
        at: 4100,
        type: 'log',
        level: 'info',
        messageType: MESSAGE_TYPES.MODEL_RESPONSE,
        message: 'Done',
      }),
    );
    const childLogged = runView(logged, CHILD);
    expect(childLogged.transcript.rows).not.toBe(childAfter.transcript.rows);
    expect(childLogged.transcript.taskGroups).toBe(
      childAfter.transcript.taskGroups,
    );
  });
});

// ---------------------------------------------------------------------------
// The run-state fold: the sibling of `fold` that produces what the loop
// continues from. Rows are built through `SessionEventSchema`, the boundary
// that runs in production; nothing here reaches an arm schema directly.
//
// Measured serialized size of the snapshot draft below (aggregate id
// included, parsed defaults filled), so PR 2 has a number before it turns the
// writes on (before the offered toolset joined the tool-use state): tool-use
// with no workspace was 362 bytes. It grows with the flow state it
// carries, never with the conversation, which the rows carry.
// ---------------------------------------------------------------------------

const RUN_HISTORY_RUN = RunIdSchema.parse('ab12cd');
const RUN_HISTORY_AGGREGATE = qualifyAggregateId('run', RUN_HISTORY_RUN);
const ORIGIN = {
  protocol: 'openai-responses',
  requestedModel: 'gpt-test',
  deployment: {
    endpoint: 'https://api.example.test/v1',
    credentialScope: 'openai',
  },
  codecVersion: 1,
} as const;
const INVOCATION = {
  invocationId: '0f1e2d3c-4b5a-4a9b-8c7d-6e5f4a3b2c1d',
  attempt: 1,
} as const;
const RESPONSE_ID = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d';
const USER = (text: string) => ({
  role: 'user',
  content: [{ kind: 'text', text }],
});
const TURN = {
  kind: 'http',
  providerResponseId: 'resp-1',
  requestedOrigin: ORIGIN,
  returnedModel: null,
  modelFingerprint: null,
  content: [
    { kind: 'message', content: [{ kind: 'text', text: 'running ls' }] },
    {
      kind: 'local-call',
      providerCallId: 'call-a',
      name: 'bash',
      argumentsText: '{"command":"ls"}',
    },
    {
      kind: 'local-call',
      providerCallId: 'call-b',
      name: 'bash',
      argumentsText: '{"command":"ls"}',
    },
  ],
  finishReason: 'tool-calls',
  usage: {
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    cachedInputTokens: 4,
    reasoningTokens: null,
  },
};
const CALLS = [
  {
    callId: 'call-a',
    toolName: 'bash',
    ordinal: 0,
    lane: 'barrier',
    replay: 'unsafe',
    duplicateOf: null,
    logId: 'card-0',
    stageId: null,
  },
  {
    callId: 'call-b',
    toolName: 'bash',
    ordinal: 1,
    lane: 'barrier',
    replay: 'unsafe',
    duplicateOf: 'call-a',
    logId: 'card-1',
    stageId: null,
  },
];
/** What the writer stamps beside `calls`: the runtime's priced usage. */
const TURN_USAGE = {
  inputTokens: 10,
  outputTokens: 5,
  cost: 0.25,
  responseTimeMs: 1200,
  provider: 'openai-responses',
  cachedInputTokens: 4,
  cacheMissInputTokens: 6,
};
/** Where the loop stands: its first position opens the run. */
const position = (at: string, turn: number) => ({
  type: 'run.position',
  payload: { family: 'toolUse', at, turn },
});

/** The row a call's body starts with. */
const intent = (callId: string, attempt = 1) => ({
  type: 'tool.intent',
  payload: {
    origin: { kind: 'response', responseId: RESPONSE_ID },
    callId,
    attempt,
  },
});
const message = (payload: Record<string, unknown>) => ({
  type: 'model.message',
  payload,
});
const settlement = (
  callId: string,
  overrides: Record<string, unknown> = {},
) => ({
  type: 'tool.result',
  payload: {
    responseId: RESPONSE_ID,
    callId,
    attempt: 1,
    disposition: 'executed',
    duplicateOf: null,
    result: { status: 'executed', output: 'ok' },
    attachments: [],
    ...overrides,
  },
});
const TOOL_GROUP = {
  role: 'tool',
  results: [
    {
      callOrdinal: 0,
      status: 'success',
      content: [{ kind: 'text', text: 'ok' }],
    },
    {
      callOrdinal: 1,
      status: 'success',
      content: [{ kind: 'text', text: 'ok' }],
    },
  ],
};

/** One committed row, stored and read back through the production boundary. */
const runHistoryRow = (
  commit: number,
  draft: Record<string, unknown>,
): RunHistoryRow =>
  Result.getOrThrow(
    runHistoryRows([
      SessionEventSchema.parse({
        ...storedDraft({
          aggregateId: RUN_HISTORY_AGGREGATE,
          ...draft,
        } as unknown as RunHistoryDraft),
        seq: commit,
        commit,
        origin: null,
        at: 0,
      }),
    ]),
  )[0]!;

/** The same boundary, asked whether it accepts the draft at all. */
const rowAccepted = (draft: Record<string, unknown>): boolean =>
  SessionEventSchema.safeParse({
    aggregateId: RUN_HISTORY_AGGREGATE,
    ...draft,
    seq: 1,
    commit: 1,
    origin: null,
    at: 0,
  }).success;

/** The whole life of one tool-use turn, commit by commit. */
const TURN_ROWS: readonly RunHistoryRow[] = [
  message({
    kind: 'append',
    messages: [USER('list the files')],
    sourceResponse: null,
  }),
  position('turn.ready', 0),
  message({
    kind: 'attempt',
    request: '0'.repeat(64),
    invocation: INVOCATION,
    origin: ORIGIN,
    purpose: 'turn',
  }),
  message({
    kind: 'identified',
    invocation: INVOCATION,
    providerResponseId: 'resp-1',
  }),
  message({
    kind: 'response',
    responseId: RESPONSE_ID,
    invocation: INVOCATION,
    turn: TURN,
    calls: CALLS,
    usage: TURN_USAGE,
  }),
  intent('call-a'),
  settlement('call-a'),
  settlement('call-b', { disposition: 'duplicate', duplicateOf: 'call-a' }),
  message({
    kind: 'append',
    messages: [TOOL_GROUP],
    sourceResponse: RESPONSE_ID,
  }),
  position('results.ready', 1),
  {
    type: 'run.position',
    payload: { family: 'toolUse', at: 'turn.end', turn: 1 },
  },
].map((draft, index) => runHistoryRow(index + 1, draft));

const through = (count: number, ...extra: Record<string, unknown>[]) =>
  foldRunState(null, [
    ...TURN_ROWS.slice(0, count),
    ...extra.map((draft, index) => runHistoryRow(count + index + 1, draft)),
  ]);

const stateOf = <A, E>(result: Result.Result<A, E>): A => {
  if (Result.isFailure(result)) throw result.failure;
  return result.success;
};
const reasonOf = <A>(result: Result.Result<A, { reason: string }>): string =>
  Result.isFailure(result) ? result.failure.reason : 'success';

describe('foldRunState', () => {
  it.each([
    [
      'after the body started, before its result: outcome unknown, never fabricated',
      () => {
        const state = stateOf(through(6));
        expect(state?.pendingResponse?.records['call-a']?.status).toEqual({
          kind: 'started',
          attempt: 1,
        });
        expect(state?.pendingResponse?.records['call-b']?.status).toEqual({
          kind: 'issued',
        });
      },
    ],
    [
      'after a paid response, before the turn-end snapshot: process, never re-invoke',
      () => {
        const state = stateOf(through(5));
        expect(state?.invocation).toBeNull();
        expect(state?.pendingResponse?.responseId).toBe(RESPONSE_ID);
        expect(state?.phase).toBe('model.submitted');
        expect(state?.messages).toHaveLength(1);
      },
    ],
    [
      'during generation, before the response row: the invocation is attributable',
      () => {
        const state = stateOf(through(4));
        expect(state?.invocation?.current.providerResponseId).toBe('resp-1');
        expect(state?.pendingResponse).toBeNull();
      },
    ],
    [
      'approval requested before the body, never resolved: its derived id binds it',
      () => {
        const requestId = callRequestId(
          { responseId: RESPONSE_ID, callId: 'call-a', attempt: 1 },
          1,
        );
        const approval = {
          type: 'request.opened',
          requestId,
          payload: {
            kind: 'bash',
            data: {
              requestId,
              command: 'ls',
              allowBypass: true,
              runId: RUN_HISTORY_RUN,
            },
          },
        };
        // Asked before its body started: nothing ran, whatever the answer,
        // and a resume re-enters the request rather than retiring it.
        const asking = stateOf(through(5, approval));
        expect(asking?.requests[requestId]?.resolved).toBe(false);
        expect(asking?.pendingResponse?.records['call-a']?.status).toEqual({
          kind: 'issued',
        });
        expect(asking === null ? [] : unboundRequests(asking)).toEqual([]);
        // The body starts under it: still the attempt's own request.
        const started = stateOf(through(5, approval, intent('call-a')));
        expect(started?.pendingResponse?.records['call-a']?.status).toEqual({
          kind: 'started',
          attempt: 1,
        });
        expect(started === null ? [] : unboundRequests(started)).toEqual([]);
      },
    ],
    [
      'an inquiry stands unbound; a request that parks a tool does not',
      () => {
        const opened = (payload: Record<string, unknown>) => ({
          type: 'request.opened',
          requestId: 'req-2',
          payload,
        });
        // The inquiry tool returns at once and the answer arrives as a
        // follow-up, so no binding recovers it and none is expected.
        const inquiry = stateOf(
          through(
            6,
            opened({
              kind: 'externalInquiry',
              data: {
                requestId: 'req-2',
                question: 'which branch?',
                threadId: 'ei_0123456789ab',
                allowBypass: false,
                runId: RUN_HISTORY_RUN,
                transcript: [],
              },
            }),
          ),
        );
        expect(inquiry?.requests['req-2']?.resolved).toBe(false);
        expect(inquiry === null ? [] : unboundRequests(inquiry)).toEqual([]);
        // A request that parks a tool is not that case: nothing in a later
        // process could answer it, so a resume retires it first
        // (`RunHistory.acquire`).
        const parking = stateOf(
          through(
            6,
            opened({
              kind: 'bash',
              data: {
                requestId: 'req-2',
                command: 'ls',
                allowBypass: true,
                runId: RUN_HISTORY_RUN,
              },
            }),
          ),
        );
        expect(parking === null ? [] : unboundRequests(parking)).toEqual([
          'req-2',
        ]);
      },
    ],
    [
      'an edit that replaced history mid-run: the range spliced by the row',
      () => {
        const held = stateOf(through(11))?.messages.length ?? 0;
        const compacted = (trigger: 'context-limit') =>
          stateOf(
            through(11, {
              type: 'context.edit',
              payload: {
                cause: 'compaction',
                trigger,
                base: null,
                range: { from: 1, to: held },
                messages: [USER('summary')],
                usage: null,
              },
            }),
          );
        const state = compacted('context-limit');
        expect(state?.messages.map((m) => m.role)).toEqual(['user', 'user']);
        // The edit is the next one's base.
        expect(state?.lastEdit).toBe(12);
      },
    ],
    [
      'restores a response continuation and drops it when its history is replaced',
      () => {
        const continuationOrigin = {
          protocol: 'openai-responses',
          requestedModel: 'gpt-test',
          deployment: {
            endpoint: 'https://api.example.test/v1',
            credentialScope: 'openai',
          },
          codecVersion: 1,
        };
        const anchor = {
          coveredMessages: 1,
          prefixFingerprint: 'a'.repeat(64),
          origin: continuationOrigin,
          anchor: {
            kind: 'stored',
            responseId: 'resp-stored',
            coveredItems: 2,
          },
        };
        const compaction = {
          type: 'context.edit',
          payload: {
            cause: 'compaction',
            trigger: 'context-limit',
            base: null,
            range: { from: 0, to: 1 },
            messages: [USER('summary')],
            usage: null,
          },
        };
        // C6: the response row is the production source of the anchor, so the
        // cold fold a resume reads must restore it.
        const restored = stateOf(
          foldRunState(null, [
            ...TURN_ROWS.slice(0, 2),
            runHistoryRow(
              3,
              message({
                kind: 'attempt',
                request: '0'.repeat(64),
                invocation: INVOCATION,
                origin: continuationOrigin,
                purpose: 'turn',
              }),
            ),
            ...TURN_ROWS.slice(3, 4),
            runHistoryRow(
              5,
              message({
                kind: 'response',
                responseId: RESPONSE_ID,
                invocation: INVOCATION,
                turn: {
                  ...TURN,
                  requestedOrigin: continuationOrigin,
                  continuation: anchor,
                },
                calls: CALLS,
                usage: TURN_USAGE,
              }),
            ),
            ...TURN_ROWS.slice(5),
          ]),
        );
        expect(restored?.continuation).toEqual(anchor);
        // And a compaction that replaced the history it anchored to clears
        // it: continuing from an anchor over a prefix that is gone is the
        // same window in the other direction.
        expect(
          stateOf(foldRunState(restored, [runHistoryRow(12, compaction)]))
            ?.continuation,
        ).toBeNull();
      },
    ],
    [
      'a completed run being continued: a snapshot exists, full stop',
      () => {
        const state = stateOf(
          through(11, {
            type: 'run.position',
            payload: {
              family: 'toolUse',
              at: 'halted',
              outcome: 'completed',
            },
          }),
        );
        expect(state?.outcome).toBe('completed');
        expect(state?.family).toBe('toolUse');
      },
    ],
    [
      'two priced responses and a settlement add: the run cost is the sum',
      () => {
        const second = {
          invocationId: '7c6b5a49-3d2e-4f1a-8b9c-0d1e2f3a4b5c',
          attempt: 1,
        };
        const state = stateOf(
          through(
            11,
            message({
              kind: 'attempt',
              request: '0'.repeat(64),
              invocation: second,
              origin: ORIGIN,
              purpose: 'turn',
            }),
            message({
              kind: 'response',
              responseId: '1b2c3d4e-5f60-4718-9a2b-3c4d5e6f7081',
              invocation: second,
              turn: {
                ...TURN,
                providerResponseId: 'resp-2',
                content: [
                  {
                    kind: 'message',
                    content: [{ kind: 'text', text: 'done' }],
                  },
                ],
                finishReason: 'stop',
                // The package observes tokens and no price: the row's stamp
                // is the only carrier of what the turn cost.
                usage: null,
              },
              calls: [],
              usage: {
                ...TURN_USAGE,
                cost: 0.25,
                cacheMissInputTokens: 3,
              },
            }),
          ),
        );
        // Each priced response's stamp, and nothing else.
        expect(state?.usage.totalCost).toBe(0.5);
        expect(state?.usage.totalCacheMissInputTokens).toBe(9);
        expect(state?.usage.firstInputTokens).toBe(10);
        expect(state?.usage.totalInputTokens).toBe(20);
      },
    ],
    [
      'a provider call id of __proto__: an own entry, never a prototype setter',
      () => {
        const state = stateOf(
          through(
            3,
            message({
              kind: 'response',
              responseId: RESPONSE_ID,
              invocation: INVOCATION,
              turn: {
                ...TURN,
                content: [
                  {
                    kind: 'local-call',
                    providerCallId: '__proto__',
                    name: 'bash',
                    argumentsText: '{"command":"ls"}',
                  },
                ],
              },
              calls: [{ ...CALLS[0], callId: '__proto__' }],
              usage: null,
            }),
            {
              type: 'tool.intent',
              payload: {
                origin: { kind: 'response', responseId: RESPONSE_ID },
                callId: '__proto__',
                attempt: 1,
              },
            },
          ),
        );
        // On a plain object the assignment would call the inherited setter and
        // the barrier would vanish from the state the resume rule reads.
        expect(Object.keys(state?.pendingResponse?.records ?? {})).toEqual([
          '__proto__',
        ]);
        expect(state?.pendingResponse?.records['__proto__']?.status).toEqual({
          kind: 'started',
          attempt: 1,
        });
      },
    ],
    [
      'a run recorded before the run history: null, distinct from corrupt',
      () => {
        expect(
          stateOf(
            foldRunState(null, [
              runHistoryRow(1, {
                type: 'run.start',
                identity: { kind: 'agent', agent: 'chat' },
                userFollowUpSupport: 'unsupported',
                parent: null,
                provenance: null,
              }),
              runHistoryRow(2, {
                type: 'run.activate',
              }),
            ]),
          ),
        ).toBeNull();
      },
    ],
  ])('%s', (_name, check) => check());

  it('stores an accepted remote operation once and reads it back as it was', () => {
    const operation = {
      origin: ORIGIN,
      providerResponseId: 'resp-remote',
      afterSequence: 7,
    };
    const accepted = message({
      kind: 'accepted',
      invocation: INVOCATION,
      operation,
      deadlineAtMs: 1_000,
    });
    const draft = storedDraft({
      aggregateId: RUN_HISTORY_AGGREGATE,
      ...accepted,
    } as unknown as RunHistoryDraft);
    // The cursor is provider evidence, wrapped exactly once.
    expect(draft.type === 'model.message' && draft.payload).toMatchObject({
      operation: {
        evidence: {
          kind: 'openai-responses',
          data: { afterSequence: 7 },
        },
      },
    });
    expect(runHistoryRow(1, accepted)).toMatchObject({
      payload: { operation },
    });
  });

  it('delivers the paid assistant turn once and derives usage from the rows', () => {
    const state = stateOf(through(11));
    expect(state?.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
    ]);
    expect(state?.pendingResponse).toBeNull();
    expect(state?.usage.totalInputTokens).toBe(10);
    expect(state?.usage.totalCacheReadInputTokens).toBe(4);
    // The turn's stamped price: a settlement adds nothing to it.
    expect(state?.usage.totalCost).toBe(0.25);
    expect(state?.at).toBe('turn.end');
    expect(state?.turn).toBe(1);
    // Incremental and cold folds are the same computation.
    const half = stateOf(foldRunState(null, TURN_ROWS.slice(0, 6)));
    expect(stateOf(foldRunState(half, TURN_ROWS.slice(6)))).toEqual(state);
  });

  it.each([
    ['out-of-order', () => foldRunState(null, [TURN_ROWS[1], TURN_ROWS[0]])],
    ['orphan-settlement', () => through(2, settlement('call-a'))],
    [
      // A call's attempt never goes back: attempt 2's body started, so
      // attempt 1 settling now would retire attempt 2's uncertainty silently.
      'out-of-order',
      () => through(6, intent('call-a', 2), settlement('call-a')),
    ],
    [
      // A call settles once.
      'orphan-settlement',
      () => through(7, settlement('call-a', { attempt: 2 })),
    ],
    [
      'mismatched-delivery',
      () =>
        through(
          7,
          message({
            kind: 'append',
            messages: [TOOL_GROUP],
            sourceResponse: RESPONSE_ID,
          }),
        ),
    ],
  ])('refuses loudly: %s', (reason, run) => {
    expect(reasonOf(run())).toBe(reason);
  });

  // A `submit_output` a script issued is the run's structured output, read
  // off the same settlement as a direct call's: under codemode the model
  // submits from inside its script, and losing it would leave the run with
  // no output and a latch that refuses a second submission.
  it('folds a structured output a script submitted', () => {
    const state = stateOf(
      through(
        5,
        {
          type: 'script.call',
          payload: {
            scriptCallId: 'call-a',
            seq: 0,
            callId: 'call-a/0',
            toolName: 'submit_output',
            input: {},
            replay: 'unsafe',
            logId: 'log-s0',
            stageId: 'stage-s',
            phase: null,
          },
        },
        settlement('call-a/0', {
          result: { status: 'executed', output: 'ok', value: { a: 1 } },
        }),
      ),
    );
    expect(state?.structured).toEqual({ value: { a: 1 } });
  });

  it('keeps the private run history types out of the listing and off the transport, and lists run.position', () => {
    const runHistoryTypes = [
      'model.message',
      'context.edit',
      'tool.intent',
      'tool.result',
    ] as const;
    for (const type of runHistoryTypes)
      expect(listingTypeOf({ type })).toBeNull();
    // The one run history row the listing keys: a cold hydrate that dropped it
    // would paint every parked run as ready (ruling A9-5).
    expect(listingTypeOf({ type: 'run.position' })).toBe('run.position');
    for (const row of TURN_ROWS) {
      expect(DISPLAY_EVENT_TYPES.includes(row.type)).toBe(
        row.type === 'run.position',
      );
    }
    // D7: the day a codec version 2 exists, persisted origins must accept a
    // union of version literals while execution admits only the current one.
    expect(ModelOriginSchema.safeParse(ORIGIN).success).toBe(true);
    expect(
      ModelOriginSchema.safeParse({ ...ORIGIN, codecVersion: 2 }).success,
    ).toBe(false);
  });

  it('binds every row to the turn it describes', () => {
    const response = (calls: unknown) =>
      message({
        kind: 'response',
        responseId: RESPONSE_ID,
        invocation: INVOCATION,
        turn: TURN,
        calls,
        usage: null,
      });
    // A dispatch fact stands for one local call: its order, its id, and the
    // tool the provider asked for. Recovery dispatches what the fact names.
    expect(rowAccepted(response(CALLS))).toBe(true);
    expect(
      rowAccepted(response([{ ...CALLS[0], toolName: 'rm' }, CALLS[1]])),
    ).toBe(false);
    // The delivered tool group takes its provider-facing status from the
    // result, so a call the run recorded as failed carries an error result.
    expect(rowAccepted(settlement('call-a', { disposition: 'failed' }))).toBe(
      false,
    );
    expect(
      rowAccepted(
        settlement('call-a', {
          disposition: 'failed',
          result: { status: 'error', error: 'exit 1' },
        }),
      ),
    ).toBe(true);
    // Attachment metadata is JSON. The two binary fields are dropped; a third
    // one under a loose key would be a `JSON.stringify` throw on a live run.
    const attachment = (extra: Record<string, unknown>) =>
      settlement('call-a', {
        result: {
          status: 'executed',
          output: 'ok',
          files: [
            {
              path: 'out/plot.png',
              mimeType: 'image/png',
              bytes: new Uint8Array([1, 2]),
              ...extra,
            },
          ],
        },
      });
    expect(rowAccepted(attachment({ sourceTool: 'bash' }))).toBe(true);
    expect(rowAccepted(attachment({ thumbnail: new Uint8Array([3]) }))).toBe(
      false,
    );
  });
});
