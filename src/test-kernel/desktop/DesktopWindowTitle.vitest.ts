import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  getDesktopSessionActivity,
  getDesktopWindowTitle,
  installDesktopWindowTitle,
} from '@desktop/main/desktopWindowTitle';
import { STREAM_PHASE, type StreamTabId } from '@shared/schemas';
import { formatSessionTitle } from '@shared/sessionTitle';
import { seedStreamStatusForTest } from '@test/support/streamStatusTestUtils';
import { testExecutionHandle } from '@test/support/executionHandleFixtures';
import { createTestSession } from '@test/support/sessionTestUtils';

function createAgentHandle(id: string, streamId: StreamTabId) {
  return testExecutionHandle({
    executionId: id,
    parentStreamId: streamId,
    agent: 'test-agent',
  });
}

function trackRunningAgent(
  session: ReturnType<typeof createTestSession>,
  id: string,
  streamId: StreamTabId,
): ReturnType<typeof createAgentHandle> {
  const handle = createAgentHandle(id, streamId);
  session.executions.trackAgentExecution(handle, {
    status: STREAM_PHASE.RUNNING,
  });
  return handle;
}

function createWindow(initialTitle: string) {
  const webContents = new EventEmitter();
  let title = initialTitle;
  let destroyed = false;
  const setTitle = vi.fn((nextTitle: string) => {
    title = nextTitle;
  });
  return {
    window: {
      getTitle: () => title,
      isDestroyed: () => destroyed,
      setTitle,
      webContents: Object.assign(webContents, { isDestroyed: () => false }),
    },
    setTitle,
    webContents,
    destroy: () => {
      destroyed = true;
    },
  };
}

function installTitle(
  window: ReturnType<typeof createWindow>['window'],
  session: SessionHandle,
  workspacePath = '/work/geometry',
): () => void {
  return installDesktopWindowTitle(
    window as unknown as Parameters<typeof installDesktopWindowTitle>[0],
    session,
    workspacePath,
  );
}

describe('desktop process-session window title', () => {
  it('formats exact copy for absent and hostile workspace names', () => {
    expect(formatSessionTitle(undefined, 'idle')).toBe('TeXRA');
    expect(formatSessionTitle(undefined, 'running')).toBe('TeXRA — Running');
    expect(formatSessionTitle(undefined, 'approval')).toBe(
      'TeXRA — Approval needed',
    );
    expect(formatSessionTitle('draft — Running <script>.tex', 'approval')).toBe(
      'TeXRA — Approval needed — draft — Running <script>.tex',
    );
  });

  it('requires a registered agent with canonical RUNNING status', () => {
    const session = createTestSession();
    const orphanStream = 'stream:provisional-orphan' as StreamTabId;
    const waitingStream = 'stream:waiting' as StreamTabId;
    try {
      seedStreamStatusForTest(session.status, orphanStream, {
        phase: STREAM_PHASE.RUNNING,
      });
      expect(getDesktopSessionActivity(session)).toBe('idle');

      const waitingHandle = trackRunningAgent(
        session,
        'execution:waiting',
        waitingStream,
      );
      session.executions.updateAgentExecutionStatus(
        waitingHandle,
        STREAM_PHASE.WAITING,
      );
      expect(getDesktopSessionActivity(session)).toBe('idle');
    } finally {
      session.dispose();
    }
  });

  it('remains running until the last of two live agents completes', () => {
    const session = createTestSession();
    try {
      const first = trackRunningAgent(
        session,
        'execution:first',
        'stream:first' as StreamTabId,
      );
      const second = trackRunningAgent(
        session,
        'execution:second',
        'stream:second' as StreamTabId,
      );
      expect(getDesktopSessionActivity(session)).toBe('running');

      session.executions.untrack(first.executionId);
      expect(getDesktopSessionActivity(session)).toBe('running');

      session.executions.untrack(second.executionId);
      expect(getDesktopSessionActivity(session)).toBe('idle');
    } finally {
      session.dispose();
    }
  });

  it('gives approval precedence and returns to running or idle', async () => {
    const session = createTestSession();
    const streamId = 'stream:approval' as StreamTabId;
    const handle = trackRunningAgent(session, 'execution:approval', streamId);
    try {
      const firstApproval = session.interactions.requestPlanApproval({
        requestId: 'approval:running',
        streamId,
        plan: { objective: 'Check the title.' },
        goalEnabled: false,
      });
      expect(getDesktopSessionActivity(session)).toBe('approval');

      session.interactions.cancel({ cause: 'Decision recorded.' });
      await firstApproval;
      expect(getDesktopSessionActivity(session)).toBe('running');

      session.executions.untrack(handle.executionId);
      const secondApproval = session.interactions.requestPlanApproval({
        requestId: 'approval:idle',
        streamId,
        plan: { objective: 'Check the idle title.' },
        goalEnabled: false,
      });
      expect(getDesktopSessionActivity(session)).toBe('approval');

      session.interactions.cancel({ cause: 'Decision recorded.' });
      await secondApproval;
      expect(getDesktopSessionActivity(session)).toBe('idle');
    } finally {
      session.dispose();
    }
  });

  it('prevents renderer replacement, deduplicates writes, and disposes', () => {
    const session = createTestSession();
    const view = createWindow('TeXRA — geometry');
    const dispose = installTitle(view.window, session);
    try {
      expect(view.setTitle).not.toHaveBeenCalled();

      const event = { preventDefault: vi.fn() };
      view.webContents.emit('page-title-updated', event, 'Renderer title');
      expect(event.preventDefault).toHaveBeenCalledOnce();

      seedStreamStatusForTest(
        session.status,
        'stream:orphan-update' as StreamTabId,
        { phase: STREAM_PHASE.RUNNING },
      );
      expect(view.setTitle).not.toHaveBeenCalled();

      dispose();
      expect(view.webContents.listenerCount('page-title-updated')).toBe(0);
      trackRunningAgent(
        session,
        'execution:after-close',
        'stream:after-close' as StreamTabId,
      );
      expect(view.setTitle).not.toHaveBeenCalled();
    } finally {
      dispose();
      session.dispose();
    }
  });

  it('does not write the native title after window destruction', () => {
    const session = createTestSession();
    const view = createWindow('TeXRA — geometry');
    const dispose = installTitle(view.window, session);
    try {
      view.destroy();
      trackRunningAgent(
        session,
        'execution:destroyed-window',
        'stream:destroyed-window' as StreamTabId,
      );
      expect(view.setTitle).not.toHaveBeenCalled();
    } finally {
      dispose();
      session.dispose();
    }
  });

  it('derives a pending approval on reopen and isolates process sessions', () => {
    const firstSession = createTestSession();
    const secondSession = createTestSession();
    const streamId = 'stream:reopen' as StreamTabId;
    try {
      void firstSession.interactions.requestPlanApproval({
        requestId: 'approval:reopen',
        streamId,
        plan: { objective: 'Preserve this request across window detach.' },
        goalEnabled: false,
      });

      expect(getDesktopWindowTitle(firstSession, '/work/geometry')).toBe(
        'TeXRA — Approval needed — geometry',
      );
      expect(getDesktopWindowTitle(secondSession, '/work/algebra')).toBe(
        'TeXRA — algebra',
      );

      const reopened = createWindow(
        getDesktopWindowTitle(firstSession, '/work/geometry'),
      );
      const dispose = installTitle(
        reopened.window,
        firstSession,
        '/work/geometry',
      );
      expect(reopened.setTitle).not.toHaveBeenCalled();
      dispose();
    } finally {
      firstSession.dispose();
      secondSession.dispose();
    }
  });
});
