/**
 * Retained finished children: the parent's subagent rows keep a terminal status
 * after a child drops out of the live roster, and give it up only when the
 * child comes back or the parent re-enters running.
 */

// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { describe, expect, it, vi } from 'vitest';

import type { ProgressBackend } from '@controllers/progressView/backend/ProgressBackend';
import {
  AgentCategory,
  type ActiveChildInfo,
  STREAM_PHASE,
  type ExecutionId,
  type StreamTabId,
} from '@shared/schemas';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { STREAM_TRANSITION_CAUSE } from '@shared/streams/streamStatus';
import { testExecutionHandle } from '@test/support/executionHandleFixtures';

import { snapshotFacts } from '@test/support/storeTestDrivers';
import {
  createIsolatedRecordingBackend,
  createRecordingBackend,
  track,
} from './progressBackendHarness';

describe('retained finished children', () => {
  const PARENT = 'parent-stream' as StreamTabId;

  function subagent(
    id: string,
    overrides: Partial<ActiveChildInfo> = {},
  ): ActiveChildInfo {
    return {
      executionId: id,
      childStreamId: `${id}-stream` as StreamTabId,
      agentName: `agent-${id}`,
      status: STREAM_PHASE.RUNNING,
      ...overrides,
    } as ActiveChildInfo;
  }

  function seedParent(backend: ProgressBackend): void {
    backend.state.streamLogs.ensureStream(PARENT);
    backend.state.getOrCreateStreamState(PARENT, AgentCategory.Workflow);
    backend.state.switchActiveStream(PARENT);
  }

  it('keeps a vanished child as a row stamped with finishedAt', () => {
    const { backend } = createRecordingBackend();
    seedParent(backend);

    backend.factApplier.updateChildRoster(PARENT, [
      subagent('a'),
      subagent('b'),
    ]);
    backend.factApplier.updateChildRoster(PARENT, [subagent('a')]);

    const roster = backend.state.getStreamState(PARENT)?.subagents ?? [];
    expect(roster).toHaveLength(2);
    expect(roster.find((c) => c.executionId === 'a')?.finishedAt).toBe(
      undefined,
    );
    expect(
      roster.find((c) => c.executionId === 'b')?.finishedAt,
    ).toBeGreaterThan(0);
  });

  it('promotes a retained child back to one live row when it reappears', () => {
    const { backend } = createRecordingBackend();
    seedParent(backend);
    const child = subagent('resumed');

    backend.factApplier.updateChildRoster(PARENT, [child]);
    let roster = backend.state.getStreamState(PARENT)?.subagents ?? [];
    expect(roster).toHaveLength(1);
    expect(roster[0]?.finishedAt).toBeUndefined();

    backend.factApplier.updateChildRoster(PARENT, []);
    roster = backend.state.getStreamState(PARENT)?.subagents ?? [];
    expect(roster).toHaveLength(1);
    expect(roster[0]?.finishedAt).toBeGreaterThan(0);

    backend.factApplier.updateChildRoster(PARENT, [child]);
    roster = backend.state.getStreamState(PARENT)?.subagents ?? [];
    expect(roster).toHaveLength(1);
    expect(roster[0]?.finishedAt).toBeUndefined();

    backend.factApplier.updateChildRoster(PARENT, []);
    roster = backend.state.getStreamState(PARENT)?.subagents ?? [];
    expect(roster).toHaveLength(1);
    expect(roster[0]?.finishedAt).toBeGreaterThan(0);
    expect(new Set(roster.map((entry) => entry.executionId)).size).toBe(1);
  });

  it('never marks anything finished from a first roster', () => {
    const { backend } = createRecordingBackend();
    seedParent(backend);

    backend.factApplier.updateChildRoster(PARENT, [subagent('a')]);

    const roster = backend.state.getStreamState(PARENT)?.subagents ?? [];
    expect(roster.map((c) => c.executionId)).toEqual(['a']);
    expect(roster[0]?.finishedAt).toBeUndefined();
  });

  it('shows a terminal status that lands after the roster drop', async () => {
    const { backend, messages } = createRecordingBackend();
    seedParent(backend);
    const child = subagent('late');
    const childStreamId = 'late-stream' as StreamTabId;
    snapshotFacts(backend.state.snapshots).setParentStream(
      childStreamId,
      PARENT,
    );

    // Roster drop first — the child is still `running` at this point.
    backend.factApplier.updateChildRoster(PARENT, [child]);
    backend.factApplier.updateChildRoster(PARENT, []);
    messages.length = 0;

    // Terminal status arrives afterwards.
    backend.state.streamStatus.transitionToTerminal(
      childStreamId,
      STREAM_PHASE.COMPLETED,
      STREAM_TRANSITION_CAUSE.LIFECYCLE,
    );
    await backend.factApplier.setStreamStatus(
      childStreamId,
      STREAM_PHASE.COMPLETED,
    );

    const badges = messages.filter(
      (message) =>
        message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_BADGES,
    );
    expect(badges.at(-1)).toMatchObject({
      stream: PARENT,
      subagents: [
        expect.objectContaining({
          executionId: 'late',
          status: STREAM_PHASE.COMPLETED,
        }),
      ],
    });
  });

  it('keeps the resolved terminal status on a later structural sync', async () => {
    const { backend, messages } = createIsolatedRecordingBackend();
    backend.setupEventListeners();
    seedParent(backend);
    const childStreamId = 'doomed-stream' as StreamTabId;
    snapshotFacts(backend.state.snapshots).setParentStream(
      childStreamId,
      PARENT,
    );

    // Roster drop first, so the retained row is stamped `running`.
    backend.factApplier.updateChildRoster(PARENT, [
      subagent('doomed', { childStreamId }),
    ]);
    backend.factApplier.updateChildRoster(PARENT, []);
    // Transition the status machine and nothing else: its fact is the single
    // owner of a roster row's phase, so the retained row must be written by
    // this call alone, with no read-time repair on the send paths.
    backend.state.streamStatus.transitionToTerminal(
      childStreamId,
      STREAM_PHASE.FAILED,
      STREAM_TRANSITION_CAUSE.LIFECYCLE,
    );
    expect(backend.state.getStreamState(PARENT)?.subagents?.[0]?.status).toBe(
      STREAM_PHASE.FAILED,
    );
    messages.length = 0;

    // A structural rebuild (view reopen, theme change, filter switch) is the
    // frontend's other writer of `subagents`; it must overlay the stale row
    // with the authoritative status-machine outcome.
    backend.webviewUpdater.sendStreamMetadata(
      backend.state,
      backend.factApplier.getAllStreamStates(),
    );
    backend.webviewUpdater.updateStreamMetadata(
      backend.state,
      PARENT,
      backend.factApplier.getAllStreamStates(),
    );

    const rosters = messages.flatMap((message) => {
      if (message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAMS) {
        return [message.streamStates?.[PARENT]?.subagents ?? []];
      }
      if (message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_METADATA) {
        return [message.streamState.subagents];
      }
      return [];
    });

    expect(rosters).toHaveLength(2);
    for (const roster of rosters) {
      expect(roster).toEqual([
        expect.objectContaining({
          executionId: 'doomed',
          status: STREAM_PHASE.FAILED,
        }),
      ]);
    }
  });

  it('keeps a recorded terminal phase when a stale roster still says running', async () => {
    const { backend, messages } = createRecordingBackend();
    seedParent(backend);
    const childStreamId = 'stale-stream' as StreamTabId;
    const live = subagent('stale', { childStreamId });

    backend.factApplier.updateChildRoster(PARENT, [live]);
    await backend.factApplier.setStreamStatus(
      childStreamId,
      STREAM_PHASE.FAILED,
    );
    messages.length = 0;

    // A roster snapshot stamped before the transition, delivered after it: the
    // child is still tracked, so it arrives as a live row carrying `running`.
    backend.factApplier.updateChildRoster(PARENT, [live]);

    const roster = backend.state.getStreamState(PARENT)?.subagents ?? [];
    expect(roster).toEqual([
      expect.objectContaining({
        executionId: 'stale',
        status: STREAM_PHASE.FAILED,
      }),
    ]);
    expect(roster[0]?.finishedAt).toBeUndefined();
    // No further status fact arrives for a terminal child, so the badge push
    // driven by the stale roster is the last word on the wire.
    expect(
      messages.findLast(
        (message) =>
          message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_BADGES,
      ),
    ).toMatchObject({
      stream: PARENT,
      subagents: [
        expect.objectContaining({
          executionId: 'stale',
          status: STREAM_PHASE.FAILED,
        }),
      ],
    });
  });

  it('takes the emitted phase when a retained child goes live again', () => {
    const { backend } = createRecordingBackend();
    seedParent(backend);
    const childStreamId = 'requeued-stream' as StreamTabId;

    backend.factApplier.updateChildRoster(PARENT, [
      subagent('requeued', { childStreamId, status: STREAM_PHASE.WAITING }),
    ]);
    backend.factApplier.updateChildRoster(PARENT, []);
    backend.factApplier.updateChildRoster(PARENT, [
      subagent('requeued', { childStreamId, status: STREAM_PHASE.RUNNING }),
    ]);

    const roster = backend.state.getStreamState(PARENT)?.subagents ?? [];
    expect(roster).toEqual([
      expect.objectContaining({
        executionId: 'requeued',
        status: STREAM_PHASE.RUNNING,
      }),
    ]);
    expect(roster[0]?.finishedAt).toBeUndefined();
  });

  it('keeps a resolved live row when an older roster stamp arrives after it', async () => {
    // The reverse of the roster-drop ordering: the child is still tracked when
    // its terminal phase lands, and a roster stamped before that transition is
    // applied afterwards. With the send-time projection gone, an older stamp
    // that reached the row would freeze this badge at `running` forever.
    const { backend, session } = createIsolatedRecordingBackend();
    backend.setupEventListeners();
    seedParent(backend);
    const executionId = 'c0ffee01' as ExecutionId;
    const childStreamId = 'restamped-stream' as StreamTabId;
    const handle = testExecutionHandle({
      executionId,
      parentStreamId: PARENT,
      childStreamId,
      agent: 'agent-restamped',
      category: AgentCategory.ToolUse,
    });
    session.executions.trackAgentExecution(handle, {
      status: STREAM_PHASE.RUNNING,
    });
    const rosterStampedWhileRunning =
      session.executions.getActiveChildren(PARENT);
    backend.factApplier.updateChildRoster(PARENT, rosterStampedWhileRunning);
    expect(backend.state.getStreamState(PARENT)?.subagents?.[0]?.status).toBe(
      STREAM_PHASE.RUNNING,
    );

    session.status.transitionToTerminal(
      childStreamId,
      STREAM_PHASE.FAILED,
      STREAM_TRANSITION_CAUSE.LIFECYCLE,
    );
    expect(backend.state.getStreamState(PARENT)?.subagents?.[0]?.status).toBe(
      STREAM_PHASE.FAILED,
    );

    backend.factApplier.updateChildRoster(PARENT, rosterStampedWhileRunning);
    expect(backend.state.getStreamState(PARENT)?.subagents).toEqual([
      expect.objectContaining({
        executionId,
        status: STREAM_PHASE.FAILED,
      }),
    ]);

    // A roster the emitter stamps now carries the resolved phase too, so the
    // row is written from the same owner on both paths.
    backend.factApplier.updateChildRoster(
      PARENT,
      session.executions.getActiveChildren(PARENT),
    );
    expect(backend.state.getStreamState(PARENT)?.subagents).toEqual([
      expect.objectContaining({
        executionId,
        status: STREAM_PHASE.FAILED,
      }),
    ]);
    session.executions.untrack(executionId);
  });

  it('writes the terminal status of a child detached from its parent', async () => {
    const { backend } = createRecordingBackend();
    seedParent(backend);
    const childStreamId = 'detached-stream' as StreamTabId;

    backend.factApplier.updateChildRoster(PARENT, [
      subagent('detached', { childStreamId }),
    ]);
    // Detaching promotes a running subagent to top-level: the parent link goes
    // away and the roster drops the row, but the child keeps running and
    // finishes later. The row is found by its own childStreamId, so the phase
    // still lands.
    backend.factApplier.handleSetParentStream({
      childStreamId,
      parentStreamId: null,
    });
    backend.factApplier.updateChildRoster(PARENT, []);

    await backend.factApplier.setStreamStatus(
      childStreamId,
      STREAM_PHASE.COMPLETED,
    );

    expect(backend.state.getStreamState(PARENT)?.subagents).toEqual([
      expect.objectContaining({
        executionId: 'detached',
        status: STREAM_PHASE.COMPLETED,
      }),
    ]);
  });

  it('caps retained rows, evicting the oldest and keeping every live one', () => {
    const { backend } = createRecordingBackend();
    // Mirrors RETAINED_FINISHED_CHILDREN_CAP in ProgressFactApplier.
    const cap = 200;
    const overflow = 5;
    seedParent(backend);
    const live = subagent('live');

    for (let i = 0; i < cap + overflow; i += 1) {
      vi.spyOn(Date, 'now').mockReturnValue(1_000 + i);
      backend.factApplier.updateChildRoster(PARENT, [
        live,
        subagent(`child-${i}`),
      ]);
      backend.factApplier.updateChildRoster(PARENT, [live]);
    }
    vi.restoreAllMocks();

    const roster = backend.state.getStreamState(PARENT)?.subagents ?? [];
    const retained = roster.filter((c) => c.finishedAt !== undefined);
    expect(roster.filter((c) => c.finishedAt === undefined)).toEqual([live]);
    expect(retained).toHaveLength(cap);
    // The five oldest are evicted; the newest survives.
    const ids = retained.map((c) => c.executionId);
    expect(ids).not.toContain('child-0');
    expect(ids).not.toContain(`child-${overflow - 1}`);
    expect(retained[0]?.executionId).toBe(`child-${overflow}`);
    expect(retained.at(-1)?.executionId).toBe(`child-${cap + overflow - 1}`);
  });

  it('clears retained rows when the stream re-enters running', async () => {
    const { backend } = createRecordingBackend();
    seedParent(backend);
    const live = subagent('live');

    backend.factApplier.updateChildRoster(PARENT, [live, subagent('done')]);
    backend.factApplier.updateChildRoster(PARENT, [live]);
    expect(backend.state.getStreamState(PARENT)?.subagents).toHaveLength(2);

    await backend.factApplier.setStreamStatus(
      PARENT,
      STREAM_PHASE.RUNNING,
      STREAM_PHASE.COMPLETED,
    );

    expect(backend.state.getStreamState(PARENT)?.subagents).toEqual([live]);
  });
});
