import { describe, expect, it } from 'vitest';

import { loadSourceModule } from './loadSourceModule.mjs';

describe('desktop crash reporting', () => {
  it('drops non-native events for the v1 crash-reporting scope', async () => {
    const { scrubDesktopCrashEvent } = await loadSourceModule(
      '@desktop/main/desktopCrashReporting',
    );

    expect(
      scrubDesktopCrashEvent({ type: undefined, platform: 'javascript' }, []),
    ).toBeNull();
  });

  it('scrubs workspace and app paths from native crash events', async () => {
    const { scrubDesktopCrashEvent } = await loadSourceModule(
      '@desktop/main/desktopCrashReporting',
    );

    const scrubbed = scrubDesktopCrashEvent(
      {
        type: undefined,
        platform: 'native',
        message: 'Crash in /Users/alice/paper/main.tex',
        exception: {
          values: [
            {
              stacktrace: {
                frames: [
                  { filename: 'C:\\Users\\Alice\\TeXRA\\workspace\\agent.ts' },
                ],
              },
            },
          ],
        },
        extra: {
          cwd: '/Users/alice/paper',
          log: 'C:\\Users\\Alice\\TeXRA\\workspace\\logs\\main.log',
          '/Users/alice/paper/output.pdf': 'build output',
        },
      },
      ['/Users/alice/paper', 'C:\\Users\\Alice\\TeXRA\\workspace'],
    );

    expect(JSON.stringify(scrubbed)).toContain('<redacted-path>');
    expect(JSON.stringify(scrubbed)).not.toContain('/Users/alice/paper');
    expect(JSON.stringify(scrubbed)).not.toContain('C:\\\\Users\\\\Alice');
    expect(Object.keys(scrubbed?.extra as Record<string, unknown>)).toContain(
      '<redacted-path>/output.pdf',
    );
  });
});
