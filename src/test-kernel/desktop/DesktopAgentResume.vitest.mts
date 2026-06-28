// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports - desktop
import type { StreamTabId } from '@shared/schemas';

import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mts';

interface DesktopAgentResumeModule {
  setDesktopAgentResumeHandler(handler: {
    tryResumeStream(streamId: StreamTabId): Promise<boolean>;
    isResumeInFlight(streamId: StreamTabId): boolean;
  }): () => void;
  tryResumeDesktopStream(streamId: StreamTabId): Promise<boolean>;
  isDesktopResumeInFlight(streamId: StreamTabId): boolean;
}

async function loadDesktopAgentResume(): Promise<DesktopAgentResumeModule> {
  vi.resetModules();
  return import(
    moduleFileUrl(desktopSourcePath('main', 'desktopAgentResume.ts'))
  ) as Promise<DesktopAgentResumeModule>;
}

describe('desktop agent resume registry', () => {
  it('tries each registered desktop window instead of letting the last one win', async () => {
    const resume = await loadDesktopAgentResume();
    const first = {
      tryResumeStream: vi.fn(async (streamId: StreamTabId) => {
        return streamId === 'stream-a';
      }),
      isResumeInFlight: vi.fn((streamId: StreamTabId) => {
        return streamId === 'stream-a';
      }),
    };
    const second = {
      tryResumeStream: vi.fn(async (streamId: StreamTabId) => {
        return streamId === 'stream-b';
      }),
      isResumeInFlight: vi.fn((streamId: StreamTabId) => {
        return streamId === 'stream-b';
      }),
    };
    const disposeFirst = resume.setDesktopAgentResumeHandler(first);
    const disposeSecond = resume.setDesktopAgentResumeHandler(second);

    await expect(resume.tryResumeDesktopStream('stream-a')).resolves.toBe(true);
    expect(second.tryResumeStream).toHaveBeenCalledWith('stream-a');
    expect(first.tryResumeStream).toHaveBeenCalledWith('stream-a');
    await expect(resume.tryResumeDesktopStream('stream-b')).resolves.toBe(true);
    await expect(resume.tryResumeDesktopStream('missing')).resolves.toBe(false);
    expect(resume.isDesktopResumeInFlight('stream-a')).toBe(true);
    expect(resume.isDesktopResumeInFlight('stream-b')).toBe(true);

    disposeSecond();
    await expect(resume.tryResumeDesktopStream('stream-a')).resolves.toBe(true);
    expect(resume.isDesktopResumeInFlight('stream-b')).toBe(false);

    disposeFirst();
    await expect(resume.tryResumeDesktopStream('stream-a')).resolves.toBe(
      false,
    );
  });
});
