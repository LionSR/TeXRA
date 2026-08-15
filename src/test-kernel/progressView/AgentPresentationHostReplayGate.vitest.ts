// Test support imports
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { ApprovalRequestHandler } from '@controllers/progressView/backend/ApprovalRequestHandler';
import type { ProgressHostInteractionsOptions } from '@controllers/progressView/backend/progressHostInteractions';
import { createAgentPresentationHost } from '@frontend/events/agentEventListeners';
import * as logger from '@logger/logUtils';
import { createExtensionHostInteractions } from '@progressView/extensionHostInteractions';
import type { ProgressViewProvider } from '@progressView/ProgressViewProvider';
import type { ToolEditPermission } from '@shared/schemas';
import { INSTRUCTION_PREFIX } from '@shared/state/stateKeys';
import { createTestSession } from '@test/support/sessionTestUtils';

// Local file imports
import { createRecordingApprovalHandlers } from './approvalHandlerSetHarness';

/**
 * The extension's `HostInteractions.emit` is a thin pass-through to a
 * caller-supplied presentation host, so redelivery is owned elsewhere. These
 * tests pin the two guarantees that ownership has to keep:
 *
 *  1. A pending tool-edit approval redisplays exactly once per webview
 *     reload, and never redisplays once resolved, from
 *     `ApprovalRequestHandler`'s pending/delivered bookkeeping.
 *  2. A presentation event emitted before any host attaches (the launch
 *     path, before `ProgressViewProvider` is constructed) is not lost: the
 *     runtime's `replayWhenAttached` queue replays it exactly once when the
 *     presentation host attaches.
 */

const mocks = vi.hoisted(() => ({
  getLinterMessages: vi.fn(async () => []),
  pushManualCriticism: vi.fn(() => true),
  openBuildDisplayIfTex: vi.fn(async () => true),
  instructionMemento: new Map<string, unknown>(),
}));

vi.mock('@frontend/latex/linter', () => ({
  getLinterMessages: mocks.getLinterMessages,
}));

vi.mock('@frontend/latex/inlineCriticism', () => ({
  pushManualCriticism: mocks.pushManualCriticism,
}));

vi.mock('@frontend/latex/openBuild', () => ({
  openBuildDisplayIfTex: mocks.openBuildDisplayIfTex,
}));

// An in-memory global state memento, so the "never remind again" suppression
// path can be driven without a VS Code extension context.
vi.mock('@common/state', async (importActual) => ({
  ...(await importActual<typeof import('@common/state')>()),
  globalSM: {
    get: (key: string) => mocks.instructionMemento.get(key),
    update: async (key: string, value: unknown) => {
      mocks.instructionMemento.set(key, value);
    },
  },
}));

function toolEditPermission(requestId: string): ToolEditPermission {
  return {
    requestId,
    allowBypass: true,
    streamId: 'stream-a',
    path: '/workspace/paper.tex',
    relativePath: 'paper.tex',
    sourceTool: 'edit_file',
    addedLines: 1,
    removedLines: 0,
    isLatex: true,
  };
}

const testSessions: SessionHandle[] = [];

afterEach(() => {
  for (const session of testSessions.splice(0)) session.dispose();
});

describe('extension presentation-event emit port (#9251 replay gate)', () => {
  it('redisplays a pending tool-edit approval exactly once per webview reload', () => {
    let canSend = false;
    const sendShow = vi.fn();
    const sendDismiss = vi.fn();
    const toolEdit = new ApprovalRequestHandler<
      ToolEditPermission,
      'requestId'
    >('requestId', sendShow, sendDismiss, () => canSend);
    // The webview is not ready, so the host-local approval handler records the
    // prompt without delivering it.
    toolEdit.show(toolEditPermission('req-a'));
    expect(sendShow).not.toHaveBeenCalled();

    // Each webview reload clears delivery tracking and redisplays the one
    // pending prompt exactly once.
    canSend = true;
    toolEdit.replay();
    expect(sendShow).toHaveBeenCalledTimes(1);
    toolEdit.replay();
    expect(sendShow).toHaveBeenCalledTimes(2);

    toolEdit.dismiss('req-a');

    // A further reload must not resurrect an already-resolved approval.
    toolEdit.replay();
    expect(sendShow).toHaveBeenCalledTimes(2);
    expect(sendDismiss).toHaveBeenCalledWith('req-a');
  });

  it('replays a launch-path presentation event exactly once once the presentation host attaches', async () => {
    const session = createTestSession();
    testSessions.push(session);
    const showErrorMessage = vi
      .spyOn(vscode.window, 'showErrorMessage')
      .mockResolvedValue(undefined);

    try {
      // Emitted before any host has attached, mirroring a launch failure
      // (`AgentLaunchContext.ts`) firing before `ProgressViewProvider` is
      // constructed. Only the runtime's `replayWhenAttached` queue can save
      // this event.
      session.interactions.emit(
        'requestShowError',
        { message: 'Launch failed before the view attached.' },
        { replayWhenAttached: true },
      );
      expect(showErrorMessage).not.toHaveBeenCalled();

      const presentationHost = createAgentPresentationHost(
        {} as unknown as ProgressViewProvider,
      );
      const interactions = createExtensionHostInteractions({
        interactions: presentationHost,
        session,
        getApprovalHandlers: () => createRecordingApprovalHandlers(),
        getToolEditApprovals: () =>
          ({
            approvePendingForStream: vi.fn(async () => undefined),
            cancel: vi.fn(),
            requestApproval: vi.fn(),
          }) as unknown as ReturnType<
            ProgressHostInteractionsOptions['getToolEditApprovals']
          >,
        setApprovalBypassState: vi.fn(),
      });
      const detach = session.useHostInteractions(interactions);
      try {
        // The replay runs on a microtask queued by `use()`.
        await Promise.resolve();
        expect(showErrorMessage).toHaveBeenCalledTimes(1);
        expect(showErrorMessage).toHaveBeenCalledWith(
          'Launch failed before the view attached.',
        );
      } finally {
        detach();
      }
    } finally {
      showErrorMessage.mockRestore();
    }
  });
});
describe('extension presentation delivery truthfulness (#10400)', () => {
  function presentationHost(
    provider?: Partial<ProgressViewProvider>,
  ): ReturnType<typeof createAgentPresentationHost> {
    return createAgentPresentationHost(
      (provider ?? {}) as unknown as ProgressViewProvider,
    );
  }

  it('reports the error toast as delivered once VS Code accepts the handoff', async () => {
    const showErrorMessage = vi
      .spyOn(vscode.window, 'showErrorMessage')
      .mockResolvedValue(undefined);
    try {
      const host = presentationHost();
      expect(await host.emit('requestShowError', { message: 'Boom' })).toBe(
        true,
      );
      expect(showErrorMessage).toHaveBeenCalledWith('Boom');
    } finally {
      showErrorMessage.mockRestore();
    }
  });

  it('reports the error toast as not delivered when the handoff throws', async () => {
    const showErrorMessage = vi
      .spyOn(vscode.window, 'showErrorMessage')
      .mockImplementation(() => {
        throw new Error('host gone');
      });
    try {
      const host = presentationHost();
      expect(await host.emit('requestShowError', { message: 'Boom' })).toBe(
        false,
      );
    } finally {
      showErrorMessage.mockRestore();
    }
  });

  it('observes an error-toast handoff rejection without reporting non-delivery', async () => {
    // `showErrorMessage` resolves on dismissal, which callers must not wait
    // on, so the handoff remains the delivery signal. The returned Thenable
    // is still observed: a post-handoff rejection is warn-logged instead of
    // surfacing as an unhandled rejection (#10467).
    const showErrorMessage = vi
      .spyOn(vscode.window, 'showErrorMessage')
      .mockRejectedValueOnce(new Error('host gone'));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const host = presentationHost();
      expect(await host.emit('requestShowError', { message: 'Boom' })).toBe(
        true,
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(showErrorMessage).toHaveBeenCalledWith('Boom');
      expect(warn).toHaveBeenCalledWith(
        'agentEventListeners',
        expect.stringContaining('toast'),
      );
    } finally {
      showErrorMessage.mockRestore();
      warn.mockRestore();
    }
  });

  it('reports file-open delivery from the open outcome', async () => {
    const host = presentationHost();
    const payload = {
      location: {
        kind: 'workspace' as const,
        absolutePath: '/workspace/paper.pdf',
        relativePath: 'paper.pdf',
      },
      preserveFocus: true,
    };

    mocks.openBuildDisplayIfTex.mockResolvedValueOnce(true);
    await expect(host.emit('requestOpenFile', payload)).resolves.toBe(true);

    mocks.openBuildDisplayIfTex.mockResolvedValueOnce(false);
    await expect(host.emit('requestOpenFile', payload)).resolves.toBe(false);

    mocks.openBuildDisplayIfTex.mockRejectedValueOnce(new Error('no viewer'));
    await expect(host.emit('requestOpenFile', payload)).resolves.toBe(false);
  });

  it('reports progress-view reveal delivery from the reveal outcome', async () => {
    const visibleHost = presentationHost({ isViewVisible: () => true });
    await expect(
      visibleHost.emit('requestEnsureProgressView', {}),
    ).resolves.toBe(true);

    const executeCommand = vi
      .spyOn(vscode.commands, 'executeCommand')
      .mockRejectedValue(new Error('no view container'));
    try {
      const hiddenHost = presentationHost({ isViewVisible: () => false });
      await expect(
        hiddenHost.emit('requestEnsureProgressView', {}),
      ).resolves.toBe(false);
    } finally {
      executeCommand.mockRestore();
    }
  });

  it('reports progress-view non-delivery when the reveal settles without making the view visible', async () => {
    // The reveal command resolving is not delivery: nothing was presented if
    // the view remains hidden after it (#10468).
    const executeCommand = vi
      .spyOn(vscode.commands, 'executeCommand')
      .mockResolvedValue(undefined);
    try {
      const host = presentationHost({ isViewVisible: () => false });
      await expect(host.emit('requestEnsureProgressView', {})).resolves.toBe(
        false,
      );
      expect(executeCommand).toHaveBeenCalledWith('texra.showProgressView');
    } finally {
      executeCommand.mockRestore();
    }
  });

  it('reports the fallback notification as delivered when the view stays hidden', async () => {
    const executeCommand = vi
      .spyOn(vscode.commands, 'executeCommand')
      .mockResolvedValue(undefined);
    const showInformationMessage = vi
      .spyOn(vscode.window, 'showInformationMessage')
      .mockResolvedValue(undefined);
    try {
      const host = presentationHost({ isViewVisible: () => false });
      await expect(
        host.emit('requestEnsureProgressView', {
          fallbackNotification: {
            agentName: 'writer',
            modelName: 'test-model',
            inputName: 'paper.tex',
            outputInfo: 'to paper.out.tex',
          },
        }),
      ).resolves.toBe(true);
      expect(showInformationMessage).toHaveBeenCalledOnce();
    } finally {
      executeCommand.mockRestore();
      showInformationMessage.mockRestore();
    }
  });

  it('reports a rendered instruction as delivered once VS Code accepts it', async () => {
    const showInformationMessage = vi
      .spyOn(vscode.window, 'showInformationMessage')
      .mockResolvedValue(undefined);
    try {
      const host = presentationHost();
      await expect(
        host.emit('requestShowInstruction', {
          key: 'deliveryShownInstruction',
          message: 'Set your API key.',
          showSuppress: false,
        }),
      ).resolves.toBe(true);
      expect(showInformationMessage).toHaveBeenCalledOnce();
    } finally {
      showInformationMessage.mockRestore();
    }
  });

  it('treats a "never remind" suppressed instruction as delivered without rendering', async () => {
    // Suppression is a deliberate user opt-out, so it reports delivered: the
    // caller's generic fallback must not resurface the same notice through a
    // toast the user cannot suppress.
    const stateKey = `${INSTRUCTION_PREFIX}deliverySuppressedInstruction`;
    mocks.instructionMemento.set(stateKey, true);
    const showInformationMessage = vi.spyOn(
      vscode.window,
      'showInformationMessage',
    );
    try {
      const host = presentationHost();
      await expect(
        host.emit('requestShowInstruction', {
          key: 'deliverySuppressedInstruction',
          message: 'You should not see this.',
          showSuppress: true,
        }),
      ).resolves.toBe(true);
      expect(showInformationMessage).not.toHaveBeenCalled();
    } finally {
      mocks.instructionMemento.delete(stateKey);
      showInformationMessage.mockRestore();
    }
  });
});
