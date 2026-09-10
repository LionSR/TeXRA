import { Effect } from 'effect';
// Test composition imports
import '@test/support/defaultSessionTestSetup';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resumeRunWithRefusalNotice: vi.fn(),
}));

vi.mock('@controllers/session/resumeRunPresentation', () => ({
  resumeRunWithRefusalNotice: mocks.resumeRunWithRefusalNotice,
}));
vi.mock('@commands/agent/executeCommand', () => ({
  runExecuteCommand: vi.fn(),
}));

import type { ResumeRunOptions } from '@agent/runtime/resumeRun';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { tryResumeFromResumeData } from '@commands/agent/resumeFromResumeData';
import type { RunId } from '@shared/schemas';

const RUN = 'ab12cd' as RunId;

async function captureOptions(): Promise<ResumeRunOptions> {
  await tryResumeFromResumeData(RUN);
  const options = mocks.resumeRunWithRefusalNotice.mock.calls[0]?.[1];
  expect(options).toBeDefined();
  return options as ResumeRunOptions;
}

describe('tryResumeFromResumeData', () => {
  beforeEach(() => {
    mocks.resumeRunWithRefusalNotice
      .mockReset()
      .mockReturnValue(Effect.succeed(true));
  });

  it('reports cancellation once the run transcript is gone', async () => {
    const options = await captureOptions();

    expect(options.isCancellationRequested?.()).toBe(true);
  });

  it('keeps resuming while the run transcript is present', async () => {
    const session = defaultSession();
    const has = vi.spyOn(session.transcripts, 'has').mockReturnValue(true);

    const options = await captureOptions();

    expect(options.isCancellationRequested?.()).toBe(false);
    has.mockRestore();
  });
});
