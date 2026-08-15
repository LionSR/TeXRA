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
  type ProgressViewOutboundMessage,
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
} from './progressBackendHarness';

describe('retained finished children', () => {
  const PARENT = 'parent-stream' as StreamTabId;

  function applyRoster(
    backend: ProgressBackend,
    parent: StreamTabId,
    items: ActiveChildInfo[],
  ): void {
    backend.applyRunFact(parent, {
      type: 'child.activity',
      parentStreamId: parent,
      items,
    });
  }

  function subagent(
    id: string,
    overrides: Partial<ActiveChildInfo> = {},
  ): ActiveChildInfo {
    return {
      executionId: id,
      childStreamId: `${id}-stream` as StreamTabId,
      identity: { kind: 'agent', agent: `agent-${id}` },
      agentName: `agent-${id}`,
      status: STREAM_PHASE.RUNNING,
      ...overrides,
    };
  }

  function seedParent(backend: ProgressBackend): void {
    backend.state.streamLogs.ensureStream(PARENT);
    backend.state.getOrCreateStreamState(PARENT, AgentCategory.Workflow);
    backend.presentation.select(PARENT);
  }

  function parentRoster(backend: ProgressBackend): ActiveChildInfo[] {
    return backend.state.getStreamState(PARENT)?.subagents ?? [];
  }

  function badgePushes(
    messages: ProgressViewOutboundMessage[],
  ): ProgressViewOutboundMessage[] {
    return messages.filter(
      (message) =>
        message.command === PROGRESS_VIEW_COMMANDS.UPDATE_STREAM_BADGES,
    );
  }

  it('keeps a vanished child as a row stamped with finishedAt', () => {
    const { backend } = createRecordingBackend();
    seedParent(backend);

    applyRoster(backend, PARENT, [subagent('a'), subagent('b')]);
    applyRoster(backend, PARENT, [subagent('a')]);

    const roster = parentRoster(backend);
    expect(roster).toHaveLength(2);
    expect(roster.find((c) => c.executionId === 'a')?.finishedAt).toBe(
      undefined,
    );
    expect(
      roster.find((c) => c.executionId === 'b')?.finishedAt,
    ).toBeGreaterThan(0);
  });

  it('pushes a roster drop for a parent that is not the active stream', () => {
    // The Background Tasks roster is parent-viewport data about children, so
    // it cannot ride the active-stream gate: a child that finishes while the
    // user is looking at another tab (clicking its own row is enough to move
    // the active stream) must still retire its row.
    const { backend, messages } = createRecordingBackend();
    seedParent(backend);
    applyRoster(backend, PARENT, [subagent('bg')]);

    const other = 'other-stream' as StreamTabId;
    backend.state.streamLogs.ensureStream(other);
    backend.state.getOrCreateStreamState(other, AgentCategory.ToolUse);
    backend.presentation.select(other);
    messages.length = 0;

    applyRoster(backend, PARENT, []);

    const badgeMessages = badgePushes(messages);
    expect(badgeMessages).toHaveLength(1);
    expect(badgeMessages[0]).toMatchObject({ stream: PARENT });
  });

  it('promotes a retained child back to one live row when it reappears', () => {
    const { backend } = createRecordingBackend();
    seedParent(backend);
    const child = subagent('resumed');

    const expectSingleRow = (finished: boolean): ActiveChildInfo[] => {
      const roster = parentRoster(backend);
      expect(roster).toHaveLength(1);
      if (finished) {
        expect(roster[0]?.finishedAt).toBeGreaterThan(0);
      } else {
        expect(roster[0]?.finishedAt).toBeUndefined();
      }
      return roster;
    };

    applyRoster(backend, PARENT, [child]);
    expectSingleRow(false);

    applyRoster(backend, PARENT, []);
    expectSingleRow(true);

    applyRoster(backend, PARENT, [child]);
    expectSingleRow(false);

    applyRoster(backend, PARENT, []);
    const roster = expectSingleRow(true);
    expect(new Set(roster.map((entry) => entry.executionId)).size).toBe(1);
  });

  it('never marks anything finished from a first roster', () => {
    const { backend } = createRecordingBackend();
    seedParent(backend);

    applyRoster(backend, PARENT, [subagent('a')]);

    const roster = parentRoster(backend);
    expect(roster.map((c) => c.executionId)).toEqual(['a']);
    expect(roster[0]?.finishedAt).toBeUndefined();
  });

  it('keeps a roster-first child when the parent category is later corrected', () => {
    const { backend } = createRecordingBackend();
    backend.state.streamLogs.ensureStream(PARENT);

    // Roster arrives before RUNNING/config; applier provisions a ToolUse bucket.
    applyRoster(backend, PARENT, [subagent('early')]);
    expect(backend.state.getStreamState(PARENT)?.category).toBe(
      AgentCategory.ToolUse,
    );
    expect(
      backend.state.getStreamState(PARENT)?.subagents.map((c) => c.executionId),
    ).toEqual(['early']);

    // Real category arrives via getOrCreateStreamState — must not wipe roster.
    backend.state.getOrCreateStreamState(PARENT, AgentCategory.Workflow);
    const state = backend.state.getStreamState(PARENT);
    expect(state?.category).toBe(AgentCategory.Workflow);
    expect(state?.subagents.map((c) => c.executionId)).toEqual(['early']);
    expect(state?.subagents[0]?.finishedAt).toBeUndefined();
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
    applyRoster(backend, PARENT, [child]);
    applyRoster(backend, PARENT, []);
    messages.length = 0;

    // Terminal status arrives afterwards.
    backend.state.streamStatus.transitionToTerminal(
      childStreamId,
      STREAM_PHASE.COMPLETED,
      STREAM_TRANSITION_CAUSE.LIFECYCLE,
    );
    await backend.applyStreamStatus(childStreamId, STREAM_PHASE.COMPLETED);

    const badges = badgePushes(messages);
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
    applyRoster(backend, PARENT, [subagent('doomed', { childStreamId })]);
    applyRoster(backend, PARENT, []);
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
    backend.renderer.sendStreamMetadata(
      backend.projections.streamRoster(
        backend.presentation.activeStream,
        backend.state.streamStatus.getAllStreamStates(),
      ),
      backend.presentation.activeStream,
    );
    backend.renderer.updateStreamMetadata(
      PARENT,
      backend.state.streamStatus.getAllStreamStates(),
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

    applyRoster(backend, PARENT, [live]);
    await backend.applyStreamStatus(childStreamId, STREAM_PHASE.FAILED);
    messages.length = 0;

    // A roster snapshot stamped before the transition, delivered after it: the
    // child is still tracked, so it arrives as a live row carrying `running`.
    applyRoster(backend, PARENT, [live]);

    const roster = parentRoster(backend);
    expect(roster).toEqual([
      expect.objectContaining({
        executionId: 'stale',
        status: STREAM_PHASE.FAILED,
      }),
    ]);
    expect(roster[0]?.finishedAt).toBeUndefined();
    // No further status fact arrives for a terminal child, so the badge push
    // driven by the stale roster is the last word on the wire.
    expect(badgePushes(messages).at(-1)).toMatchObject({
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

    applyRoster(backend, PARENT, [
      subagent('requeued', { childStreamId, status: STREAM_PHASE.WAITING }),
    ]);
    applyRoster(backend, PARENT, []);
    applyRoster(backend, PARENT, [
      subagent('requeued', { childStreamId, status: STREAM_PHASE.RUNNING }),
    ]);

    const roster = parentRoster(backend);
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
    applyRoster(backend, PARENT, rosterStampedWhileRunning);
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

    applyRoster(backend, PARENT, rosterStampedWhileRunning);
    expect(backend.state.getStreamState(PARENT)?.subagents).toEqual([
      expect.objectContaining({
        executionId,
        status: STREAM_PHASE.FAILED,
      }),
    ]);

    // A roster the emitter stamps now carries the resolved phase too, so the
    // row is written from the same owner on both paths.
    applyRoster(backend, PARENT, session.executions.getActiveChildren(PARENT));
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

    applyRoster(backend, PARENT, [subagent('detached', { childStreamId })]);
    // Detaching promotes a running subagent to top-level: the parent link goes
    // away and the roster drops the row, but the child keeps running and
    // finishes later. The row is found by its own childStreamId, so the phase
    // still lands.
    backend.applySessionFact({
      type: 'setParentStream',
      payload: { childStreamId, parentStreamId: null },
    });
    applyRoster(backend, PARENT, []);

    await backend.applyStreamStatus(childStreamId, STREAM_PHASE.COMPLETED);

    expect(backend.state.getStreamState(PARENT)?.subagents).toEqual([
      expect.objectContaining({
        executionId: 'detached',
        status: STREAM_PHASE.COMPLETED,
      }),
    ]);
  });

  it('caps retained rows, evicting the oldest and keeping every live one', () => {
    const { backend } = createRecordingBackend();
    // Mirrors RETAINED_FINISHED_CHILDREN_CAP in SessionFactApplier.
    const cap = 200;
    const overflow = 5;
    seedParent(backend);
    const live = subagent('live');

    for (let i = 0; i < cap + overflow; i += 1) {
      vi.spyOn(Date, 'now').mockReturnValue(1_000 + i);
      applyRoster(backend, PARENT, [live, subagent(`child-${i}`)]);
      applyRoster(backend, PARENT, [live]);
    }
    vi.restoreAllMocks();

    const roster = parentRoster(backend);
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

    applyRoster(backend, PARENT, [live, subagent('done')]);
    applyRoster(backend, PARENT, [live]);
    expect(backend.state.getStreamState(PARENT)?.subagents).toHaveLength(2);

    await backend.applyStreamStatus(
      PARENT,
      STREAM_PHASE.RUNNING,
      STREAM_PHASE.COMPLETED,
    );

    expect(backend.state.getStreamState(PARENT)?.subagents).toEqual([live]);
  });

  it('does not retain vanished process children — they are ephemeral', () => {
    const { backend } = createRecordingBackend();
    seedParent(backend);
    const agent = subagent('reviewer', {
      identity: { kind: 'agent', agent: 'reviewer' },
    });
    const bash = subagent('bash', {
      agentName: 'bash',
      identity: { kind: 'process', tool: 'bash' },
    });

    applyRoster(backend, PARENT, [agent, bash]);
    applyRoster(backend, PARENT, []);

    const roster = parentRoster(backend);
    expect(roster).toHaveLength(1);
    expect(roster[0]?.executionId).toBe('reviewer');
    expect(roster[0]?.finishedAt).toBeGreaterThan(0);
  });
});
