import { describe, expect, it } from 'vitest';

import { GlobalStateKey } from '@common/state/stateKeys';

import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

class MemoryStateStore {
  readonly values = new Map<string, unknown>();

  get<T>(key: string, defaultValue?: T): T {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.values.delete(key);
    } else {
      this.values.set(key, value);
    }
  }
}

class MemorySecrets {
  readonly values = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

interface DesktopCrashReportingModule {
  DESKTOP_CRASH_REPORTING_DSN_SECRET: string;
  getDesktopCrashReportingStatus(
    globalState: MemoryStateStore,
    secrets: MemorySecrets,
  ): Promise<{ enabled: boolean; configured: boolean }>;
  setDesktopCrashReportingDsn(
    secrets: MemorySecrets,
    dsn: string | undefined,
  ): Promise<void>;
  setDesktopCrashReportingEnabled(
    globalState: MemoryStateStore,
    enabled: boolean,
  ): Promise<void>;
  scrubDesktopCrashEvent(
    event: Record<string, unknown>,
    paths: readonly string[],
  ): Record<string, unknown> | null;
}

async function loadDesktopCrashReporting(): Promise<DesktopCrashReportingModule> {
  return import(
    moduleFileUrl(desktopSourcePath('main', 'desktopCrashReporting.ts'))
  ) as Promise<DesktopCrashReportingModule>;
}

describe('desktop crash reporting', () => {
  it('keeps crash reporting disabled and unconfigured by default', async () => {
    const { getDesktopCrashReportingStatus } =
      await loadDesktopCrashReporting();

    await expect(
      getDesktopCrashReportingStatus(
        new MemoryStateStore(),
        new MemorySecrets(),
      ),
    ).resolves.toEqual({ enabled: false, configured: false });
  });

  it('stores opt-in state and Sentry DSN separately', async () => {
    const {
      DESKTOP_CRASH_REPORTING_DSN_SECRET,
      getDesktopCrashReportingStatus,
      setDesktopCrashReportingDsn,
      setDesktopCrashReportingEnabled,
    } = await loadDesktopCrashReporting();
    const globalState = new MemoryStateStore();
    const secrets = new MemorySecrets();

    await setDesktopCrashReportingEnabled(globalState, true);
    await setDesktopCrashReportingDsn(secrets, ' https://example.invalid/1 ');

    expect(
      globalState.values.get(GlobalStateKey.DESKTOP_CRASH_REPORTING_ENABLED),
    ).toBe(true);
    expect(secrets.values.get(DESKTOP_CRASH_REPORTING_DSN_SECRET)).toBe(
      'https://example.invalid/1',
    );
    await expect(
      getDesktopCrashReportingStatus(globalState, secrets),
    ).resolves.toEqual({ enabled: true, configured: true });
  });

  it('drops non-native events for the v1 crash-reporting scope', async () => {
    const { scrubDesktopCrashEvent } = await loadDesktopCrashReporting();

    expect(scrubDesktopCrashEvent({ platform: 'javascript' }, [])).toBeNull();
  });

  it('scrubs workspace and app paths from native crash events', async () => {
    const { scrubDesktopCrashEvent } = await loadDesktopCrashReporting();

    const scrubbed = scrubDesktopCrashEvent(
      {
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
        },
      },
      ['/Users/alice/paper', 'C:\\Users\\Alice\\TeXRA\\workspace'],
    );

    expect(JSON.stringify(scrubbed)).toContain('<redacted-path>');
    expect(JSON.stringify(scrubbed)).not.toContain('/Users/alice/paper');
    expect(JSON.stringify(scrubbed)).not.toContain('C:\\\\Users\\\\Alice');
  });
});
