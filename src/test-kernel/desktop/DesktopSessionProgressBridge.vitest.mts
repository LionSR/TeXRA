import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionFact } from '@agent/runtime/SessionEventHub';
import {
  createDesktopSessionProgressBridge,
  type DesktopSessionProgressBridgeOptions,
} from '@desktop/main/desktopSessionProgressBridge';
import { PROGRESS_VIEW_COMMANDS } from '@shared/ipc';
import { STREAM_PHASE } from '@shared/schemas';
import { GoalStore } from '@tools/goal';

vi.mock('@tools/goal', () => ({
  GoalStore: {
    getForStream: vi.fn(),
  },
}));

function createHarness() {
  const state = { activeStream: 'current-stream' };
  const sendMessage = vi.fn();
  const routeToProgress = vi.fn();
  const onGoalStateChanged = vi.fn();
  const onShowError = vi.fn();
  const options = {
    state,
    sendMessage,
    routeToProgress,
    onGoalStateChanged,
    onShowError,
  } satisfies DesktopSessionProgressBridgeOptions;

  return {
    bridge: createDesktopSessionProgressBridge(options),
    state,
    sendMessage,
    routeToProgress,
    onGoalStateChanged,
    onShowError,
  };
}

describe('DesktopSessionProgressBridge', () => {
  beforeEach(() => {
    vi.mocked(GoalStore.getForStream).mockReset();
    vi.mocked(GoalStore.getForStream).mockReturnValue(null);
  });

  describe('presentation events', () => {
    it('routes ensure-progress requests to the progress view', () => {
      const { bridge, routeToProgress } = createHarness();

      bridge.handlePresentationEvent('requestEnsureProgressView', {});

      expect(routeToProgress).toHaveBeenCalledOnce();
    });

    it('shows error requests through the desktop dialog', () => {
      const { bridge, onShowError } = createHarness();

      bridge.handlePresentationEvent('requestShowError', {
        message: 'Root run failed',
      });

      expect(onShowError).toHaveBeenCalledExactlyOnceWith('Root run failed');
    });

    it('shows instruction requests through the same desktop dialog', () => {
      const { bridge, onShowError } = createHarness();

      bridge.handlePresentationEvent('requestShowInstruction', {
        key: 'missingApiKey',
        message: 'Set an API key before running this agent.',
        actions: ['set-api-key'],
        showSuppress: false,
      });

      expect(onShowError).toHaveBeenCalledExactlyOnceWith(
        'Set an API key before running this agent.',
      );
    });
  });

  describe('setActiveStream facts', () => {
    it('clears the desktop-owned active stream for an empty selection', () => {
      const { bridge, state, sendMessage, routeToProgress } = createHarness();

      bridge.handleSessionFact({
        type: 'setActiveStream',
        payload: { streamId: null },
      });

      expect(state.activeStream).toBe('');
      expect(sendMessage).toHaveBeenCalledExactlyOnceWith({
        command: PROGRESS_VIEW_COMMANDS.SET_ACTIVE_STREAM,
        activeStream: '',
      });
      expect(routeToProgress).not.toHaveBeenCalled();
    });

    it('routes a normal stream selection to the progress view', () => {
      const { bridge, state, sendMessage, routeToProgress } = createHarness();

      bridge.handleSessionFact({
        type: 'setActiveStream',
        payload: { streamId: 'next-stream' },
      });

      expect(routeToProgress).toHaveBeenCalledOnce();
      expect(state.activeStream).toBe('current-stream');
      expect(sendMessage).not.toHaveBeenCalled();
    });

    it('does not route a suppressed stream selection', () => {
      const { bridge, state, sendMessage, routeToProgress } = createHarness();

      bridge.handleSessionFact({
        type: 'setActiveStream',
        payload: {
          streamId: 'background-stream',
          suppressViewSwitch: true,
        },
      });

      expect(routeToProgress).not.toHaveBeenCalled();
      expect(state.activeStream).toBe('current-stream');
      expect(sendMessage).not.toHaveBeenCalled();
    });
  });

  it('projects the current goal record through the progress updater', () => {
    vi.mocked(GoalStore.getForStream)
      .mockReturnValueOnce({
        goalId: 'goal-1',
        streamId: 'goal-stream',
        objective: 'Complete the proof',
        status: 'paused',
        createdAt: '2026-07-16T08:00:00.000Z',
        updatedAt: '2026-07-16T09:00:00.000Z',
      })
      .mockReturnValueOnce(null);
    const { bridge, onGoalStateChanged } = createHarness();

    bridge.handleSessionFact({
      type: 'goalStateChanged',
      payload: { streamId: 'goal-stream' },
    });
    bridge.handleSessionFact({
      type: 'goalStateChanged',
      payload: { streamId: 'finished-stream' },
    });

    expect(GoalStore.getForStream).toHaveBeenNthCalledWith(1, 'goal-stream');
    expect(onGoalStateChanged).toHaveBeenNthCalledWith(1, 'goal-stream', true, {
      status: 'paused',
      objective: 'Complete the proof',
    });
    expect(onGoalStateChanged).toHaveBeenNthCalledWith(
      2,
      'finished-stream',
      false,
      {
        status: undefined,
        objective: undefined,
      },
    );
  });

  it('ignores shared facts that have no desktop-only projection', () => {
    const ignoredFacts: SessionFact[] = [
      {
        type: 'updateStreamStatus',
        payload: { streamId: 'stream-1', status: STREAM_PHASE.RUNNING },
      },
      {
        type: 'updateStreamDescription',
        payload: { streamId: 'stream-1', description: 'Updated description' },
      },
      {
        type: 'setParentStream',
        payload: { childStreamId: 'stream-1', parentStreamId: 'parent-stream' },
      },
      {
        type: 'inquiryThreadUpdated',
        payload: {
          threadId: 'ei_0123456789ab',
          parentStreamId: 'stream-1',
          status: 'open',
          lastQuestionPreview: 'Which hypothesis is needed?',
          lastActivityIso: '2026-07-16T09:00:00.000Z',
          turnCount: 1,
        },
      },
      { type: 'clearMissingOutputs', payload: { streamId: 'stream-1' } },
      { type: 'updateQueuedFollowUps', payload: { streamId: 'stream-1' } },
      { type: 'followUpSent', payload: { streamId: 'stream-1' } },
      { type: 'removeStream', payload: { streamId: 'stream-1' } },
    ];
    const {
      bridge,
      state,
      sendMessage,
      routeToProgress,
      onGoalStateChanged,
      onShowError,
    } = createHarness();

    for (const fact of ignoredFacts) {
      bridge.handleSessionFact(fact);
    }

    expect(state.activeStream).toBe('current-stream');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(routeToProgress).not.toHaveBeenCalled();
    expect(onGoalStateChanged).not.toHaveBeenCalled();
    expect(onShowError).not.toHaveBeenCalled();
    expect(GoalStore.getForStream).not.toHaveBeenCalled();
  });

  it('ignores presentation and session events after disposal', () => {
    const {
      bridge,
      state,
      sendMessage,
      routeToProgress,
      onGoalStateChanged,
      onShowError,
    } = createHarness();
    bridge.dispose();

    bridge.handlePresentationEvent('requestEnsureProgressView', {});
    bridge.handlePresentationEvent('requestShowError', {
      message: 'Late failure',
    });
    bridge.handlePresentationEvent('requestShowInstruction', {
      key: 'late-instruction',
      message: 'Late instruction',
    });
    bridge.handleSessionFact({
      type: 'setActiveStream',
      payload: { streamId: null },
    });
    bridge.handleSessionFact({
      type: 'goalStateChanged',
      payload: { streamId: 'goal-stream' },
    });

    expect(state.activeStream).toBe('current-stream');
    expect(sendMessage).not.toHaveBeenCalled();
    expect(routeToProgress).not.toHaveBeenCalled();
    expect(onGoalStateChanged).not.toHaveBeenCalled();
    expect(onShowError).not.toHaveBeenCalled();
    expect(GoalStore.getForStream).not.toHaveBeenCalled();
  });
});
