// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The tool-use persistence gate is extension-only: the desktop never honored
 * `texra.toolUse.persistence.enabled`, so the shared {@link resumeToolUseSnapshot}
 * leaf stays ungated and the gate lives in this adapter. These tests pin that
 * the gate is applied here (not in the shared leaf) and that an enabled adapter
 * delegates straight through.
 */
const mocks = vi.hoisted(() => ({
  getToolUsePersistenceEnabled: vi.fn(() => true),
  registerCommand: vi.fn(),
  resumeToolUseSnapshot: vi.fn(async () => true),
  showWarningMessage: vi.fn(),
}));

vi.mock('vscode', () => ({
  commands: {
    registerCommand: mocks.registerCommand,
  },
  window: {
    showWarningMessage: mocks.showWarningMessage,
  },
}));
vi.mock('@utils/config', async (importActual) => ({
  ...(await importActual<typeof import('@utils/config')>()),
  getToolUsePersistenceEnabled: mocks.getToolUsePersistenceEnabled,
}));
vi.mock('@agent/runtime/resumeToolUseSnapshot', () => ({
  resumeToolUseSnapshot: mocks.resumeToolUseSnapshot,
}));

import type { ToolUseSessionSnapshot } from '@agent/implementations/flows/tooluse/ToolUseSessionTypes';
import {
  registerResumeAgentCommand,
  resumeExtensionToolUseSnapshot,
} from '@commands/agent/resumeCommand';
import type { StreamTabId } from '@shared/schemas';

const STREAM = 'stream:ext-resume' as StreamTabId;

function snapshot(): ToolUseSessionSnapshot {
  return { streamId: STREAM } as ToolUseSessionSnapshot;
}

describe('resumeExtensionToolUseSnapshot', () => {
  beforeEach(() => {
    mocks.getToolUsePersistenceEnabled.mockReturnValue(true);
    mocks.registerCommand.mockReset();
    mocks.resumeToolUseSnapshot.mockReset();
    mocks.resumeToolUseSnapshot.mockResolvedValue(true);
    mocks.showWarningMessage.mockReset();
  });

  it('refuses to resume when tool-use persistence is disabled', async () => {
    mocks.getToolUsePersistenceEnabled.mockReturnValue(false);

    await expect(resumeExtensionToolUseSnapshot(snapshot())).resolves.toBe(
      false,
    );
    expect(mocks.resumeToolUseSnapshot).not.toHaveBeenCalled();
  });

  it('delegates to the shared leaf with the explicit follow-up when enabled', async () => {
    await expect(
      resumeExtensionToolUseSnapshot(snapshot(), 'typed alongside resume'),
    ).resolves.toBe(true);

    expect(mocks.resumeToolUseSnapshot).toHaveBeenCalledTimes(1);
    expect(mocks.resumeToolUseSnapshot).toHaveBeenCalledWith(
      snapshot(),
      expect.objectContaining({
        explicitFollowUp: 'typed alongside resume',
      }),
    );
  });
});

describe('registerResumeAgentCommand', () => {
  beforeEach(() => {
    mocks.registerCommand.mockReset();
  });

  it('stores the command disposable on the extension context', () => {
    const disposable = { dispose: vi.fn() };
    mocks.registerCommand.mockReturnValue(disposable);
    const context = { subscriptions: [] as unknown[] };

    registerResumeAgentCommand(
      context as Parameters<typeof registerResumeAgentCommand>[0],
    );

    expect(mocks.registerCommand).toHaveBeenCalledExactlyOnceWith(
      'texra.resumeAgent',
      expect.any(Function),
    );
    expect(context.subscriptions).toEqual([disposable]);
  });
});
