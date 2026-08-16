// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const mocks = vi.hoisted(() => ({
  resolveAndResumeStream: vi.fn(
    async (_streamId: string, _ports: unknown, _recovery?: unknown) => true,
  ),
}));

vi.mock('@agent/runtime/resolveAndResumeStream', async (importActual) => ({
  ...(await importActual<
    typeof import('@agent/runtime/resolveAndResumeStream')
  >()),
  resolveAndResumeStream: mocks.resolveAndResumeStream,
}));
vi.mock('@commands/agent/executeCommand', () => ({
  runExecuteCommand: vi.fn(),
}));

import type { ResumeStreamPorts } from '@agent/runtime/resolveAndResumeStream';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { tryResumeFromResumeData } from '@commands/agent/resumeFromResumeData';
import type { StreamTabId } from '@shared/schemas';

const STREAM = 'stream:ext-resume-ports' as StreamTabId;

async function capturePorts(): Promise<ResumeStreamPorts> {
  await tryResumeFromResumeData(STREAM);
  const ports = mocks.resolveAndResumeStream.mock.calls[0]?.[1];
  expect(ports).toBeDefined();
  return ports as ResumeStreamPorts;
}

describe('tryResumeFromResumeData ports', () => {
  beforeEach(() => {
    mocks.resolveAndResumeStream.mockClear();
  });

  it('reports cancellation once the stream transcript is gone', async () => {
    const ports = await capturePorts();

    expect(ports.isCancellationRequested?.()).toBe(true);
  });

  it('keeps resuming while the stream transcript is present', async () => {
    const session = defaultSession();
    const has = vi.spyOn(session.transcripts, 'has').mockReturnValue(true);

    const ports = await capturePorts();

    expect(ports.isCancellationRequested?.()).toBe(false);
    has.mockRestore();
  });

  it('presents a pre-lifecycle workflow failure through the guarded warning', async () => {
    const showWarningMessage = vi
      .spyOn(vscode.window, 'showWarningMessage')
      .mockResolvedValue(undefined);
    const error = new Error('workflow bootstrap failed');

    const ports = await capturePorts();
    await ports.reportFailure?.(STREAM, error);

    expect(showWarningMessage).toHaveBeenCalledWith(
      'Resume failed: workflow bootstrap failed',
    );
    showWarningMessage.mockRestore();
  });

  it('tells the user when there is no resumable session state', async () => {
    const session = defaultSession();
    const showInfoMessage = vi
      .spyOn(session.interactions, 'showInfoMessage')
      .mockReturnValue(undefined);

    const ports = await capturePorts();
    await ports.reportNoResumableSession?.(STREAM);

    expect(showInfoMessage).toHaveBeenCalledWith(
      'This run cannot be resumed. Start a new run instead.',
      { replayWhenAttached: true },
    );
    showInfoMessage.mockRestore();
  });
});
