import { beforeAll, describe, expect, it } from 'vitest';

import { loadSourceModule } from './loadSourceModule.ts';

type ScrubDesktopCrashEvent =
  (typeof import('@desktop/main/desktopCrashReporting'))['scrubDesktopCrashEvent'];

describe('desktop crash reporting', () => {
  let scrubDesktopCrashEvent: ScrubDesktopCrashEvent;

  beforeAll(async () => {
    ({ scrubDesktopCrashEvent } = await loadSourceModule(
      '@desktop/main/desktopCrashReporting',
    ));
  });

  it('drops non-native events for the v1 crash-reporting scope', () => {
    expect(
      scrubDesktopCrashEvent({ type: undefined, platform: 'javascript' }, []),
    ).toBeNull();
  });

  it('scrubs workspace and app paths from native crash events', () => {
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

    const serialized = JSON.stringify(scrubbed);
    expect(serialized).toContain('<redacted-path>');
    expect(serialized).not.toContain('/Users/alice/paper');
    expect(serialized).not.toContain('C:\\\\Users\\\\Alice');
    expect(Object.keys(scrubbed?.extra as Record<string, unknown>)).toContain(
      '<redacted-path>/output.pdf',
    );
  });
});
