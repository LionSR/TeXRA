// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resumeStream: vi.fn(),
}));

vi.mock('@agent/runtime/resumeRun', () => ({
  resumeStream: mocks.resumeStream,
}));
vi.mock('@commands/agent/executeCommand', () => ({
  runExecuteCommand: vi.fn(),
}));

import type { ResumeRunOptions } from '@agent/runtime/resumeRun';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { tryResumeFromResumeData } from '@commands/agent/resumeFromResumeData';
import type { ExecutionId, StreamTabId } from '@shared/schemas';

const STREAM = 'stream:ext-resume-ports' as StreamTabId;
const EXECUTION = 'exec:ext-resume' as ExecutionId;

async function captureOptions(): Promise<ResumeRunOptions> {
  await tryResumeFromResumeData(STREAM);
  const options = mocks.resumeStream.mock.calls[0]?.[1];
  expect(options).toBeDefined();
  return options as ResumeRunOptions;
}

describe('tryResumeFromResumeData', () => {
  beforeEach(() => {
    mocks.resumeStream
      .mockReset()
      .mockResolvedValue({ started: true, delivered: true });
  });

  it('reports cancellation once the stream transcript is gone', async () => {
    const options = await captureOptions();

    expect(options.isCancellationRequested?.()).toBe(true);
  });

  it('keeps resuming while the stream transcript is present', async () => {
    const session = defaultSession();
    const has = vi.spyOn(session.transcripts, 'has').mockReturnValue(true);

    const options = await captureOptions();

    expect(options.isCancellationRequested?.()).toBe(false);
    has.mockRestore();
  });

  it('words a refusal with the shared follow-up failure vocabulary', async () => {
    const session = defaultSession();
    const has = vi.spyOn(session.transcripts, 'has').mockReturnValue(true);
    const emit = vi.spyOn(session.interactions, 'emit').mockReturnValue(false);
    mocks.resumeStream.mockResolvedValueOnce({ failed: 'finished' });

    await expect(tryResumeFromResumeData(STREAM)).resolves.toBe(false);

    expect(emit).toHaveBeenCalledWith(
      'requestShowInstruction',
      {
        key: 'resumeRefused',
        message: 'This run has finished. Start a new agent task to continue.',
        showSuppress: false,
      },
      { replayWhenAttached: true },
    );
    emit.mockRestore();
    has.mockRestore();
  });
});
